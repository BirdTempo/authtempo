import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { D1_SHAPE_SQL, parseD1Shape } from "@authtempo/adapter-d1";
import type { LiveShape } from "@authtempo/core/sql";
import { Stop, UsageError } from "../errors.js";
import { parseJsonc } from "../jsonc.js";
import type { Ctx } from "../output.js";
import { COMPAT_META_KEY } from "./postgres.js";

/**
 * The D1 seam of the CLI (spec 19): the one module that runs wrangler. The
 * CLI ships no wrangler; it runs the project's own pinned one from
 * node_modules/.bin, so a change of wrangler's output changes this file only.
 */

/** wrangler's own table of applied D1 migrations: the default of `migrations_table` (wrangler 4.148.0, read 2026-10-14). */
export const DEFAULT_MIGRATIONS_TABLE = "d1_migrations";
/** wrangler's default of `migrations_dir`. */
const DEFAULT_MIGRATIONS_DIR = "migrations";
const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * CI=1 makes wrangler take the default of each question, as
 * examples/worker/proof/dev.mjs found (read 2026-10-10). The metrics prompt
 * and color stay off in a child process. The hidden banner skips wrangler's
 * npm update check (wrangler 4.148.0, seen 2026-10-18). The check's open
 * socket keeps the child alive when the registry does not answer.
 */
const ENV = {
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_HIDE_BANNER: "true",
  NO_COLOR: "1",
} as const;

export interface D1Project {
  /** The folder of the wrangler config: wrangler runs here. */
  cwd: string;
  config: string;
  database: string;
  migrationsDir: string;
  migrationsTable: string;
}

export interface D1Target extends D1Project {
  remote: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The wrangler config of the project: `--config`, else wrangler.jsonc or wrangler.json in the folder. */
export function findWranglerConfig(ctx: Ctx, given: string | undefined): string {
  if (given !== undefined) return resolve(ctx.cwd, given);
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const path = resolve(ctx.cwd, name);
    if (ctx.exists(path)) return path;
  }
  if (ctx.exists(resolve(ctx.cwd, "wrangler.toml")))
    throw new Stop(
      "authtempo reads wrangler.jsonc or wrangler.json; this project has wrangler.toml",
    );
  throw new Stop(
    `no wrangler.jsonc in ${ctx.cwd}: run the command in the folder of the Worker, or give --config`,
  );
}

/** The D1 database of the config: the one entry, or the entry whose `database_name` is `database`. */
export function readD1Project(
  ctx: Ctx,
  configPath: string,
  database: string | undefined,
): D1Project {
  if (!ctx.exists(configPath)) throw new Stop(`no ${configPath}`);
  let config: unknown;
  try {
    config = parseJsonc(ctx.readFile(configPath));
  } catch (e) {
    throw new Stop(
      `${configPath} is not JSON with comments: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const list =
    isRecord(config) && Array.isArray(config.d1_databases)
      ? config.d1_databases.filter(isRecord)
      : [];
  let entry: Record<string, unknown> | undefined;
  if (database === undefined) {
    if (list.length !== 1)
      throw new UsageError(
        list.length === 0
          ? `${configPath} has no d1_databases entry`
          : `${configPath} has ${list.length} D1 databases: name one with --database`,
      );
    entry = list[0];
  } else entry = list.find((d) => d.database_name === database);
  if (!entry || typeof entry.database_name !== "string")
    throw new UsageError(`${configPath} has no D1 database named ${database ?? ""}`);
  const table =
    typeof entry.migrations_table === "string" ? entry.migrations_table : DEFAULT_MIGRATIONS_TABLE;
  if (!SQL_NAME.test(table)) throw new Stop(`migrations_table ${table} is not a plain SQL name`);
  const cwd = dirname(configPath);
  const dir =
    typeof entry.migrations_dir === "string" ? entry.migrations_dir : DEFAULT_MIGRATIONS_DIR;
  return {
    cwd,
    config: configPath,
    database: entry.database_name,
    migrationsDir: resolve(cwd, dir),
    migrationsTable: table,
  };
}

/** The project's wrangler. */
export function wranglerOf(cwd: string): string {
  return join(cwd, "node_modules", ".bin", "wrangler");
}

function wrangler(ctx: Ctx, t: D1Target, args: readonly string[]) {
  return ctx.run(
    wranglerOf(t.cwd),
    [...args, t.remote ? "--remote" : "--local", "--config", t.config],
    {
      cwd: t.cwd,
      env: ENV,
    },
  );
}

/** The first line of wrangler's answer that names an error, for one stopped line. */
function firstError(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return (lines.find((l) => /error/i.test(l)) ?? lines[0] ?? "no output").slice(0, 300);
}

/** One SELECT through `wrangler d1 execute --json`: the rows, or the text of the failure. */
async function select(
  ctx: Ctx,
  t: D1Target,
  sql: string,
): Promise<{ rows: Record<string, unknown>[] } | { failure: string }> {
  const r = await wrangler(ctx, t, ["d1", "execute", t.database, "--json", "--command", sql]);
  if (r.status !== 0) return { failure: `${r.stdout}\n${r.stderr}` };
  // wrangler 4.148.0 prints one array entry per statement: [{ results, success, meta }].
  const start = r.stdout.indexOf("[");
  const parsed = JSON.parse(start === -1 ? "[]" : r.stdout.slice(start)) as {
    results?: Record<string, unknown>[];
  }[];
  return { rows: parsed[0]?.results ?? [] };
}

const NO_TABLE = /no such table/i;

/** The text of one row of `ta_meta`, or null when the table or the row is missing. */
async function readD1MetaText(ctx: Ctx, t: D1Target, key: string): Promise<string | null> {
  const r = await select(ctx, t, `SELECT value FROM ta_meta WHERE key = '${key}'`);
  if ("failure" in r) {
    if (NO_TABLE.test(r.failure)) return null;
    throw new Stop(`wrangler d1 execute: ${firstError(r.failure)}`);
  }
  const v = r.rows[0]?.value;
  return v === undefined || v === null ? null : String(v);
}

/**
 * The text of `ta_meta.schema_version` in the D1 database, or null when the
 * table or the row is missing. The command reads it through
 * `readableVersion`, the one rule of both targets. This seam converts no
 * number, so a value such as `9x` never becomes NaN here.
 */
export function readD1VersionText(ctx: Ctx, t: D1Target): Promise<string | null> {
  return readD1MetaText(ctx, t, "schema_version");
}

/**
 * The text of the compat mapping version of the D1 database, or null when
 * the table or the row is missing. The failure rule is the one of
 * `readD1VersionText`. The compat copy of `migrate` reads it first, so the
 * database decides which compat files the app holds already (plan 11f Task 5).
 */
export function readD1CompatText(ctx: Ctx, t: D1Target): Promise<string | null> {
  return readD1MetaText(ctx, t, COMPAT_META_KEY);
}

/** The migrations that wrangler applied, by name without `.sql`. */
export async function readD1Applied(ctx: Ctx, t: D1Target): Promise<string[]> {
  const r = await select(ctx, t, `SELECT name FROM ${t.migrationsTable} ORDER BY id`);
  if ("failure" in r) {
    if (NO_TABLE.test(r.failure)) return [];
    throw new Stop(`wrangler d1 execute: ${firstError(r.failure)}`);
  }
  return r.rows.map((row) => String(row.name).replace(/\.sql$/, ""));
}

/** `wrangler d1 migrations apply`: it rolls back a file that fails, so a refused file changes nothing. */
export async function applyD1(ctx: Ctx, t: D1Target): Promise<void> {
  const r = await wrangler(ctx, t, ["d1", "migrations", "apply", t.database]);
  if (r.status !== 0)
    throw new Stop(`wrangler d1 migrations apply: ${firstError(`${r.stdout}\n${r.stderr}`)}`);
}

/**
 * The live table shape of the D1 database (plan 11c2): the two reads of
 * `D1_SHAPE_SQL` through `wrangler d1 execute --json`, then `parseD1Shape`.
 * A refused read, or a row that the parse refuses, stops the run (exit 2).
 */
export async function readD1Shape(ctx: Ctx, t: D1Target): Promise<LiveShape> {
  const rows = async (sql: string) => {
    const r = await select(ctx, t, sql);
    if ("failure" in r) throw new Stop(`wrangler d1 execute: ${firstError(r.failure)}`);
    return r.rows;
  };
  const columns = await rows(D1_SHAPE_SQL.columns);
  const indexes = await rows(D1_SHAPE_SQL.indexes);
  try {
    return parseD1Shape(columns, indexes);
  } catch (e) {
    throw new Stop(`wrangler d1 execute: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const resolver = createRequire(import.meta.url);

/** The migration folder of the adapter that this CLI bundles. */
export function adapterD1Dir(): string {
  return join(dirname(resolver.resolve("@authtempo/adapter-d1")), "../migrations");
}

/** The D1 files of the compatibility package: `d1/`, or `d1-before-1.7/` for tables with no `account.issuer`. */
export function compatD1Dir(before17: boolean): string {
  return join(
    dirname(resolver.resolve("@authtempo/compat-better-auth")),
    "../migrations",
    before17 ? "d1-before-1.7" : "d1",
  );
}
