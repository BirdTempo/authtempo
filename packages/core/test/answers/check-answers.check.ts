import { afterAll, describe, expect, it } from "vitest";
import { ROUTE_CONTRACT } from "../../src/http/contract/index.js";
import type { RouteContract } from "../../src/http/contract/types.js";
import { ROUTER_CODES, ROUTES, type RouteKey } from "../../src/http/route-list.js";
import { ANSWER_SHAPE_EXEMPT, ANSWERS_EXEMPT } from "../answers-exempt.js";
import { shapePaths } from "../setup/answer-shape.js";

/**
 * The check run of plan 11g Task 5. The recorder of `test/setup/answers.ts`
 * writes one line per answer of the router in `.answers/`. This run reads
 * them and holds the suite to `ROUTES`. Every route answered, every answer
 * fit its contract, and every declared code was answered or has a reason.
 * It runs after the test run, in `pnpm test`, with its own config.
 */

/** One line of a `.jsonl` file, as the recorder writes it. */
interface AnswerRecord {
  key: string | null;
  status: number;
  type: string;
  code: string | null;
  verdict: string;
  absent: string[];
  nulls: string[];
}

const DIR = new URL("../../.answers/", import.meta.url);

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
  if (Number.isNaN(ms)) throw new Error(`check-answers: .answers/start holds no time: ${text}`);
  return ms;
}

function readRecords(): { files: string[]; records: AnswerRecord[]; old: string[] } {
  const start = readStart();
  const files = readdirSync(DIR).filter((name) => name.endsWith(".jsonl"));
  const old: string[] = [];
  const records: AnswerRecord[] = [];
  for (const name of files) {
    const url = new URL(name, DIR);
    if (statSync(url).mtimeMs < start) old.push(name);
    for (const line of readFileSync(url, "utf8").split("\n")) {
      if (line.length > 0) records.push(JSON.parse(line) as AnswerRecord);
    }
  }
  return { files, records, old };
}

const { files, records, old } = readRecords();
const keys = ROUTES.map((r) => `${r.method} ${r.path}` as RouteKey);
const recorded = new Set(records.map((r) => r.key).filter((k) => k !== null));
/** `"<key> <code>"` of every code that a record holds. */
const answered = new Set(records.filter((r) => r.code !== null).map((r) => `${r.key} ${r.code}`));
/** `"<key> <code>"` of every declared code of every route, the router's codes included. */
const declared = ROUTES.flatMap((r) =>
  [...r.codes, ...r.oauthCodes, ...ROUTER_CODES].map((c) => `${r.method} ${r.path} ${c}`),
);
const exempt = new Set(ANSWERS_EXEMPT.map((row) => `${row.key} ${row.code}`));
const covered = declared.filter((d) => answered.has(d) || exempt.has(d));

/**
 * The optional and the nullable paths of each JSON answer, as the generator
 * writes them (rulings 8 and 9). A key outside `required` gives
 * `"<route> <status> <path> absent"`. A key whose schema admits null gives
 * `"<route> <status> <path> null"`. The walk goes through nested objects,
 * array items, and each branch of a union. A loosened schema adds a path
 * here that no record answers in that form, and the check fails on it. A
 * node that the walk cannot enter goes in `blocked`, and the check fails on
 * it by name.
 */
function shapesOf(): { shapes: string[]; blocked: string[] } {
  const contract: Record<string, RouteContract> = ROUTE_CONTRACT;
  const shapes: string[] = [];
  const blocked: string[] = [];
  for (const [key, c] of Object.entries(contract)) {
    for (const kind of c.alt ? [c.answer, c.alt] : [c.answer]) {
      if (kind.kind !== "json") continue;
      const status = kind.status ?? 200;
      const walked = shapePaths(kind.schema);
      for (const path of walked.paths) shapes.push(`${key} ${status} ${path}`);
      for (const line of walked.blocked) blocked.push(`${key} ${status}: ${line}`);
    }
  }
  return { shapes, blocked };
}

/** The id of an exempt shape row: the status of the route's json answer (200, or the register's 201). */
function shapeIdOf(row: { key: string; field: string; form: string }): string {
  const c = (ROUTE_CONTRACT as Record<string, RouteContract>)[row.key];
  const status = c?.answer.kind === "json" ? (c.answer.status ?? 200) : 200;
  return `${row.key} ${status} ${row.field} ${row.form}`;
}

const { shapes, blocked } = shapesOf();
/** `"<route> <status> <key> <form>"` of every shape a 2xx JSON record answers. */
const shaped = new Set(
  records.flatMap((r) => [
    ...r.absent.map((k) => `${r.key} ${r.status} ${k} absent`),
    ...r.nulls.map((k) => `${r.key} ${r.status} ${k} null`),
  ]),
);
const shapeExempt = new Set(ANSWER_SHAPE_EXEMPT.map((row) => shapeIdOf(row)));
const shapesCovered = shapes.filter((s) => shaped.has(s) || shapeExempt.has(s));

function fail(lines: string[]): void {
  for (const line of lines) console.error(`check-answers: FAIL ${line}`);
  expect(lines).toEqual([]);
}

afterAll(() => {
  console.log(
    `check-answers: routes=${recorded.size} of ${keys.length} answers=${records.length} codes=${covered.length} of ${declared.length} exempt=${ANSWERS_EXEMPT.length}`,
  );
  console.log(
    `check-shapes: keys=${shapesCovered.length} of ${shapes.length} exempt=${ANSWER_SHAPE_EXEMPT.length}`,
  );
});

describe("the answers of the test run (plan 11g)", () => {
  it("reads records that this run wrote", () => {
    fail(old.map((name) => `${name} is older than .answers/start`));
    expect(files.length).toBeGreaterThan(0);
    expect(records.length).toBeGreaterThan(0);
  });

  it("holds every answer to the route's codes and contract", () => {
    const bad = records.filter((r) => r.verdict !== "ok");
    fail(bad.map((r) => `${r.key} answered ${r.status} ${r.type}: ${r.verdict}`));
  });

  it("has an answer of every route of ROUTES", () => {
    fail(keys.filter((key) => !recorded.has(key)).map((key) => `${key} has no record`));
  });

  it("has a test that answers each declared code, or a row with the reason", () => {
    const gaps = declared.filter((d) => !answered.has(d) && !exempt.has(d));
    fail(
      gaps.map((d) => {
        const at = d.lastIndexOf(" ");
        return `${d.slice(0, at)} declares ${d.slice(at + 1)} and no test answers it`;
      }),
    );
  });

  it("enters every node of each JSON answer schema", () => {
    fail(blocked);
  });

  it("answers each optional key absent and each nullable key null at least once, or has a row", () => {
    const gaps = shapes.filter((s) => !shaped.has(s) && !shapeExempt.has(s));
    fail(
      gaps.map((s) => {
        const parts = s.split(" ");
        const [form, field, status] = [parts.pop(), parts.pop(), parts.pop()];
        const key = parts.join(" ");
        return form === "absent"
          ? `${key} never answers ${status} without ${field}, which its schema calls optional`
          : `${key} never answers ${status} with ${field} null, which its schema calls nullable`;
      }),
    );
  });

  it("needs every row of ANSWER_SHAPE_EXEMPT", () => {
    const known = new Set(shapes);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const row of ANSWER_SHAPE_EXEMPT) {
      const id = shapeIdOf(row);
      const calls = row.form === "absent" ? "optional" : "nullable";
      if (shaped.has(id)) lines.push(`the shape row ${id} is not needed: a test answers it`);
      if (!known.has(id))
        lines.push(`the shape row ${id} names a key the schema does not call ${calls}`);
      if (row.reason.trim() === "") lines.push(`the shape row ${id} has no reason`);
      if (seen.has(id)) lines.push(`the shape row ${id} is listed twice`);
      seen.add(id);
    }
    fail(lines);
  });

  it("needs every row of ANSWERS_EXEMPT", () => {
    const declaredSet = new Set(declared);
    const lines: string[] = [];
    for (const row of ANSWERS_EXEMPT) {
      const d = `${row.key} ${row.code}`;
      if (answered.has(d)) lines.push(`the row ${d} is not needed: a test answers it`);
      if (!declaredSet.has(d)) lines.push(`the row ${d} names a code the route does not declare`);
      if (row.reason.trim() === "") lines.push(`the row ${d} has no reason`);
    }
    const seen = new Set<string>();
    for (const row of ANSWERS_EXEMPT) {
      const d = `${row.key} ${row.code}`;
      if (seen.has(d)) lines.push(`the row ${d} is listed twice`);
      seen.add(d);
    }
    fail(lines);
  });
});
