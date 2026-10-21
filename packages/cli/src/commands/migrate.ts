import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import { betterAuthWarning } from "../better-auth-version.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { MIGRATE_HELP } from "../help/migrate.js";
import type { MigrateJson } from "../json.js";
import { type Ctx, describeUrl, printJson, sayer } from "../output.js";
import { gate, readableVersion, readD1Version, stem } from "../schema-version.js";
import {
  adapterD1Dir,
  applyD1,
  compatD1Dir,
  type D1Project,
  type D1Target,
  findWranglerConfig,
  readD1CompatText,
  readD1Project,
  wranglerOf,
} from "../seams/d1.js";
import { MYSQL_CORE_MIGRATIONS, openMysql } from "../seams/mysql.js";
import {
  COMPAT_META_KEY,
  CORE_MIGRATIONS,
  compatMigrationNames,
  openPostgres,
  storageFailure,
} from "../seams/postgres.js";
import { openSqlite, SQLITE_CORE_MIGRATIONS, type SqliteSource } from "../seams/sqlite.js";
import { DEFAULT_LIBSQL_TOKEN_ENV, DEFAULT_URL_ENV, readSecret } from "../secrets.js";
import { SCHEMA_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  target: { type: "string" },
  tables: { type: "string" },
  "url-env": { type: "string" },
  "url-file": { type: "string" },
  file: { type: "string" },
  "auth-token-env": { type: "string" },
  "auth-token-file": { type: "string" },
  database: { type: "string" },
  config: { type: "string" },
  remote: { type: "boolean" },
  "before-1.7": { type: "boolean" },
  "dry-run": { type: "boolean", short: "n" },
} as const;

const parse = (argv: string[]) =>
  parseOrUsage(
    () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(OPTIONS),
  );
type Values = ReturnType<typeof parse>["values"];

/** What a target answers: the versions before and after, the pending and the applied names, and the copied files. */
export interface MigrateRun {
  before: number | null;
  after: number | null;
  pending: string[];
  applied: string[];
  copied: string[];
}

/** The plan of one run. `note` writes a boundary line on stderr. */
export interface MigratePlan {
  tables: "core" | "compat";
  dryRun: boolean;
  note(line: string): void;
}

/** The flags of a database that is read by a URL or a file (plan 12g Task 6); `check` has them too. */
export interface DatabaseValues {
  "url-env"?: string | undefined;
  "url-file"?: string | undefined;
  file?: string | undefined;
  "auth-token-env"?: string | undefined;
  "auth-token-file"?: string | undefined;
}

/** The connection string of `--url-env` or `--url-file` (spec 19 item 5). */
export const readUrl = (ctx: Ctx, v: DatabaseValues): string =>
  readSecret(ctx, {
    envFlag: "url-env",
    fileFlag: "url-file",
    env: v["url-env"],
    file: v["url-file"],
    defaultEnv: DEFAULT_URL_ENV,
    what: "the connection string",
  });

async function migratePostgres(ctx: Ctx, v: Values, plan: MigratePlan): Promise<MigrateRun> {
  const url = readUrl(ctx, v);
  plan.note(`connecting to ${describeUrl(url)}`);
  // One connection: the migrations run one at a time, each in its own transaction.
  const pg = openPostgres(url, 1);
  try {
    // A refused connection stops here, as "storage: ...; nothing was written", the same as import.
    try {
      await pg.ping();
    } catch (e) {
      throw new Stop(`${storageFailure(e, url)}; nothing was written`);
    }
    const done = new Set(await pg.appliedCore());
    const before = readableVersion(await pg.schemaVersionText(), done.size);
    gate(before);
    const pending =
      plan.tables === "core"
        ? CORE_MIGRATIONS.filter((n) => !done.has(n))
        : compatMigrationNames().slice(await pg.compatVersion());
    if (plan.dryRun) return { before, after: before, pending, applied: [], copied: [] };
    plan.note(`applying ${pending.length} migration(s)`);
    const applied = plan.tables === "core" ? await pg.applyCore() : await pg.applyCompat();
    return { before, after: await pg.schemaVersion(), pending, applied, copied: [] };
  } finally {
    await pg.close();
  }
}

/** The members of a seam that the core run of `migrateCore` calls. */
interface CoreSeam {
  ping(): Promise<void>;
  appliedCore(): Promise<string[]>;
  schemaVersionText(): Promise<string | null>;
  schemaVersion(): Promise<number | null>;
  applyCore(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * The core run on a seam of SQLite or MySQL, in the order of spec 19 item 8.
 * It reads, gates, lists, applies through the adapter's own runner, and
 * reads again. `names` are the migrations of the adapter that this CLI
 * bundles.
 */
async function migrateCore(
  seam: CoreSeam,
  names: readonly string[],
  plan: MigratePlan,
): Promise<MigrateRun> {
  try {
    try {
      await seam.ping();
    } catch (e) {
      throw e instanceof Stop ? new Stop(`${e.message}; nothing was written`) : e;
    }
    const done = new Set(await seam.appliedCore());
    const before = readableVersion(await seam.schemaVersionText(), done.size);
    gate(before);
    const pending = names.filter((n) => !done.has(n));
    if (plan.dryRun) return { before, after: before, pending, applied: [], copied: [] };
    plan.note(`applying ${pending.length} migration(s)`);
    const applied = await seam.applyCore();
    return { before, after: await seam.schemaVersion(), pending, applied, copied: [] };
  } finally {
    await seam.close();
  }
}

/**
 * The libSQL token: `--auth-token-env`, `--auth-token-file`, or the variable
 * LIBSQL_AUTH_TOKEN. It is optional, so a missing default variable gives no
 * token. A local libSQL server takes none.
 */
function readAuthToken(ctx: Ctx, v: DatabaseValues): string | null {
  const env = v["auth-token-env"];
  const file = v["auth-token-file"];
  if (env === undefined && file === undefined && !ctx.env[DEFAULT_LIBSQL_TOKEN_ENV]) return null;
  return readSecret(ctx, {
    envFlag: "auth-token-env",
    fileFlag: "auth-token-file",
    env,
    file,
    defaultEnv: DEFAULT_LIBSQL_TOKEN_ENV,
    what: "the libSQL token",
  });
}

/**
 * The database of `--target sqlite`: `--file`, or a libSQL URL from
 * `--url-env` or `--url-file`. One of them, never two. The token flags apply
 * to a URL. A path is not a secret, so its note names it.
 */
export function sqliteSourceOf(ctx: Ctx, v: DatabaseValues): SqliteSource {
  const given = (["file", "url-env", "url-file"] as const).filter((f) => v[f] !== undefined);
  if (given.length > 1) throw new UsageError("give --file or --url-env or --url-file, not two");
  if (v.file !== undefined) {
    for (const flag of ["auth-token-env", "auth-token-file"] as const)
      if (v[flag] !== undefined)
        throw new UsageError(`--${flag} applies to a libSQL URL, not to --file`);
    return { file: resolve(ctx.cwd, v.file) };
  }
  if (given.length === 0)
    throw new UsageError(
      "name the database: --file <path> for a SQLite file, or --url-env <NAME> or --url-file <path> for a libSQL server",
    );
  return { url: readUrl(ctx, v), authToken: readAuthToken(ctx, v) };
}

async function migrateSqlite(ctx: Ctx, v: Values, plan: MigratePlan): Promise<MigrateRun> {
  const source = sqliteSourceOf(ctx, v);
  const seam = await openSqlite(source, (s) => ctx.addSecret(s));
  plan.note(`${"file" in source ? "opening" : "connecting to"} ${seam.where}`);
  return migrateCore(seam, SQLITE_CORE_MIGRATIONS, plan);
}

async function migrateMysql(ctx: Ctx, v: Values, plan: MigratePlan): Promise<MigrateRun> {
  const url = readUrl(ctx, v);
  const seam = openMysql(url, (s) => ctx.addSecret(s));
  plan.note(`connecting to ${describeUrl(url)}`);
  return migrateCore(seam, MYSQL_CORE_MIGRATIONS, plan);
}

/**
 * The core target on D1: the binding's migrations_dir must hold every file
 * of the adapter with the same text. Another folder would make wrangler
 * apply the wrong files and report success (spec 19).
 */
function checkAdapterFiles(ctx: Ctx, dir: string): void {
  const source = adapterD1Dir();
  const want = ctx
    .listDir(source)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const missing = want.filter((f) => {
    const path = join(dir, f);
    return !ctx.exists(path) || ctx.readFile(path) !== ctx.readFile(join(source, f));
  });
  if (missing.length > 0)
    throw new Stop(
      `migrations_dir ${dir} lacks the adapter's files ${missing.join(", ")} of ${source}; point migrations_dir at node_modules/@authtempo/adapter-d1/migrations`,
    );
}

/**
 * The guard of the compat copy (review of plan 11c, M2): the copy writes into
 * migrations_dir, so that folder must be the app's own. The default of a core
 * D1 app is the adapter's folder; in a workspace it links to the shipped
 * migrations of @authtempo/adapter-d1, and each app that links the adapter
 * would apply the compat SQL. A folder inside a package, or under
 * node_modules, stops the run before the first read of the database.
 */
function checkCompatDir(ctx: Ctx, dir: string): void {
  if (!ctx.exists(dir)) return; // copyCompat names the missing folder.
  const real = ctx.realpath(dir);
  const adapter = ctx.realpath(adapterD1Dir());
  if (real === adapter)
    throw new Stop(
      `migrations_dir ${dir} is the folder of @authtempo/adapter-d1; with --tables compat, point migrations_dir at a folder of the app`,
    );
  const packages = [dirname(adapter), dirname(dirname(ctx.realpath(compatD1Dir(false))))];
  const inside = (root: string) => real === root || real.startsWith(`${root}${sep}`);
  if (packages.some(inside) || [dir, real].some((p) => p.split(sep).includes("node_modules")))
    throw new Stop(
      `migrations_dir ${dir} is a folder of a package; with --tables compat, point migrations_dir at a folder of the app`,
    );
}

/**
 * The compat mapping version of a D1 database from the text of its row: 0
 * when the row is missing. A value that is not a whole number stops the
 * run before any write, as `readableVersion` stops on such a schema_version.
 */
function compatVersionOf(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw))
    throw new Stop(
      `ta_meta holds ${COMPAT_META_KEY} ${JSON.stringify(raw)}, which is not a version number; nothing was written`,
    );
  return Number(raw);
}

/**
 * The plan of the compat copy on D1 (spec 16, the D1 step of the compat
 * README; spec 23 item 11). Each compat file goes into the app's
 * migrations_dir under the app's next number. The plan is complete before
 * the first write. Compat file n is the n-th file of the package's folder.
 * The database decides: a file at or below `compatVersion` is applied
 * already. It is not copied, and the app's files are not read for it, also
 * when the app renamed its copies. For each other file, the app's folder is
 * read by the stem, the name without the number and `.sql`. Two files with
 * the stem stop the run. One file with the same text is a copy that is not
 * applied yet. One file with another text stops the run. A file of another
 * name with the same text is the same migration (the rule of plan 11c,
 * kept). Else the file is copied. A compat file is a record of the package
 * (append-only). An edited copy is a second migration with the same name.
 * wrangler would apply it again, or fail on it at a worse moment (plan 11c
 * deferral, closed by spec 23 item 11). An app with other table names
 * writes its own compat files and applies them with wrangler first. Then the
 * compat version is the count of the package's files (10 since plan 12k), and
 * this plan copies nothing (the final review of plan 11f, m1).
 */
export function planCompatCopy(
  ctx: Ctx,
  dir: string,
  before17: boolean,
  compatVersion: number,
): { name: string; text: string }[] {
  if (!ctx.exists(dir))
    throw new Stop(
      `migrations_dir ${dir} does not exist; with --tables compat it holds the Better Auth table migration of the app`,
    );
  const source = compatD1Dir(before17);
  const present = ctx
    .listDir(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const textOf = new Map(present.map((f) => [f, ctx.readFile(join(dir, f))]));
  let next = present.reduce((n, f) => Math.max(n, Number(/^(\d+)_/.exec(f)?.[1] ?? "0")), 0);
  const copies: { name: string; text: string }[] = [];
  const files = ctx
    .listDir(source)
    .filter((x) => x.endsWith(".sql"))
    .sort();
  for (const [i, f] of files.entries()) {
    if (i + 1 <= compatVersion) continue;
    const text = ctx.readFile(join(source, f));
    const s = stem(f);
    const named = present.filter((p) => stem(p) === s);
    if (named.length > 1)
      throw new Stop(
        `migrations_dir ${dir} holds ${named.join(" and ")} for the compat file ${f}; keep one`,
      );
    const [own] = named;
    if (own !== undefined) {
      if (textOf.get(own) === text) continue;
      throw new Stop(
        `${join(dir, own)} differs from the compat file ${f}; restore its text, and put the app's change in a new migration; on tables with other names, apply the app's own compat files with wrangler d1 migrations apply first; nothing was written`,
      );
    }
    if ([...textOf.values()].includes(text)) continue;
    next += 1;
    copies.push({ name: `${String(next).padStart(4, "0")}_${s}.sql`, text });
  }
  return copies;
}

/** The D1 target. `run` reads `project` once: the warning needs its folder before the target runs. */
async function migrateD1(
  ctx: Ctx,
  v: Values,
  plan: MigratePlan,
  project: D1Project,
): Promise<MigrateRun> {
  if (!ctx.exists(wranglerOf(project.cwd)))
    throw new Stop(
      `no wrangler in ${join(project.cwd, "node_modules")}: install the packages of the project first`,
    );
  const t: D1Target = { ...project, remote: v.remote === true };
  if (plan.tables === "core") checkAdapterFiles(ctx, project.migrationsDir);
  else checkCompatDir(ctx, project.migrationsDir);
  plan.note(`reading the ${t.remote ? "remote" : "local"} D1 database ${t.database}`);
  const { version: before, applied: appliedBefore } = await readD1Version(ctx, t);
  gate(before);
  // After the gate: the plan is complete before the copy, the first write of a compat run.
  const copies =
    plan.tables === "compat"
      ? planCompatCopy(
          ctx,
          project.migrationsDir,
          v["before-1.7"] === true,
          compatVersionOf(await readD1CompatText(ctx, t)),
        )
      : [];
  if (!plan.dryRun)
    for (const c of copies) ctx.writeNew(join(project.migrationsDir, c.name), c.text);
  const copied = copies.map((c) => c.name.slice(0, -".sql".length));
  const done = new Set(appliedBefore);
  const files = ctx
    .listDir(project.migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -".sql".length));
  const pending = [...new Set([...files, ...copied])].filter((n) => !done.has(n)).sort();
  if (plan.dryRun) return { before, after: before, pending, applied: [], copied };
  plan.note(
    `running wrangler d1 migrations apply ${t.database} ${t.remote ? "--remote" : "--local"}`,
  );
  await applyD1(ctx, t);
  const { version: after, applied: appliedAfter } = await readD1Version(ctx, t);
  const now = new Set(appliedAfter);
  return { before, after, pending, applied: pending.filter((n) => now.has(n)), copied };
}

/** The targets of `--target`. */
const TARGETS = ["d1", "postgres", "sqlite", "mysql"] as const;

/** The flags of each kind of database (plan 12g Task 6). */
const D1_ONLY = ["database", "config", "remote"] as const;
const URL_FLAGS = ["url-env", "url-file"] as const;
const SQLITE_ONLY = ["file", "auth-token-env", "auth-token-file"] as const;

/** `authtempo migrate --target <...>` (spec 19): the version gate, the list, the apply, and the gate again. */
export const migrateCommand: Command = {
  help: MIGRATE_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values, positionals } = parse(argv);
    if (positionals.length > 0)
      throw new UsageError(`migrate takes no argument; got ${positionals[0]}`);
    const target = oneOf("target", values.target, TARGETS);
    if (target === undefined)
      throw new UsageError(`name a target: --target ${TARGETS.join(" or --target ")}`);
    const tables = oneOf("tables", values.tables, ["core", "compat"] as const) ?? "core";
    if (target !== "d1")
      for (const flag of D1_ONLY)
        if (values[flag] !== undefined) throw new UsageError(`--${flag} applies to --target d1`);
    if (target === "d1")
      for (const flag of URL_FLAGS)
        if (values[flag] !== undefined)
          throw new UsageError(`--${flag} applies to --target postgres, mysql, or sqlite`);
    if (target !== "sqlite")
      for (const flag of SQLITE_ONLY)
        if (values[flag] !== undefined)
          throw new UsageError(`--${flag} applies to --target sqlite`);
    if (values["before-1.7"] === true && target !== "d1" && target !== "sqlite")
      throw new UsageError("--before-1.7 applies to --target d1 or sqlite");
    if (values["before-1.7"] === true && tables !== "compat")
      throw new UsageError("--before-1.7 applies to --tables compat");
    // Owner decision 4 of plan 12g: the compat tables run on SQLite, never on MySQL.
    if (tables === "compat" && target === "mysql")
      throw new UsageError("--tables compat is not served on mysql (plan 12g, owner decision 4)");
    if (tables === "compat" && target === "sqlite")
      throw new UsageError("--tables compat is not served on sqlite yet (plan 12g Task 8b)");
    const dryRun = values["dry-run"] === true;
    const json = values.json === true;
    const say = sayer(ctx, json);
    const project =
      target === "d1"
        ? readD1Project(ctx, findWranglerConfig(ctx, values.config), values.database)
        : null;
    if (tables === "compat") {
      // Spec 23 item 12: one warning line on stderr before the target runs. The run goes on.
      const w = betterAuthWarning(ctx, project === null ? ctx.cwd : project.cwd);
      if (w !== null) ctx.err(w);
    }
    const plan: MigratePlan = { tables, dryRun, note: (line) => ctx.err(line) };
    const run =
      project !== null
        ? await migrateD1(ctx, values, plan, project)
        : target === "sqlite"
          ? await migrateSqlite(ctx, values, plan)
          : target === "mysql"
            ? await migrateMysql(ctx, values, plan)
            : await migratePostgres(ctx, values, plan);
    for (const name of run.copied) say(`${dryRun ? "would copy" : "copied"} ${name}`);
    for (const name of dryRun ? run.pending : run.applied)
      say(`${dryRun ? "would apply" : "applied"} ${name}`);
    say(`version before: ${run.before ?? "none"}; version after: ${run.after ?? "none"}`);
    // The gate again: a run that ends away from this CLI's version did not do its work.
    if (!dryRun && run.after !== SCHEMA_VERSION)
      throw new Stop(
        `the database is at version ${run.after ?? "none"} after the run; this CLI expects version ${SCHEMA_VERSION}`,
      );
    if (json)
      printJson(ctx, {
        target,
        tables,
        dryRun,
        before: run.before,
        after: run.after,
        pending: run.pending,
        applied: run.applied,
        copied: run.copied,
        exit: 0,
        stopped: null,
      } satisfies MigrateJson);
    return 0;
  },
};
