import { afterAll, describe, expect, it } from "vitest";
import { ROUTES } from "../../src/http/route-list.js";
import { LIMIT_FAMILIES } from "../../src/limiter/limit.js";
import { EVENTS, type EventName } from "../../src/observe/events.js";
import type { AuthEvent } from "../../src/observe/port.js";
import { EVENTS_EXEMPT } from "../events-exempt.js";

/**
 * The check run of plan 12h Task 12. The recorder of `test/setup/events.ts`
 * writes one line per event of the suite in `.events/`, as a sink of its
 * config gets it. The helpers and the scopes of the suite write the secrets,
 * the credentials, and the addresses of the run in `credentials-*.jsonl`.
 * This run reads both and holds the suite to `EVENTS`, `ROUTES`,
 * `LIMIT_FAMILIES`, and spec 31 items 7 and 8. It never prints a value of
 * the credentials files. It runs after the test runs, in `pnpm test`.
 */

/** One line of an event file, as the recorder writes it. */
interface EventRecord {
  include: { ip: string; userAgent: string; email: string };
  event: AuthEvent;
}

/** One line of a credentials file. */
interface Held {
  kind: "secret" | "credential" | "address";
  value: string;
}

const DIR = new URL("../../.events/", import.meta.url);

/** Core's typecheck has no Node types (core runs on Workers); the specifier in a constant keeps node:fs out of it. */
interface ReadFs {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
  statSync(file: URL): { mtimeMs: number };
}
const FS_MODULE = "node:fs";
const { readdirSync, readFileSync, statSync }: ReadFs = await import(/* @vite-ignore */ FS_MODULE);

function readStart(): number {
  const text = readFileSync(new URL("start", DIR), "utf8").trim();
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`check-events: .events/start holds no time: ${text}`);
  return ms;
}

function lines<T>(name: string): T[] {
  return readFileSync(new URL(name, DIR), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function readAll() {
  const start = readStart();
  const files = readdirSync(DIR).filter((name) => name.endsWith(".jsonl"));
  const old = files.filter((name) => statSync(new URL(name, DIR)).mtimeMs < start);
  const records: EventRecord[] = [];
  const held: Held[] = [];
  for (const name of files) {
    if (name.startsWith("credentials-")) held.push(...lines<Held>(name));
    else records.push(...lines<EventRecord>(name));
  }
  return { files, old, records, held };
}

const { files, old, records, held } = readAll();

/** A value shorter than this, such as a 6-digit code, is matched against a whole field value only. */
const WINDOW = 8;

/**
 * A finder for many values at once. A value of `WINDOW` characters or more
 * matches as a substring of the JSON of a record. A shorter value matches a
 * string field that equals it, because a random trace id holds any short
 * run of digits.
 */
function finder(values: Iterable<string>) {
  const long = new Map<string, string[]>();
  const short = new Set<string>();
  for (const value of new Set(values)) {
    if (value.length < WINDOW) {
      short.add(value);
      continue;
    }
    const head = value.slice(0, WINDOW);
    long.set(head, [...(long.get(head) ?? []), value]);
  }
  return (record: AuthEvent): boolean => {
    const json = JSON.stringify(record);
    for (let i = 0; i + WINDOW <= json.length; i++) {
      const found = long.get(json.slice(i, i + WINDOW));
      if (found?.some((value) => json.startsWith(value, i))) return true;
    }
    return Object.values(record).some((v) => typeof v === "string" && short.has(v));
  };
}

const valuesOf = (kind: Held["kind"]) => held.filter((h) => h.kind === kind).map((h) => h.value);
const denied = finder([...valuesOf("secret"), ...valuesOf("credential")]);
const addresses = valuesOf("address");
const emails = finder(addresses.filter((a) => a.includes("@")));
const others = finder(addresses.filter((a) => !a.includes("@")));

const NAMES = Object.keys(EVENTS) as EventName[];
const KEYS = ROUTES.map((r) => `${r.method} ${r.path}`);
const named = new Set(records.map((r) => r.event.name));
const exempt = new Set(EVENTS_EXEMPT.map((row) => row.name));
const covered = NAMES.filter((name) => named.has(name) || exempt.has(name));
const routed = new Set(records.filter((r) => r.event.name === "request").map((r) => r.event.route));
const routes = KEYS.filter((key) => routed.has(key));
const hit = new Set(records.filter((r) => r.event.name === "limit.hit").map((r) => r.event.family));
const families = LIMIT_FAMILIES.filter((family) => hit.has(family));
const rejected = records.filter((r) => (r.event.rejected ?? []).length > 0);

/** The include of a config with no `observe`. Only under it may no record hold an IP or an agent. */
const isDefault = (r: EventRecord) =>
  r.include.ip === "none" && r.include.userAgent === "none" && r.include.email === "none";

/** The name and the route of a record, for a failure line. It holds no value of the record. */
const where = (r: EventRecord) => `${r.event.name} at ${r.event.route ?? "no route"}`;

function fail(lines: string[]): void {
  for (const line of lines) console.error(`check-events: FAIL ${line}`);
  expect(lines).toEqual([]);
}

afterAll(() => {
  console.log(
    `check-events: events=${covered.length} of ${NAMES.length} routes=${routes.length} of ${KEYS.length} families=${families.length} of ${LIMIT_FAMILIES.length} records=${records.length} rejected=${rejected.length}`,
  );
});

describe("the events of the test run (plan 12h)", () => {
  it("reads records that this run wrote", () => {
    fail(old.map((name) => `${name} is older than .events/start`));
    expect(files.length).toBeGreaterThan(0);
    expect(records.length).toBeGreaterThan(0);
  });

  it("has a record of each event of EVENTS, or a row with the reason", () => {
    fail(
      NAMES.filter((name) => !named.has(name) && !exempt.has(name)).map(
        (name) => `${name} is an event with no record and no row of EVENTS_EXEMPT`,
      ),
    );
  });

  it("needs every row of EVENTS_EXEMPT", () => {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const row of EVENTS_EXEMPT) {
      if (named.has(row.name)) lines.push(`the row ${row.name} is not needed: a record holds it`);
      if (row.reason.trim() === "") lines.push(`the row ${row.name} has no reason`);
      if (seen.has(row.name)) lines.push(`the row ${row.name} is listed twice`);
      seen.add(row.name);
    }
    fail(lines);
  });

  it("has a request record of each route of ROUTES", () => {
    fail(KEYS.filter((key) => !routed.has(key)).map((key) => `${key} has no request record`));
  });

  it("has a limit.hit record of each family of LIMIT_FAMILIES", () => {
    fail(
      LIMIT_FAMILIES.filter((family) => !hit.has(family)).map(
        (family) => `${family} has no limit.hit record`,
      ),
    );
  });

  it("has no record with a rejected field or the unscoped mark", () => {
    fail(rejected.map((r) => `${where(r)} rejected ${(r.event.rejected ?? []).join(", ")}`));
  });

  it("has no record that holds a secret or a credential of the run", () => {
    expect(valuesOf("secret").length).toBeGreaterThan(0);
    expect(valuesOf("credential").length).toBeGreaterThan(0);
    fail(
      records
        .filter((r) => denied(r.event))
        .map((r) => `${where(r)} holds a secret or a credential`),
    );
  });

  it("has no record that holds an address with the default include, and no email in any mode", () => {
    expect(addresses.length).toBeGreaterThan(0);
    fail(
      records
        .filter((r) => emails(r.event) || (isDefault(r) && others(r.event)))
        .map((r) => `${where(r)} holds an address of a request`),
    );
  });
});
