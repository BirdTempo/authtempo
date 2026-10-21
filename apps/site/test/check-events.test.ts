import type { EventSpec } from "@authtempo/core/observe";
import { EVENTS } from "@authtempo/core/observe";
import { FIELD_KINDS } from "@authtempo/core/redact";
import { describe, expect, it } from "vitest";
import { checkEvents } from "../scripts/check-events.ts";
import { distPageOrEmpty } from "../scripts/lib/load.ts";

// Three rows in the form of the events page: a flow event, a fault event, and one with no field.
const SPECS: Readonly<Record<string, EventSpec>> = {
  "limit.hit": {
    level: "warn",
    fields: { family: { kind: "enum", values: ["otp:ip", "otp:email"] } },
  },
  "user.hold_gave_up": {
    level: "error",
    fields: { userId: { kind: "id" }, code: { kind: "code", optional: true } },
    line: { method: "error", text: "authtempo: user hold gave up", args: () => [] },
  },
  "passkey.counter_moved": {
    level: "error",
    fields: {},
    line: { method: "error", text: "authtempo: passkey counter moved", args: () => [] },
  },
};
const KINDS = ["id", "enum", "code"];

const code = (s: string) => `<code dir="auto">${s}</code>`;
const table = (heads: string[], rows: string[][]) =>
  `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

const FLOW_ROW = [code("limit.hit"), "warn", code("family: enum"), "A limiter refuses a call."];
const FAULT_ROWS = [
  [
    code("user.hold_gave_up"),
    "error",
    `${code("userId: id")}, ${code("code?: code")}`,
    code("authtempo: user hold gave up"),
  ],
  [code("passkey.counter_moved"), "error", "none", code("authtempo: passkey counter moved")],
];
const LIST_ROW = [code("limit.hit.family"), `${code("otp:ip")}, ${code("otp:email")}`];
const KIND_ROWS = KINDS.map((k) => [code(k), "x"]);

function eventsPage(
  flow = [FLOW_ROW],
  faults = FAULT_ROWS,
  lists = [LIST_ROW],
  kinds = KIND_ROWS,
): string {
  return [
    table(["Event", "Level", "Fields", "When"], flow),
    table(["Event", "Level", "Fields", "Default line"], faults),
    table(["Field", "Values"], lists),
    table(["Kind", "What it holds"], kinds),
  ].join("\n");
}

const LINE_ROWS = [
  [code("authtempo: user hold gave up"), code("user.hold_gave_up"), "Watch."],
  [code("authtempo: passkey counter moved"), code("passkey.counter_moved"), "Watch."],
  [code("authtempo compat: &lt;note&gt;"), "none", "Read once."],
  [code("authtempo: cognito legacy verify failed &lt;reason&gt;"), "none", "Act."],
];
const linesPage = (rows = LINE_ROWS) => table(["Line", "Event", "What to do"], rows);

describe("checkEvents", () => {
  it("passes when the events page has one row for each event", () => {
    const r = checkEvents(linesPage(), eventsPage(), SPECS, KINDS);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ events: 3, rows: 3, lines: 2, lists: 1, kinds: 3 });
    expect(r.exempt).toEqual([
      "authtempo compat: <note>: a line of @authtempo/compat-better-auth, which has no observer",
      "authtempo: cognito legacy verify failed <reason>: a line of @authtempo/legacy-hashes, outside core",
    ]);
  });

  it("passes on the real build", () => {
    const r = checkEvents(
      distPageOrEmpty("/docs/operations/observability/"),
      distPageOrEmpty("/docs/reference/events/"),
      EVENTS,
      Object.keys(FIELD_KINDS),
    );
    expect(r.failures).toEqual([]);
    expect(r.counts.rows).toBe(r.counts.events);
  });

  it("fails on a missing row and on an extra row", () => {
    const extra = [code("limit.miss"), "warn", "none", "x"];
    const r = checkEvents(linesPage(), eventsPage([extra]), SPECS, KINDS);
    expect(r.failures).toEqual(["row limit.miss names no event", "event limit.hit has no row"]);
  });

  it("fails on a wrong level, a wrong field, a wrong line, and a second row", () => {
    const faults = [
      [code("user.hold_gave_up"), "warn", code("userId: id"), code("authtempo: user hold failed")],
      FAULT_ROWS[1] ?? [],
      FAULT_ROWS[1] ?? [],
    ];
    const r = checkEvents(linesPage(), eventsPage([FLOW_ROW], faults), SPECS, KINDS);
    expect(r.failures).toEqual([
      "event user.hold_gave_up: level warn; the code says error",
      "event user.hold_gave_up: fields userId: id; the code says userId: id, code?: code",
      "event user.hold_gave_up: default line authtempo: user hold failed; the code says authtempo: user hold gave up",
      "event passkey.counter_moved has two rows",
    ]);
  });

  it("fails on a closed list that differs from the code, and on a kind with no row", () => {
    const lists = [[code("limit.hit.family"), code("otp:ip")]];
    const r = checkEvents(linesPage(), eventsPage([FLOW_ROW], FAULT_ROWS, lists), SPECS, [
      ...KINDS,
      "hash",
    ]);
    expect(r.failures).toEqual([
      "closed list limit.hit.family: values otp:ip; the code says otp:ip, otp:email",
      "field kind hash has no row",
    ]);
  });

  it("fails on a list row that names no enum field, and on an enum field with no list row", () => {
    const lists = [[code("limit.hit.kind"), code("otp:ip")]];
    const r = checkEvents(linesPage(), eventsPage([FLOW_ROW], FAULT_ROWS, lists), SPECS, KINDS);
    expect(r.failures).toEqual([
      "closed list limit.hit.kind names no enum field",
      "enum field limit.hit.family has no closed list row",
    ]);
  });

  it("fails on a second row for one closed list", () => {
    const r = checkEvents(
      linesPage(),
      eventsPage([FLOW_ROW], FAULT_ROWS, [LIST_ROW, LIST_ROW]),
      SPECS,
      KINDS,
    );
    expect(r.failures).toEqual(["closed list limit.hit.family has two rows"]);
  });

  it("fails on a kind row that names no field kind", () => {
    const kinds = [...KIND_ROWS, [code("hash"), "x"]];
    const r = checkEvents(
      linesPage(),
      eventsPage([FLOW_ROW], FAULT_ROWS, [LIST_ROW], kinds),
      SPECS,
      KINDS,
    );
    expect(r.failures).toEqual(["row hash names no field kind"]);
  });

  it("holds a long closed list to its count of values", () => {
    // 17 values, one over the most that the page lists one by one.
    const values = Array.from({ length: 17 }, (_, i) => `f${i}`);
    const specs = {
      ...SPECS,
      "limit.hit": { level: "warn", fields: { family: { kind: "enum", values } } },
    } as const;
    const page = (cell: string) =>
      eventsPage([FLOW_ROW], FAULT_ROWS, [[code("limit.hit.family"), cell]]);
    expect(
      checkEvents(linesPage(), page("17 values, from f0 to f16."), specs, KINDS).failures,
    ).toEqual([]);
    expect(
      checkEvents(linesPage(), page("16 values, from f0 to f15."), specs, KINDS).failures,
    ).toEqual(['closed list limit.hit.family: the cell must start with "17 values"']);
  });

  it("fails on a second row for one default line", () => {
    const r = checkEvents(
      linesPage([...LINE_ROWS, LINE_ROWS[0] ?? []]),
      eventsPage(),
      SPECS,
      KINDS,
    );
    expect(r.failures).toEqual(['the line "authtempo: user hold gave up" has two rows']);
  });

  it("holds the default lines of the observability page to the fault lines", () => {
    const rows = [
      [code("authtempo: user hold gave in"), code("user.hold_gave_up"), "Watch."],
      [code("authtempo: passkey counter moved"), code("user.hold_gave_up"), "Watch."],
    ];
    const r = checkEvents(linesPage(rows), eventsPage(), SPECS, KINDS);
    expect(r.failures).toEqual([
      'the line "authtempo: user hold gave in" is no default line of core',
      'the line "authtempo: passkey counter moved" names the event user.hold_gave_up; the code says passkey.counter_moved',
      'the default line "authtempo: user hold gave up" of user.hold_gave_up has no row',
    ]);
  });

  it("fails at zero rows", () => {
    const r = checkEvents("", "", {}, []);
    expect(r.failures).toEqual([
      "read 0 events",
      "read 0 rows",
      "read 0 lines",
      "read 0 lists",
      "read 0 kinds",
    ]);
  });
});
