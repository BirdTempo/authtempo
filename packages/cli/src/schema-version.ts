import { COMPAT_MIGRATION_NAMES } from "@authtempo/compat-better-auth";
import { Stop } from "./errors.js";
import type { Ctx } from "./output.js";
import {
  adapterD1Dir,
  compatD1Dir,
  type D1Target,
  readD1Applied,
  readD1VersionText,
} from "./seams/d1.js";
import { SCHEMA_VERSION } from "./version.js";

// The one rule that reads a schema version, for `migrate` and `check`
// (spec 19, item 8; review of plan 11c Task 8): two copies would drift.

/**
 * The version as the gate can read it, one rule for both targets (spec 19,
 * item 8). A `schema_version` that is not a whole number, or a missing row
 * over applied migrations, is a database that this CLI cannot place. The run
 * stops before any write, as it stops on a newer database. `table` is the
 * table of applied migrations: `ta_migrations` on Postgres, wrangler's
 * `migrations_table` on D1.
 */
export function readableVersion(
  raw: string | null,
  appliedCount: number,
  table = "ta_migrations",
): number | null {
  if (raw === null) {
    if (appliedCount > 0)
      throw new Stop(
        `ta_meta has no schema_version, but ${table} holds ${appliedCount} applied migration(s); nothing was written`,
      );
    return null;
  }
  if (!/^\d+$/.test(raw))
    throw new Stop(
      `ta_meta holds schema_version ${JSON.stringify(raw)}, which is not a version number; nothing was written`,
    );
  return Number(raw);
}

/**
 * The version gate of `migrate` and `check` (spec 19): a database newer than
 * the core of this CLI stops the run before any write. An older set never
 * runs over a newer database. Here beside `readableVersion`, so the migrate
 * command and the import gate read one rule (review of plan 11f Task 3).
 */
export function gate(version: number | null): void {
  if (version !== null && version > SCHEMA_VERSION)
    throw new Stop(
      `the database is at version ${version}; this CLI knows version ${SCHEMA_VERSION}; use a newer CLI`,
    );
}

/** The mapping version of the compatibility package: one per compat migration. */
const COMPAT_VERSION = COMPAT_MIGRATION_NAMES.length;

/**
 * The gate of `authtempo import` (spec 23 item 4). An import writes only into
 * a database at the CLI's own version. An adapter of another version lacks a
 * table or a column. `gate` of migrate stops only a newer database; this one
 * also stops an older one and names the fix. The higher line comes from
 * `gate` itself, so that text keeps one source. The gate also reads two
 * facts of the database (rulings 6 and 7 of plan 11f). `appliedCore` is the
 * count of core's applied migrations. `compatVersion` is the mapping version
 * of the compat tables, 0 when the database has none. A core import on a
 * database that only the compat run made names the compat set. A compat
 * import on a database that only core's migrations made names the core set.
 * A compat import also stops on compat tables of another mapping version:
 * that compat storage lacks a table too.
 */
export function importGate(
  version: number | null,
  tables: "core" | "compat",
  db: { appliedCore: number; compatVersion: number },
): void {
  const fix = `run authtempo migrate --target postgres${tables === "compat" ? " --tables compat" : ""} first`;
  if (version === null)
    throw new Stop(`the database has no schema of authtempo; ${fix}; nothing was written`);
  if (version < SCHEMA_VERSION)
    throw new Stop(
      `the database is at version ${version}; this CLI writes version ${SCHEMA_VERSION}; ${fix}; nothing was written`,
    );
  try {
    gate(version);
  } catch (e) {
    if (e instanceof Stop) throw new Stop(`${e.message}; nothing was written`);
    throw e;
  }
  const { appliedCore, compatVersion } = db;
  if (tables === "core") {
    // Only the compat run writes schema_version with no ta_migrations row.
    if (appliedCore === 0 && compatVersion > 0)
      throw new Stop(
        "the database holds the Better Auth tables of an app; add --tables compat; nothing was written",
      );
    return;
  }
  // The compat run always writes its own row, so a schema_version with no
  // compat row is a database that only core's migrations made. The compat
  // run stops on it (its tables exist), so the fix is another run or database.
  if (compatVersion === 0)
    throw new Stop(
      "the database holds the tables of core and no Better Auth tables of an app; leave out --tables compat for the tables of core, or point --url-env at the Better Auth database of the app; nothing was written",
    );
  if (compatVersion < COMPAT_VERSION)
    throw new Stop(
      `the compat tables are at version ${compatVersion}; this CLI writes version ${COMPAT_VERSION}; ${fix}; nothing was written`,
    );
  if (compatVersion > COMPAT_VERSION)
    throw new Stop(
      `the compat tables are at version ${compatVersion}; this CLI knows version ${COMPAT_VERSION}; use a newer CLI; nothing was written`,
    );
}

/** The name of a migration file without its number and `.sql`: `0003_schema_v3.sql` gives `schema_v3`. */
const stem = (name: string) => name.replace(/\.sql$/, "").replace(/^\d+_/, "");

/**
 * The count of applied D1 migrations that are ours: a file of the adapter or
 * of the compatibility package, by its name without the number. The app's
 * own migrations (such as its Better Auth tables before a compat run) set no
 * schema_version, so they do not count for the rule of a missing row.
 */
function ownAppliedCount(ctx: Ctx, applied: readonly string[]): number {
  const ours = new Set(
    [adapterD1Dir(), compatD1Dir(false), compatD1Dir(true)].flatMap((dir) =>
      ctx
        .listDir(dir)
        .filter((f) => f.endsWith(".sql"))
        .map(stem),
    ),
  );
  return applied.filter((n) => ours.has(stem(n))).length;
}

/**
 * The schema version of the D1 database through `readableVersion`, the rule
 * of both targets. It reads wrangler's table of applied migrations first,
 * for the count of the missing-row rule.
 */
export async function readD1Version(
  ctx: Ctx,
  t: D1Target,
): Promise<{ version: number | null; applied: string[] }> {
  const applied = await readD1Applied(ctx, t);
  const raw = await readD1VersionText(ctx, t);
  return {
    version: readableVersion(raw, ownAppliedCount(ctx, applied), t.migrationsTable),
    applied,
  };
}
