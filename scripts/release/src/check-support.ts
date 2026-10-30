import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Report, reportLines } from "./lib/report.ts";

/** One minor of the support table, release/support.json (spec 33 item 7). */
export interface SupportRow {
  /** `<major>.<minor>`, such as 0.1. */
  minor: string;
  status: "current" | "security" | "unsupported";
  /** The date of the first release of the minor, YYYY-MM-DD. */
  released: string;
  /** The last day of security fixes, YYYY-MM-DD. A security row needs it. */
  securityUntil?: string;
  /** Each schema version that `authtempo migrate` of this minor takes to the current one. */
  schemaFrom: number[];
}

export interface SupportInput {
  rows: readonly SupportRow[];
  /** The day of the run, YYYY-MM-DD. */
  today: string;
  /** SCHEMA_VERSION of packages/core/src/schema.ts. */
  schemaVersion: number;
  /** Each adapter folder name to the schema version that each of its migrations writes. */
  migrations: Readonly<Record<string, readonly number[]>>;
}

const STATUSES = ["current", "security", "unsupported"] as const;
const ROW_KEYS = new Set(["minor", "status", "released", "securityUntil", "schemaFrom"]);
const MINOR = /^\d+\.\d+$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The days that the security date may fall after the 3 months of owner
 * decision 3. A date before them breaks the promise. A date long after them
 * is not the decision, so a typo of a month fails. The 7 days let the owner
 * end on a release day.
 */
const GRACE_DAYS = 7;

/** True for a real calendar day in the form YYYY-MM-DD. */
function isDay(text: unknown): text is string {
  if (typeof text !== "string" || !DAY.test(text)) return false;
  const t = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === text;
}

/** The day `months` calendar months after `day`, on the last day of the month when it has fewer days. */
function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The minor as two numbers, for the order of the table. */
function minorParts(minor: string): [number, number] {
  const [major, min] = minor.split(".").map(Number);
  return [major ?? 0, min ?? 0];
}

/**
 * Reads release/support.json. Each row must have the shape of SupportRow,
 * so the check never reads a field that the file does not hold.
 */
export function readSupport(text: string): { rows: SupportRow[]; failures: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { rows: [], failures: ["release/support.json is not JSON"] };
  }
  if (!Array.isArray(data)) return { rows: [], failures: ["release/support.json is not an array"] };
  const failures: string[] = [];
  const rows: SupportRow[] = [];
  data.forEach((raw: unknown, i) => {
    const at = `row ${i + 1}`;
    const before = failures.length;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      failures.push(`${at}: it is not an object`);
      return;
    }
    const row = raw as Record<string, unknown>;
    for (const key of Object.keys(row))
      if (!ROW_KEYS.has(key)) failures.push(`${at}: ${key} is not a key of a support row`);
    if (typeof row.minor !== "string" || !MINOR.test(row.minor))
      failures.push(`${at}: minor is ${String(row.minor)}; it must be <major>.<minor>`);
    if (!STATUSES.includes(row.status as SupportRow["status"]))
      failures.push(
        `${at}: status is ${String(row.status)}; it must be current, security, or unsupported`,
      );
    if (!isDay(row.released))
      failures.push(
        `${at}: released is ${String(row.released)}; it must be a real date YYYY-MM-DD`,
      );
    if (row.securityUntil !== undefined && !isDay(row.securityUntil))
      failures.push(
        `${at}: securityUntil is ${String(row.securityUntil)}; it must be a real date YYYY-MM-DD`,
      );
    if (!Array.isArray(row.schemaFrom) || !row.schemaFrom.every((v) => Number.isInteger(v)))
      failures.push(`${at}: schemaFrom must be a list of whole numbers`);
    if (failures.length === before) rows.push(row as unknown as SupportRow);
  });
  return { rows, failures };
}

/**
 * Holds the support table to owner decision 3 of 2026-10-14 (spec 33 item 7).
 * After the first release, exactly one minor is current, and it is the
 * newest minor. The previous minor gets security fixes for
 * 3 months after the next minor ships. A minor past that date is unsupported.
 * From each schema version of a supported minor, each adapter has a chain of
 * migrations to SCHEMA_VERSION, so one `authtempo migrate` reaches it.
 */
export function checkSupport(input: SupportInput): Report {
  const failures: string[] = [];
  const rows = [...input.rows].sort((a, b) => {
    const [x, y] = [minorParts(a.minor), minorParts(b.minor)];
    return x[0] - y[0] || x[1] - y[1];
  });
  const currents = rows.filter((r) => r.status === "current");
  const counts = {
    minors: rows.length,
    current: currents.length,
    security: rows.filter((r) => r.status === "security").length,
  };
  // The current minor gets every fix (owner decision 3). So after the first
  // release, one minor is current, and it is the newest one. A status typo on
  // a release day must not leave the table with no current minor.
  if (rows.length > 0 && currents.length !== 1)
    failures.push(
      `${currents.length} minors are current${currents.length > 0 ? ` (${currents.map((r) => r.minor).join(", ")})` : ""}; a released table has exactly one current minor`,
    );
  const newest = rows[rows.length - 1];
  const only = currents.length === 1 ? currents[0] : undefined;
  if (only !== undefined && newest !== undefined && only !== newest)
    failures.push(
      `${only.minor} is current and ${newest.minor} is newer; the newest minor is the current minor`,
    );

  // Each minor has one row, and the minors ship in their number order. The
  // security date of each minor reads the release of the next minor.
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = minorParts(row.minor).join(".");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [minor, n] of seen)
    if (n > 1) failures.push(`the minor ${minor} has ${n} rows; each minor has one row`);
  for (const [i, row] of rows.entries()) {
    const older = rows[i - 1];
    if (older === undefined || seen.get(minorParts(row.minor).join(".")) !== 1) continue;
    if (row.released <= older.released)
      failures.push(
        `${row.minor} released ${row.released}, not after ${older.minor} released ${older.released}; a newer minor is released later`,
      );
  }

  for (const [i, row] of rows.entries()) {
    if (row.status === "security") {
      const next = rows[i + 1];
      if (row.securityUntil === undefined)
        failures.push(`${row.minor} has the status security and no securityUntil`);
      else if (next === undefined)
        failures.push(`${row.minor} has the status security and no newer minor`);
      else {
        const from = addMonths(next.released, 3);
        const to = addDays(from, GRACE_DAYS);
        if (row.securityUntil < from || row.securityUntil > to)
          failures.push(
            `${row.minor} has security fixes until ${row.securityUntil}; owner decision 3 needs 3 months after ${next.minor} released ${next.released}, from ${from} to ${to}`,
          );
      }
    }
    if (
      row.status !== "unsupported" &&
      row.securityUntil !== undefined &&
      input.today > row.securityUntil
    )
      failures.push(
        `${row.minor} is past its security date ${row.securityUntil} and its status is ${row.status}, not unsupported`,
      );
  }

  const adapters = Object.keys(input.migrations).sort();
  if (adapters.length === 0) failures.push("read 0 adapters");
  for (const row of rows) {
    if (row.status === "unsupported") continue;
    for (const from of row.schemaFrom) {
      if (from > input.schemaVersion) {
        failures.push(
          `${row.minor} supports the schema version ${from}, above SCHEMA_VERSION ${input.schemaVersion}`,
        );
        continue;
      }
      for (const adapter of adapters) {
        const have = new Set(input.migrations[adapter]);
        for (let v = from + 1; v <= input.schemaVersion; v++)
          if (!have.has(v)) {
            failures.push(
              `${adapter} has no migration to the schema version ${v}, so ${row.minor} cannot reach ${input.schemaVersion} from ${from}`,
            );
            break;
          }
      }
    }
  }

  // An empty table is the state before the first release, not a check that read nothing.
  const notes = rows.length === 0 ? ["no release exists"] : [];
  return { name: "check-support", counts, failures, notes };
}

/** The schema version that a migration file name writes: `0011_schema_v11.sql` writes 11. */
const MIGRATION_FILE = /^\d{4}_schema_v(\d+)\.(?:sql|ts)$/;

/** The folders that hold the migration files of an adapter package. */
const MIGRATION_DIRS = ["migrations", "src/migrations"];

/**
 * One entry of release/migration-sources.json: an adapter that ships the
 * migration files of another folder in place of its own (ruling 38).
 */
export interface MigrationSource {
  /** The folder of the files that the adapter ships, from the repository root. */
  from: string;
  /** Why the adapter has no folder of its own. */
  reason: string;
  /** The test file, from the repository root, that holds the copy to the files: under packages/<adapter>/test/. */
  proof: string;
}

const SOURCE_KEYS = ["from", "reason", "proof"];

/** True for a path under the repository root: relative, with no empty, `.`, or `..` part. */
function isTreePath(text: string): boolean {
  return text.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Reads release/migration-sources.json: each adapter folder name to its
 * MigrationSource. Each entry must have the shape, so the check never reads
 * a field that the file does not hold. The sources object has no prototype,
 * so a `__proto__` key is an own key: the stale-entry rule of readMigrations
 * then sees it and fails it.
 */
export function readMigrationSources(text: string): {
  sources: Record<string, MigrationSource>;
  failures: string[];
} {
  const at = "release/migration-sources.json";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { sources: {}, failures: [`${at} is not JSON`] };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return { sources: {}, failures: [`${at} is not an object`] };
  const failures: string[] = [];
  const sources: Record<string, MigrationSource> = Object.create(null);
  for (const [adapter, raw] of Object.entries(data)) {
    const before = failures.length;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      failures.push(`${at}: ${adapter} is not an object`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry))
      if (!SOURCE_KEYS.includes(key))
        failures.push(`${at}: ${adapter}: ${key} is not a key of a migration source`);
    for (const key of SOURCE_KEYS) {
      const value = entry[key];
      if (typeof value !== "string" || value.trim() === "")
        failures.push(`${at}: ${adapter}: ${key} must be a text that is not empty`);
      else if (key !== "reason" && !isTreePath(value))
        failures.push(`${at}: ${adapter}: ${key} ${value} is not a path under the repository root`);
    }
    if (failures.length === before) sources[adapter] = entry as unknown as MigrationSource;
  }
  return { sources, failures };
}

/** The schema version of each migration file of `dir`, and a failure for each other file name. */
function readVersions(dir: string, label: string, failures: string[]): number[] {
  const versions: number[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = MIGRATION_FILE.exec(file);
    if (m === null) failures.push(`${label}: ${file} is not a migration file name`);
    else versions.push(Number(m[1]));
  }
  return versions;
}

/**
 * Each adapter package of the tree (`packages/adapter-*`) to the schema
 * version of each migration file. The files are the one list: the D1 adapter
 * ships its folder, and the Postgres list imports each file. A file of
 * another name fails, and so does an adapter with no migration folder or
 * with an empty one.
 *
 * The exemption: an adapter can ship the files of another folder, such as
 * the SQLite adapter, whose build copies the D1 files. Its versions are then
 * the versions of that folder. The exemption is data in
 * release/migration-sources.json, not a name in this code, so each entry
 * states its reason and names the test that holds the copy. An entry fails
 * when its folder has no migration, when its proof is not a file under
 * packages/<adapter>/test/, and when its adapter has a folder of its own or
 * no package. Without these
 * failures, an entry could hide an adapter that ships no migration at all.
 */
export function readMigrations(root: string): {
  migrations: Record<string, number[]>;
  failures: string[];
} {
  const failures: string[] = [];
  const migrations: Record<string, number[]> = {};
  const sourcesFile = join(root, "release/migration-sources.json");
  const { sources, failures: sourceFailures } = existsSync(sourcesFile)
    ? readMigrationSources(readFileSync(sourcesFile, "utf8"))
    : { sources: {}, failures: ["release/migration-sources.json does not exist"] };
  failures.push(...sourceFailures);
  const packages = join(root, "packages");
  const adapters = readdirSync(packages)
    .filter((name) => name.startsWith("adapter-"))
    .sort();
  for (const name of Object.keys(sources).sort())
    if (!adapters.includes(name))
      failures.push(
        `release/migration-sources.json: ${name} is not an adapter package of packages/`,
      );
  for (const name of adapters) {
    const sub = MIGRATION_DIRS.find((d) => existsSync(join(packages, name, d)));
    const source = sources[name];
    if (sub !== undefined) {
      if (source !== undefined)
        failures.push(
          `release/migration-sources.json: packages/${name} has its own migrations folder, so it takes no entry`,
        );
      const versions = readVersions(join(packages, name, sub), `packages/${name}`, failures);
      // An empty folder of its own is an adapter that ships no migration.
      if (versions.length === 0) failures.push(`packages/${name}: ${sub} has no migrations`);
      migrations[name] = versions;
      continue;
    }
    if (source === undefined) {
      failures.push(
        `packages/${name} has no migrations or src/migrations folder and no entry in release/migration-sources.json`,
      );
      continue;
    }
    const before = failures.length;
    // The proof is a test of the adapter itself, not any path that exists.
    const proof = join(root, source.proof);
    if (!existsSync(proof))
      failures.push(
        `release/migration-sources.json: ${name}: the proof ${source.proof} does not exist`,
      );
    else if (!source.proof.startsWith(`packages/${name}/test/`) || !statSync(proof).isFile())
      failures.push(
        `release/migration-sources.json: ${name}: the proof ${source.proof} is not a file under packages/${name}/test/`,
      );
    const from = join(root, source.from);
    const versions =
      existsSync(from) && statSync(from).isDirectory()
        ? readVersions(from, source.from, failures)
        : [];
    if (versions.length === 0)
      failures.push(`release/migration-sources.json: ${name}: ${source.from} has no migrations`);
    if (failures.length === before) migrations[name] = versions;
  }
  return { migrations, failures };
}

/** SCHEMA_VERSION of packages/core/src/schema.ts, or null when the line is not there. */
export function readSchemaVersion(root: string): number | null {
  const m = /^export const SCHEMA_VERSION = (\d+);$/m.exec(
    readFileSync(join(root, "packages/core/src/schema.ts"), "utf8"),
  );
  return m === null ? null : Number(m[1]);
}

/** Runs the check on the checkout at `root` on the day `today`, and returns the lines to print and the exit code. */
export function entry(root: string, today: string): { lines: string[]; code: number } {
  const support = readSupport(readFileSync(join(root, "release/support.json"), "utf8"));
  const { migrations, failures } = readMigrations(root);
  const schemaVersion = readSchemaVersion(root);
  const report = checkSupport({
    rows: support.rows,
    today,
    schemaVersion: schemaVersion ?? 0,
    migrations,
  });
  report.failures.unshift(...support.failures, ...failures);
  if (schemaVersion === null)
    report.failures.unshift("packages/core/src/schema.ts holds no SCHEMA_VERSION line");
  const adapters = Object.keys(migrations);
  report.notes.push(
    `adapters=${adapters.length} (${adapters.join(", ")}), SCHEMA_VERSION ${schemaVersion ?? "unread"}`,
  );
  return { lines: reportLines(report), code: report.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  const { lines, code } = entry(
    fileURLToPath(new URL("../../../", import.meta.url)),
    new Date().toISOString().slice(0, 10),
  );
  for (const line of lines) console.log(line);
  process.exit(code);
}
