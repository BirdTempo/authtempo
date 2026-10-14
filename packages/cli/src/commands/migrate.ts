import { parseArgs } from "node:util";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { MIGRATE_HELP } from "../help/migrate.js";
import type { MigrateJson } from "../json.js";
import { type Ctx, describeUrl, printJson, sayer } from "../output.js";
import { CORE_MIGRATIONS, compatMigrationNames, openPostgres } from "../seams/postgres.js";
import { readSecret } from "../secrets.js";
import { SCHEMA_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  target: { type: "string" },
  tables: { type: "string" },
  "url-env": { type: "string" },
  "url-file": { type: "string" },
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

/**
 * The version gate (spec 19): a database newer than the core of this CLI
 * stops the run before any write. An older set never runs over a newer
 * database.
 */
export function gate(version: number | null): void {
  if (version !== null && version > SCHEMA_VERSION)
    throw new Stop(
      `the database is at version ${version}; this CLI knows version ${SCHEMA_VERSION}; use a newer CLI`,
    );
}

async function migratePostgres(ctx: Ctx, v: Values, plan: MigratePlan): Promise<MigrateRun> {
  const url = readSecret(ctx, {
    envFlag: "url-env",
    fileFlag: "url-file",
    env: v["url-env"],
    file: v["url-file"],
    defaultEnv: "DATABASE_URL",
    what: "the connection string",
  });
  plan.note(`connecting to ${describeUrl(url)}`);
  // One connection: the migrations run one at a time, each in its own transaction.
  const pg = openPostgres(url, 1);
  try {
    const before = await pg.schemaVersion();
    gate(before);
    const done = new Set(await pg.appliedCore());
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

/** The targets of `--target`. */
const TARGETS = { postgres: migratePostgres } as const;
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
    // The gate again: a run that ends below this CLI's version did not do its work.
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
      } satisfies MigrateJson);
    return 0;
  },
};
