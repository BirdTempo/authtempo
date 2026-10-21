import type { EventSpec, FieldSpec } from "@authtempo/core/observe";
import { COGNITO_FAILURE_LOG } from "@authtempo/legacy-hashes/cognito";
import { cellCodes, cellText, tableRows } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** An enum field shows each value of its closed list when the list holds at most this many. */
export const LISTED_MAX = 16;

/** The prefix of each line of the compatibility package. */
const COMPAT_PREFIX = "authtempo compat:";

/** The code span of one field in the Fields cell: `name: kind`, or `name?: kind` when it is optional. */
export function fieldCode(name: string, spec: FieldSpec): string {
  return `${name}${spec.optional ? "?" : ""}: ${spec.kind}`;
}

/** The Values cell of a closed list: each value, or the count of a long list. */
export function listedValues(values: readonly string[]): string[] | number {
  return values.length <= LISTED_MAX ? [...values] : values.length;
}

/** The first code span of a cell, or its text when it has none. */
function firstCode(cell: string | undefined): string {
  return cellCodes(cell ?? "")[0] ?? cellText(cell ?? "");
}

/**
 * The events page against `EVENTS`, both ways: one row for each event with
 * its level, its fields with their kinds, and its default line. Each enum
 * field has one row in the closed lists, and each field kind one row. The
 * table "The default lines" of the observability page holds each default
 * line of core, by its text and its event (plan 12h Task 13).
 */
export function checkEvents(
  html: string,
  eventsHtml: string,
  events: Readonly<Record<string, EventSpec>>,
  kinds: readonly string[],
): CheckReport {
  const names = Object.keys(events);
  const faults = names.filter((n) => events[n]?.line !== undefined);
  const r: CheckReport = {
    name: "check-events",
    counts: { events: names.length, rows: 0, lines: faults.length, lists: 0, kinds: kinds.length },
    failures: [],
    exempt: [],
  };

  const seen = new Set<string>();
  for (const row of tableRows(eventsHtml, "Event")) {
    r.counts.rows = (r.counts.rows ?? 0) + 1;
    const name = firstCode(row.Event);
    const spec = Object.hasOwn(events, name) ? events[name] : undefined;
    if (!spec) {
      r.failures.push(`row ${name} names no event`);
      continue;
    }
    if (seen.has(name)) r.failures.push(`event ${name} has two rows`);
    seen.add(name);
    const level = cellText(row.Level ?? "");
    if (level !== spec.level)
      r.failures.push(`event ${name}: level ${level}; the code says ${spec.level}`);
    const fields = cellCodes(row.Fields ?? "").join(", ");
    const want = Object.entries(spec.fields)
      .map(([f, s]) => fieldCode(f, s))
      .join(", ");
    if (fields !== want) r.failures.push(`event ${name}: fields ${fields}; the code says ${want}`);
    const line = "Default line" in row ? firstCode(row["Default line"]) : null;
    if (spec.line && line !== spec.line.text)
      r.failures.push(`event ${name}: default line ${line}; the code says ${spec.line.text}`);
    if (!spec.line && line !== null && line !== "none")
      r.failures.push(`event ${name}: default line ${line}; the code has none`);
  }
  for (const n of names) if (!seen.has(n)) r.failures.push(`event ${n} has no row`);

  // The closed lists: one row for each enum field, `<event>.<field>`.
  const lists = new Map<string, readonly string[]>();
  for (const [n, spec] of Object.entries(events))
    for (const [f, s] of Object.entries(spec.fields))
      if (s.kind === "enum") lists.set(`${n}.${f}`, s.values ?? []);
  const listed = new Set<string>();
  for (const row of tableRows(eventsHtml, "Field")) {
    r.counts.lists = (r.counts.lists ?? 0) + 1;
    const key = firstCode(row.Field);
    const values = lists.get(key);
    if (!values) {
      r.failures.push(`closed list ${key} names no enum field`);
      continue;
    }
    if (listed.has(key)) r.failures.push(`closed list ${key} has two rows`);
    listed.add(key);
    const want = listedValues(values);
    const cell = row.Values ?? "";
    if (typeof want === "number") {
      if (!cellText(cell).startsWith(`${want} values`))
        r.failures.push(`closed list ${key}: the cell must start with "${want} values"`);
    } else if (cellCodes(cell).join(", ") !== want.join(", "))
      r.failures.push(
        `closed list ${key}: values ${cellCodes(cell).join(", ")}; the code says ${want.join(", ")}`,
      );
  }
  for (const key of lists.keys())
    if (!listed.has(key)) r.failures.push(`enum field ${key} has no closed list row`);

  const kindRows = tableRows(eventsHtml, "Kind").map((row) => firstCode(row.Kind));
  for (const k of kinds) if (!kindRows.includes(k)) r.failures.push(`field kind ${k} has no row`);
  for (const k of kindRows) if (!kinds.includes(k)) r.failures.push(`row ${k} names no field kind`);

  // The default lines. Each row that starts with `authtempo:` is a line of
  // core, with its event. Two other packages write lines in the same table.
  const byText = new Map(faults.map((n) => [events[n]?.line?.text ?? "", n]));
  const found = new Set<string>();
  for (const row of tableRows(html, "Line")) {
    const text = firstCode(row.Line);
    if (text.startsWith(COMPAT_PREFIX)) {
      r.exempt?.push(`${text}: a line of @authtempo/compat-better-auth, which has no observer`);
      continue;
    }
    if (text.startsWith(COGNITO_FAILURE_LOG)) {
      r.exempt?.push(`${text}: a line of @authtempo/legacy-hashes, outside core`);
      continue;
    }
    const name = byText.get(text);
    if (name === undefined) {
      r.failures.push(`the line "${text}" is no default line of core`);
      continue;
    }
    if (found.has(text)) r.failures.push(`the line "${text}" has two rows`);
    found.add(text);
    const event = firstCode(row.Event);
    if (event !== name)
      r.failures.push(`the line "${text}" names the event ${event}; the code says ${name}`);
  }
  for (const [text, name] of byText)
    if (!found.has(text)) r.failures.push(`the default line "${text}" of ${name} has no row`);
  return requireCounts(r, ["events", "rows", "lines", "lists", "kinds"]);
}
