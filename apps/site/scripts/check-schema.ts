import { type CheckReport, requireCounts } from "./lib/report.ts";

function text(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * The schema page holds the version of core and the compat migrations, from
 * one source each (plan 12c, the Task 1 review). The page lagged one version
 * once: core moved to 8 and the page still said 7. So the check reads
 * `SCHEMA_VERSION` of core and `COMPAT_MIGRATION_NAMES` of the compat
 * package. The version table must list 1 to the version, each with its
 * migration `000N_schema_vN`. Every "version N" sentence must name the
 * version, and the "needs the migrations up to" sentence its migration. The
 * compat table must list each name, in order. The D1 files table of the
 * Better Auth migration guide must list the same names as `.sql` files: an
 * operator who copies fewer files leaves the database a version behind.
 */
export function checkSchema(
  html: string,
  version: number,
  compatNames: readonly string[],
  guideHtml: string,
): CheckReport {
  const cellsOf = (page: string) =>
    [...page.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1] ?? "")),
    );
  const rows = cellsOf(html);
  const versionRows = rows.filter((cells) => /^\d+$/.test(cells[0] ?? ""));
  const compatRows = rows
    .map((cells) => cells[0] ?? "")
    .filter((first) => /^\d{4}_compat_/.test(first));
  const guideRows = cellsOf(guideHtml)
    .map((cells) => cells[0] ?? "")
    .filter((first) => /^\d{4}_compat_.*\.sql$/.test(first))
    .map((file) => file.slice(0, -".sql".length));
  const latest = `${String(version).padStart(4, "0")}_schema_v${version}`;
  const page = text(html);
  const said = [
    ...page.matchAll(/SCHEMA_VERSION of @authtempo\/core is (\d+)/g),
    ...page.matchAll(/Core at version (\d+) needs/g),
  ].map((m) => Number(m[1]));
  const upTo = [...page.matchAll(/needs the migrations up to (\d{4}_schema_v\d+)/g)].map(
    (m) => m[1] ?? "",
  );
  const r: CheckReport = {
    name: "check-schema",
    counts: {
      version,
      rows: versionRows.length,
      statements: said.length,
      compat: compatNames.length,
      compatRows: compatRows.length,
      guideRows: guideRows.length,
    },
    failures: [],
  };
  for (let v = 1; v <= version; v++) {
    const migration = `${String(v).padStart(4, "0")}_schema_v${v}`;
    const row = versionRows.find((cells) => cells[0] === String(v));
    if (!row) r.failures.push(`version ${v} has no row`);
    else if (row[1] !== migration)
      r.failures.push(`version ${v} names ${row[1] ?? "no migration"}, not ${migration}`);
  }
  for (const cells of versionRows)
    if (Number(cells[0]) > version)
      r.failures.push(`version ${cells[0]} is above SCHEMA_VERSION ${version}`);
  if (!said.includes(version))
    r.failures.push(`no sentence says SCHEMA_VERSION of @authtempo/core is ${version}`);
  for (const n of said)
    if (n !== version)
      r.failures.push(`a sentence says version ${n}; SCHEMA_VERSION is ${version}`);
  for (const name of upTo)
    if (name !== latest)
      r.failures.push(`a sentence needs the migrations up to ${name}, not ${latest}`);
  if (guideRows.join(",") !== compatNames.join(","))
    r.failures.push(
      `the guide's D1 files are ${guideRows.join(", ") || "none"}; COMPAT_MIGRATION_NAMES is ${compatNames.join(", ")}`,
    );
  if (compatRows.join(",") !== compatNames.join(","))
    r.failures.push(
      `the compat rows are ${compatRows.join(", ") || "none"}; COMPAT_MIGRATION_NAMES is ${compatNames.join(", ")}`,
    );
  return requireCounts(r, ["version", "rows", "statements", "compat", "compatRows", "guideRows"]);
}
