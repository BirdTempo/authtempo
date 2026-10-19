// The guide shape of spec 23 items 9 and 10: one machine check, not a paragraph.
// The providers come from `PROVIDER_FILES` of the importer, so a new reader
// without a guide fails here.
import { idsOf } from "./lib/html.ts";
import type { Page } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The seven H3 phases under "Steps" of each guide, in this order (spec 23 item 9). */
export const PHASES: readonly string[] = [
  "Export",
  "Carry the passwords",
  "Dry run",
  "Move",
  "Verify",
  "Change the calls",
  "Cut over",
];

/**
 * The guides with no reader of the importer, each with its reason. The check
 * prints the reason as an exempt line, so a reader sees each exemption. Such a
 * guide keeps the include rule: the Better Auth guide includes
 * samples/migrate/better-auth.ts, the server on the compatibility package.
 */
export const NO_READER: Readonly<Record<string, string>> = {
  "better-auth": "the compatibility package: the app keeps its tables (spec 16.2)",
};

const INDEX = "docs/migrate/index.md";
const NOT_GUIDES = new Set([INDEX, "docs/migrate/cutover.md"]);
/** The column of the index table that holds the one command of each move. */
const COMMAND_COLUMN = "The command";

/** The lines of a markdown body outside the code fences. */
function proseLines(source: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("```")) fence = !fence;
    else if (!fence) out.push(line);
  }
  return out;
}

// CommonMark lets an ATX heading start with up to three spaces. Four spaces make a code block.
const H2 = /^ {0,3}## /;
const H3 = /^ {0,3}### /;

/** The H3 lines from `## Steps` to the next H2, or null when the page has no Steps. */
function stepHeadings(lines: readonly string[]): string[] | null {
  const start = lines.findIndex((l) => H2.test(l) && l.trim() === "## Steps");
  if (start < 0) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (H2.test(line)) break;
    if (H3.test(line)) out.push(line.trim().slice(4).trim());
  }
  return out;
}

/** The import specifiers of an MDX page. */
function importSpecifiers(lines: readonly string[]): string[] {
  return lines.flatMap((l) => {
    const m = /^import\s.*\sfrom\s+["']([^"']+)["']/.exec(l);
    return m?.[1] !== undefined ? [m[1]] : [];
  });
}

/** The cells of one table line, with the outer pipes removed. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

interface Row {
  cells: string[];
  stem: string | null;
}

/**
 * The body rows of the first table of a page, each with the guide it links.
 * The table ends at the first line after it that does not start with a pipe.
 */
function tableRows(lines: readonly string[]): { header: string[]; rows: Row[] } {
  const isRow = (l: string) => l.trimStart().startsWith("|");
  const first = lines.findIndex(isRow);
  const rest = first < 0 ? [] : lines.slice(first);
  const end = rest.findIndex((l) => !isRow(l));
  const table = end < 0 ? rest : rest.slice(0, end);
  const header = table[0] === undefined ? [] : cells(table[0]);
  const rows = table.slice(2).map((line) => {
    const m = /\]\(\/docs\/migrate\/([^/#)]+)\/\)/.exec(line);
    return { cells: cells(line), stem: m?.[1] ?? null };
  });
  return { header, rows };
}

/** The text of a cell that is one code span, or null. */
function codeSpan(cell: string): string | null {
  const m = /^`([^`]+)`$/.exec(cell);
  return m?.[1] ?? null;
}

/**
 * Holds each guide of docs/migrate/ to the seven phases and to its own sample
 * and sample test. Holds the guides to the providers of the importer. Holds
 * the index table to the guides, and the import page to the conflict reasons.
 */
export function checkMigrate(
  pages: readonly Page[],
  providers: readonly string[],
  importPage: string,
  conflictReasons: ReadonlySet<string>,
): CheckReport {
  const r: CheckReport = { name: "check-migrate", counts: {}, failures: [] };
  const exempt: string[] = [];
  const guides = pages
    .filter((p) => p.path.startsWith("docs/migrate/") && !NOT_GUIDES.has(p.path))
    .map((p) => ({ page: p, stem: (p.path.split("/").at(-1) ?? "").replace(/\.[^.]+$/, "") }));

  let phases = 0;
  for (const { page, stem } of guides) {
    const lines = proseLines(page.source);
    const found = stepHeadings(lines);
    if (found === null) {
      r.failures.push(`${page.path} has no ## Steps`);
    } else {
      phases += found.length;
      if (found.join("\n") !== PHASES.join("\n"))
        r.failures.push(
          `${page.path}: the H3 lines under Steps are ${found.length === 0 ? "none" : found.join(", ")}; the phases are ${PHASES.join(", ")}`,
        );
    }
    // Spec 23 item 9: each guide includes its own sample and its own sample test, by its stem.
    const own = `samples/migrate/${stem}.ts?raw`;
    const ownTest = `samples/migrate/${stem}.test.ts?raw`;
    const included = importSpecifiers(lines).flatMap((s) => {
      const m = /(samples\/migrate\/[^/]+\?raw)$/.exec(s);
      return m?.[1] !== undefined ? [m[1]] : [];
    });
    for (const file of included)
      if (file !== own && file !== ownTest)
        r.failures.push(`${page.path} imports ${file}, which is not a file of the guide ${stem}`);
    for (const file of [own, ownTest]) {
      const n = included.filter((x) => x === file).length;
      if (n !== 1) r.failures.push(`${page.path} imports ${file} ${n} times; it needs one`);
    }
  }

  const stems = new Set(guides.map((g) => g.stem));
  for (const p of providers)
    if (!stems.has(p)) r.failures.push(`${p} has no guide in docs/migrate/`);
  for (const { page, stem } of guides) {
    if (providers.includes(stem)) continue;
    const reason = Object.hasOwn(NO_READER, stem) ? NO_READER[stem] : undefined;
    if (reason !== undefined) exempt.push(`${stem}: ${reason}`);
    else
      r.failures.push(
        `${page.path}: ${stem} is no provider of PROVIDER_FILES and no key of NO_READER`,
      );
  }

  const indexPage = pages.find((p) => p.path === INDEX);
  if (indexPage === undefined) r.failures.push(`${INDEX} is missing`);
  const { header, rows } = tableRows(proseLines(indexPage?.source ?? ""));
  const column = header.indexOf(COMMAND_COLUMN);
  if (indexPage !== undefined && column < 0)
    r.failures.push(`${INDEX} has no table column "${COMMAND_COLUMN}"`);
  for (const row of rows)
    if (row.stem === null || !stems.has(row.stem))
      r.failures.push(`a row of ${INDEX} links no guide: ${row.cells.join(" | ")}`);
  for (const { stem } of guides) {
    const mine = rows.filter((row) => row.stem === stem);
    if (mine.length === 0) {
      r.failures.push(`${stem} has no row in ${INDEX}`);
      continue;
    }
    if (mine.length > 1) r.failures.push(`${stem} has ${mine.length} rows in ${INDEX}`);
    // A guide of neither list already fails above, and has no command form to hold.
    const prefix = providers.includes(stem)
      ? `authtempo import ${stem} `
      : Object.hasOwn(NO_READER, stem)
        ? "authtempo migrate "
        : null;
    if (column < 0 || prefix === null) continue;
    for (const row of mine)
      if (!(codeSpan(row.cells[column] ?? "") ?? "").startsWith(prefix))
        r.failures.push(
          `${stem}: the command of its row in ${INDEX} does not start with \`${prefix}\``,
        );
  }

  const ids = idsOf(importPage);
  let anchors = 0;
  for (const reason of conflictReasons) {
    if (ids.has(reason)) anchors += 1;
    else r.failures.push(`${reason} has no anchor on /docs/reference/cli/import/`);
  }

  r.counts = {
    guides: guides.length,
    phases,
    providers: providers.length,
    rows: rows.length,
    anchors,
  };
  if (exempt.length > 0) r.exempt = exempt;
  return requireCounts(r, ["guides", "phases", "providers", "rows", "anchors"]);
}
