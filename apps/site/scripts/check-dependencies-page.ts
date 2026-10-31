// check-dependencies-page (plan 12j Task 13, spec 33 item 9). The page
// /docs/reference/dependencies/ against release/dependencies.json, both ways.
// The page lists what an app installs with a released package: each runtime
// row and each peer row that a released package uses. Each such row is one
// table row of the page, with its versions, its released users, and its
// reason, and each table row is such a row of the file. The page lists a peer
// row too: an app installs a peer itself (a deviation from the plan, which
// names the runtime rows only).
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The page, by its path under src/content/docs/. */
export const DEPENDENCIES_PAGE = "docs/reference/dependencies.md";
/** The part of the page that holds the table. */
const TABLE = "## The dependencies";
/** The kinds of row that an app installs with a released package. */
const LISTED_KINDS: readonly string[] = ["runtime", "peer"];

/** The fields of a row of release/dependencies.json that the page states. */
export interface DependencyRow {
  name: string;
  kind: string;
  versions: string[];
  users?: string[];
  reason: string;
}

export interface DependenciesPageInput {
  rows: readonly DependencyRow[];
  /** The released names: the fixed group. */
  released: readonly string[];
  /** The source of the page, or "" when it is missing. */
  source: string;
}

const code = (s: string) => `\`${s}\``;

/** The table row of a dependency row, or null when the page does not list it. */
export function pageRow(row: DependencyRow, released: readonly string[]): string | null {
  const users = (row.users ?? []).filter((u) => released.includes(u)).sort();
  if (!LISTED_KINDS.includes(row.kind) || users.length === 0) return null;
  const cells = [
    code(row.name),
    row.kind,
    row.versions.map(code).join(", "),
    users.map(code).join(", "),
    row.reason.replaceAll("|", "\\|"),
  ];
  return `| ${cells.join(" | ")} |`;
}

/** The body rows of the first table under TABLE: each line that starts with "| `". */
function tableRows(source: string): string[] {
  const start = source.indexOf(`\n${TABLE}\n`);
  if (start === -1) return [];
  const rest = source.slice(start + TABLE.length + 2);
  const end = rest.search(/^## /m);
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("| `"));
}

/** The key of a table row: its first two cells, the name and the kind. */
const keyOf = (line: string) => line.split(" | ").slice(0, 2).join(" | ");

/** How many times each item occurs, in the order of its first one. */
function countOf(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

export function checkDependenciesPage(input: DependenciesPageInput): CheckReport {
  const { rows, released, source } = input;
  const expected = rows.flatMap((row) => pageRow(row, released) ?? []);
  const found = tableRows(source);
  const r: CheckReport = {
    name: "check-dependencies-page",
    counts: { rows: rows.length, listed: expected.length, tableRows: found.length },
    failures: [],
  };
  if (source === "") r.failures.push(`${DEPENDENCIES_PAGE} does not exist`);
  const byKey = new Map(found.map((l) => [keyOf(l), l]));
  // A row twice passes each test above, and the counts then differ, so it fails here.
  for (const [key, n] of countOf(found.map(keyOf)))
    if (n > 1) r.failures.push(`${DEPENDENCIES_PAGE} has the row ${key} | ${n} times`);
  for (const line of expected) {
    const on = byKey.get(keyOf(line));
    if (on === undefined) r.failures.push(`${DEPENDENCIES_PAGE} lacks the row ${keyOf(line)} |`);
    else if (on !== line)
      r.failures.push(
        `${DEPENDENCIES_PAGE}: the row ${keyOf(line)} | differs; the file gives ${line}`,
      );
  }
  const keys = new Set(expected.map(keyOf));
  for (const line of found)
    if (!keys.has(keyOf(line)))
      r.failures.push(
        `${DEPENDENCIES_PAGE} has the row ${keyOf(line)} |, which no runtime or peer row of a released package gives`,
      );
  return requireCounts(r, ["rows", "listed", "tableRows"]);
}
