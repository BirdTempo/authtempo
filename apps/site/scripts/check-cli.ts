import { type FlagForm, type HelpRun, pageFlags, parseHelp, tableRows } from "./lib/cli-help.ts";
import { idsOf } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

const SITE_ORIGIN = "https://authtempo.com";
const CLI_PAGES = `${SITE_ORIGIN}/docs/reference/cli/`;

/** The values of a closed set such as `<d1|postgres>`, or null for an open placeholder. */
function closedSet(value: string | null): string[] | null {
  const m = /^<([^<>]+\|[^<>]+)>$/.exec(value ?? "");
  return m ? (m[1] ?? "").split("|") : null;
}

function shown(value: string | null): string {
  return value === null ? "no value" : value;
}

/**
 * The page's flag table against the help's flags. A table cell cannot hold
 * a `|` in a code span, so a closed set such as `--target <d1|postgres>` is
 * one row per value on the page (`--target d1`, `--target postgres`).
 */
function compareFlags(label: string, help: readonly FlagForm[], rows: string[][]): string[] {
  const failures: string[] = [];
  const onPage = rows.flatMap((r) => pageFlags(r[0] ?? ""));
  const helpNames = new Set(help.map((f) => f.name));
  for (const h of help) {
    const forms = onPage.filter((f) => f.name === h.name);
    if (forms.length === 0) {
      failures.push(`${label}: the flag table lacks ${h.name}`);
      continue;
    }
    for (const f of forms)
      if (f.short !== h.short)
        failures.push(
          `${label}: ${h.name} has the short form ${f.short ?? "none"} on the page and ${h.short ?? "none"} in the help`,
        );
    const set = closedSet(h.value);
    if (set) {
      const values = forms.map((f) => f.value ?? "");
      if (values.length !== set.length || set.some((v) => !values.includes(v)))
        failures.push(
          `${label}: ${h.name} lists the values ${values.join(", ")}; the help has ${set.join(", ")}`,
        );
    } else if (forms.length > 1)
      failures.push(`${label}: the flag table lists ${h.name} ${forms.length} times`);
    else if (forms[0]?.value !== h.value)
      failures.push(
        `${label}: ${h.name} shows ${shown(forms[0]?.value ?? null)}; the help shows ${shown(h.value)}`,
      );
  }
  for (const name of new Set(onPage.map((f) => f.name)))
    if (!helpNames.has(name))
      failures.push(`${label}: the flag table lists ${name}, which the help lacks`);
  return failures;
}

/** The page's exit table against the help's exit lines: the same codes, in order, with the same text. */
function compareExits(
  label: string,
  help: readonly { code: string; says: string }[],
  rows: string[][],
): string[] {
  const failures: string[] = [];
  const page = new Map(rows.map((r) => [r[0] ?? "", r[1] ?? ""]));
  for (const h of help) {
    const says = page.get(h.code);
    if (says === undefined) failures.push(`${label}: the exit table lacks exit ${h.code}`);
    else if (says !== h.says)
      failures.push(`${label}: exit ${h.code} says "${says}"; the help says "${h.says}"`);
  }
  for (const code of page.keys())
    if (!help.some((h) => h.code === code))
      failures.push(`${label}: the exit table lists exit ${code}, which the help lacks`);
  // The order counts too: a reader reads the codes from 0 up, as the help prints them.
  const pageOrder = rows.map((r) => r[0] ?? "").filter((c) => help.some((h) => h.code === c));
  const helpOrder = help.map((h) => h.code).filter((c) => page.has(c));
  if (pageOrder.join(",") !== helpOrder.join(","))
    failures.push(
      `${label}: the exit table lists the codes ${pageOrder.join(", ")}; the help lists ${helpOrder.join(", ")}`,
    );
  return failures;
}

/**
 * The CLI holds to its pages (plan 11c, spec 19). For each `--help` output:
 * its docs link names a page of the build; the page's flag table lists
 * exactly the help's flags, with the same short forms and placeholders; and
 * the page's exit table has the help's exit lines word for word. Each code of
 * `authtempo check` has its anchor on the check page, so the fix of a code is
 * one link away.
 */
export function checkCli(
  files: ReadonlySet<string>,
  checkPage: string,
  runs: readonly HelpRun[],
  codes: readonly string[],
  pageSource: (url: string) => string | null,
): CheckReport {
  const r: CheckReport = {
    name: "check-cli",
    counts: { helps: 0, codes: codes.length, anchors: 0, flags: 0, exits: 0 },
    failures: [],
  };
  for (const run of runs) {
    const name = run.command === "" ? "authtempo" : `authtempo ${run.command}`;
    if (run.error !== null) {
      r.failures.push(`${name} --help failed: ${run.error}`);
      continue;
    }
    r.counts.helps = (r.counts.helps ?? 0) + 1;
    const help = parseHelp(run.output);
    const url = help.docs;
    if (url === null) {
      r.failures.push(`${name} --help prints no Docs line`);
      continue;
    }
    if (!url.startsWith(CLI_PAGES) || !url.endsWith("/")) {
      r.failures.push(`help link ${url} is not a page under ${CLI_PAGES}`);
      continue;
    }
    const file = `${url.slice(SITE_ORIGIN.length + 1)}index.html`;
    if (!files.has(file)) r.failures.push(`help link ${url} names no page of the build (${file})`);
    const label = url.slice(SITE_ORIGIN.length);
    const source = pageSource(label);
    if (source === null) {
      r.failures.push(`${label}: has no page source`);
      continue;
    }
    const flagRows = tableRows(source, "Flag");
    if (flagRows === null)
      r.failures.push(`${label}: has no flag table (a table whose first header is Flag)`);
    else r.failures.push(...compareFlags(label, help.flags, flagRows));
    r.counts.flags = (r.counts.flags ?? 0) + help.flags.length;
    const exitRows = tableRows(source, "Exit code");
    if (exitRows === null)
      r.failures.push(`${label}: has no exit table (a table whose first header is Exit code)`);
    else r.failures.push(...compareExits(label, help.exits, exitRows));
    r.counts.exits = (r.counts.exits ?? 0) + help.exits.length;
  }
  const ids = idsOf(checkPage);
  for (const code of codes) {
    if (ids.has(code)) r.counts.anchors = (r.counts.anchors ?? 0) + 1;
    else r.failures.push(`check code ${code} has no anchor on /docs/reference/cli/check/`);
  }
  return requireCounts(r, ["helps", "codes", "flags", "exits"]);
}
