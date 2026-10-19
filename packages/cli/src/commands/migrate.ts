import { dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { MIGRATE_HELP } from "../help/migrate.js";
import type { MigrateJson } from "../json.js";
import { type Ctx, describeUrl, printJson, sayer } from "../output.js";
import { gate, readableVersion, readD1Version } from "../schema-version.js";
import {
  adapterD1Dir,
  applyD1,
  compatD1Dir,
  type D1Target,
  findWranglerConfig,
  readD1Project,
  wranglerOf,
} from "../seams/d1.js";
import {
  CORE_MIGRATIONS,
  compatMigrationNames,
  openPostgres,
  storageFailure,
} from "../seams/postgres.js";
import { DEFAULT_URL_ENV, readSecret } from "../secrets.js";
import { SCHEMA_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  target: { type: "string" },
  tables: { type: "string" },
  "url-env": { type: "string" },
  "url-file": { type: "string" },
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

async function migratePostgres(ctx: Ctx, v: Values, plan: MigratePlan): Promise<MigrateRun> {
  const url = readSecret(ctx, {
    envFlag: "url-env",
    fileFlag: "url-file",
    env: v["url-env"],
    file: v["url-file"],
    defaultEnv: DEFAULT_URL_ENV,
    what: "the connection string",
  });
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
 * The compat target on D1 (spec 16, the D1 step of the compat README): each
 * compat file goes into the app's migrations_dir under the app's next
 * number. A file whose text the folder holds already is the same migration,
 * so a second run copies nothing. A dry run names the copies and writes none.
 */
function copyCompat(ctx: Ctx, dir: string, before17: boolean, dryRun: boolean): string[] {
  if (!ctx.exists(dir))
    throw new Stop(
      `migrations_dir ${dir} does not exist; with --tables compat it holds the Better Auth table migration of the app`,
    );
  const source = compatD1Dir(before17);
  const present = ctx
    .listDir(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const texts = new Set(present.map((f) => ctx.readFile(join(dir, f))));
  let next = present.reduce((n, f) => Math.max(n, Number(/^(\d+)_/.exec(f)?.[1] ?? "0")), 0);
  const copied: string[] = [];
  for (const f of ctx
    .listDir(source)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const text = ctx.readFile(join(source, f));
    if (texts.has(text)) continue;
    next += 1;
    const name = `${String(next).padStart(4, "0")}_${f.replace(/^\d+_/, "")}`;
    if (!dryRun) ctx.writeNew(join(dir, name), text);
    copied.push(name.slice(0, -".sql".length));
  }
  return copied;
}

async function migrateD1(ctx: Ctx, v: Values, plan: MigratePlan): Promise<MigrateRun> {
  const project = readD1Project(ctx, findWranglerConfig(ctx, v.config), v.database);
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
  // After the gate: the copy is the first write of a compat run.
  const copied =
    plan.tables === "compat"
      ? copyCompat(ctx, project.migrationsDir, v["before-1.7"] === true, plan.dryRun)
      : [];
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
const TARGETS = { d1: migrateD1, postgres: migratePostgres } as const;
type TargetName = keyof typeof TARGETS;

/** `authtempo migrate --target <...>` (spec 19): the version gate, the list, the apply, and the gate again. */
export const migrateCommand: Command = {
  help: MIGRATE_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values, positionals } = parse(argv);
    if (positionals.length > 0)
      throw new UsageError(`migrate takes no argument; got ${positionals[0]}`);
    const names = Object.keys(TARGETS) as TargetName[];
    const target = oneOf("target", values.target, names);
    if (target === undefined)
      throw new UsageError(`name a target: --target ${names.join(" or --target ")}`);
    const tables = oneOf("tables", values.tables, ["core", "compat"] as const) ?? "core";
    if (target === "postgres")
      for (const flag of ["database", "config", "remote", "before-1.7"] as const)
        if (values[flag] !== undefined) throw new UsageError(`--${flag} applies to --target d1`);
    if (target === "d1")
      for (const flag of ["url-env", "url-file"] as const)
        if (values[flag] !== undefined)
          throw new UsageError(`--${flag} applies to --target postgres`);
    if (values["before-1.7"] === true && tables !== "compat")
      throw new UsageError("--before-1.7 applies to --tables compat");
    const dryRun = values["dry-run"] === true;
    const json = values.json === true;
    const say = sayer(ctx, json);
    const run = await TARGETS[target](ctx, values, {
      tables,
      dryRun,
      note: (line) => ctx.err(line),
    });
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
