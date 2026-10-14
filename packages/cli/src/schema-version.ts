import { Stop } from "./errors.js";
import type { Ctx } from "./output.js";
import {
  adapterD1Dir,
  compatD1Dir,
  type D1Target,
  readD1Applied,
  readD1VersionText,
} from "./seams/d1.js";

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
