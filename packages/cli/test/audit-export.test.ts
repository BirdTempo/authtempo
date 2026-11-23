// `authtempo audit export` (plan 13b Task 8): the audit rows of one
// organization as NDJSON or CSV. A stub server answers the pages of
// `GET /operator/audit`, so a row can hold a comma, a quote, a line break,
// or a formula, which core does not write itself.
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const SECRET = "operator-auditor-0123456789abcdef-0123";
const ORG = "01J8Z3Q4R5S6T7V8W9X0Y1ORGA";
const AT = "2026-11-23T00:00:00.000Z";
const NOTE =
  "the organization audit starts at schema version 18; rows before it have no organization";
const HEADER =
  "id,createdAt,actorKind,actorId,action,targetUserId,organizationId,reason,data,ip,userAgent";

/** One row of `GET /operator/audit`, with the keys of the answer schema. */
function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    actorKind: "user",
    actorId: "01J8Z3Q4R5S6T7V8W9X0Y1USR1",
    action: "organization_member_add",
    targetUserId: "01J8Z3Q4R5S6T7V8W9X0Y1USR2",
    reason: "member added",
    data: { role: "member" },
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    organizationId: ORG,
    ...over,
  };
}

/**
 * A stub server with two pages: the first page without `after`, the second
 * page after the last id of the first. It keeps each request URL.
 */
function stub(first: Record<string, unknown>[], second: Record<string, unknown>[]) {
  const urls: URL[] = [];
  const fetch = async (url: string) => {
    const u = new URL(url);
    urls.push(u);
    const after = u.searchParams.get("after");
    const last = first.at(-1)?.id as string;
    if (after === null) return Response.json({ rows: first, next: last });
    if (after === last) return Response.json({ rows: second, next: null });
    return Response.json({ rows: [], next: null });
  };
  return { fetch, urls };
}

async function run(args: string[], fetch: (url: string) => Promise<Response>) {
  const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET }, fetch });
  const code = await main(["audit", "export", BASE, ...args], io);
  return { code, io };
}

/** An RFC 4180 reader: the records of a text, each record a list of cells. */
function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else if (c === "\n") {
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = "";
    } else cell += c;
  }
  cells.push(cell);
  records.push(cells);
  return records;
}

/** The CSV cells of a row, in the column order of the contract. */
function cellsOf(r: Record<string, unknown>): string[] {
  const text = (v: unknown) => (v === null ? "" : String(v));
  return [
    text(r.id),
    text(r.createdAt),
    text(r.actorKind),
    text(r.actorId),
    text(r.action),
    text(r.targetUserId),
    text(r.organizationId),
    text(r.reason),
    r.data === null ? "" : JSON.stringify(r.data),
    text(r.ip),
    text(r.userAgent),
  ];
}

describe("authtempo audit export (plan 13b Task 8)", () => {
  it("ndjson: prints one JSON object per line over two pages, in two requests", async () => {
    const first = [row("a1"), row("a2", { data: null, ip: null, userAgent: null })];
    const second = [row("a3", { targetUserId: null })];
    const s = stub(first, second);
    const { code, io } = await run(["--organization", ORG, "--format", "ndjson"], s.fetch);
    expect(code, io.stderr.join("\n")).toBe(0);
    expect(io.stdout.map((l) => JSON.parse(l))).toEqual([...first, ...second]);
    expect(s.urls).toHaveLength(2);
    for (const u of s.urls) {
      expect(u.pathname).toBe("/auth/operator/audit");
      expect(u.searchParams.get("organizationId")).toBe(ORG);
    }
    expect(s.urls[1]?.searchParams.get("after")).toBe("a2");
    expect(io.stderr).toEqual([NOTE]);
  });

  it("csv: prints the header line, then quoted cells that a CSV reader reads back equal", async () => {
    const first = [
      row("a1", { reason: 'moved, then "fixed"\nby hand' }),
      row("a2", { data: { note: 'a "b", c' }, ip: null }),
    ];
    const second = [row("a3", { userAgent: "Agent, 1.0", data: null })];
    const s = stub(first, second);
    const { code, io } = await run(["--organization", ORG, "--format", "csv"], s.fetch);
    expect(code, io.stderr.join("\n")).toBe(0);
    expect(io.stdout[0]).toBe(HEADER);
    const records = readCsv(io.stdout.join("\n"));
    expect(records).toEqual([HEADER.split(","), ...[...first, ...second].map(cellsOf)]);
    // The cell with a line break spans two output lines inside its quotes.
    expect(io.stdout).toHaveLength(5);
    expect(io.stdout[1]).toContain('"moved, then ""fixed""');
    expect(io.stderr).toEqual([NOTE]);
  });

  it("injection: a cell that starts with a formula character gets a leading quote", async () => {
    const formula = '=HYPERLINK("x")';
    const s = stub([row("a1", { userAgent: formula })], []);
    const { code, io } = await run(["--organization", ORG, "--format", "csv"], s.fetch);
    expect(code, io.stderr.join("\n")).toBe(0);
    const cell = readCsv(io.stdout.join("\n"))[1]?.[10];
    expect(cell).toBe(`'${formula}`);
    expect(cell?.startsWith("'=")).toBe(true);
    // Each lead of the OWASP rule, in a column that core fills from the request.
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const t = stub([row("a1", { reason: `${lead}1+1` })], []);
      const r = await run(["--organization", ORG, "--format", "csv"], t.fetch);
      const reason = readCsv(r.io.stdout.join("\n"))[1]?.[7];
      expect(reason?.startsWith("'"), JSON.stringify(lead)).toBe(true);
    }
  });

  it("no format: a usage error with exit 2 and no request", async () => {
    for (const format of [[], ["--format", "xml"]]) {
      const s = stub([row("a1")], []);
      const { code, io } = await run(["--organization", ORG, ...format], s.fetch);
      expect(code).toBe(2);
      expect(io.stderr[0]).toBe("give --format ndjson or --format csv");
      expect(io.stdout).toEqual([]);
      expect(s.urls).toEqual([]);
    }
  });

  it("no org: a usage error with exit 2 and no request", async () => {
    const s = stub([row("a1")], []);
    const { code, io } = await run(["--format", "ndjson"], s.fetch);
    expect(code).toBe(2);
    expect(io.stderr[0]).toBe("give --organization <id>: the export reads one organization");
    expect(io.stdout).toEqual([]);
    expect(s.urls).toEqual([]);
  });

  it("max calls: --max-calls 1 makes one request and exits as audit list exits on a cut", async () => {
    const first = [row("a1"), row("a2")];
    const s = stub(first, [row("a3")]);
    const { code, io } = await run(
      ["--organization", ORG, "--format", "ndjson", "--max-calls", "1"],
      s.fetch,
    );
    expect(s.urls).toHaveLength(1);
    expect(io.stdout.map((l) => JSON.parse(l))).toEqual(first);
    expect(io.stderr.at(-1)).toBe(
      "warning: the read reached --max-calls 1 with more rows; give --after a2 to read on",
    );
    const list = stub(first, [row("a3")]);
    const listIo = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET }, fetch: list.fetch });
    const listCode = await main(["audit", "list", BASE, "--all", "--max-calls", "1"], listIo);
    expect(listCode).toBe(1);
    expect(code).toBe(listCode);
  });

  it("secret: the secret from the environment is in no output line", async () => {
    for (const format of ["ndjson", "csv"]) {
      const s = stub([row("a1", { reason: SECRET })], [row("a2", { userAgent: SECRET })]);
      const { code, io } = await run(["--organization", ORG, "--format", format], s.fetch);
      expect(code, format).toBe(0);
      expect(io.stdout.length, format).toBeGreaterThan(1);
      for (const line of [...io.stdout, ...io.stderr]) expect(line, format).not.toContain(SECRET);
    }
  });
});
