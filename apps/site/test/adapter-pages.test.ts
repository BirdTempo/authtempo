import { readFileSync } from "node:fs";
import { MYSQL_MIGRATIONS } from "@authtempo/adapter-mysql";
import { type ModelName, schema } from "@authtempo/core";
import { columnType, MYSQL_KEY_LIMIT_BYTES, MYSQL_STRINGS } from "@authtempo/core/ddl";
import { MYSQL } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The tables of the SQLite and MySQL pages copy facts of the code (plan 12g
// Task 9). The site has no build step that writes a table from code, so this
// test holds each copy equal to its source. A change on one side only fails here.

const SQLITE_GUIDE = `${DOCS}docs/guides/sqlite.mdx`;
const MYSQL_GUIDE = `${DOCS}docs/guides/mysql.mdx`;
const SCHEMA_PAGE = `${DOCS}docs/reference/schema.md`;

/** The lines of the `## <heading>` part, up to the next `## ` heading. */
function part(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) throw new Error(`no heading "## ${heading}"`);
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

/** The body rows of the first table in the lines, as lists of cells. */
function tableRows(lines: readonly string[]): string[][] {
  const table = lines.filter((l) => l.startsWith("| "));
  // The first row is the head, and the second is the rule.
  return table.slice(2).map((l) =>
    l
      .slice(2, -2)
      .split(" | ")
      .map((c) => c.trim()),
  );
}

/** The names in backticks of one cell. */
function codes(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** A package.json of the repo. */
function packageJson(dir: string): {
  exports: Record<string, unknown>;
  engines?: { node?: string };
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
} {
  return JSON.parse(readFileSync(`${REPO}packages/${dir}/package.json`, "utf8"));
}

/** "22.13" from ">=22.13". */
function nodeFloor(dir: string): string {
  const range = packageJson(dir).engines?.node ?? "";
  const m = /^>=(\d+(?:\.\d+)?)$/.exec(range);
  if (!m?.[1]) throw new Error(`packages/${dir} has no engines.node of the form >=N: ${range}`);
  return m[1];
}

describe("the length bounds of the MySQL guide (plan 12g Task 9)", () => {
  const rows = tableRows(part(readFileSync(MYSQL_GUIDE, "utf8"), "Length bounds"));

  it("lists each row of MYSQL_STRINGS once, with its length, character set, and prefix", () => {
    const page = rows.map(([field = "", length, charset, prefix]) => ({
      field: codes(field)[0] ?? field,
      length,
      charset,
      prefix,
    }));
    const code = Object.entries(MYSQL_STRINGS).map(([field, row]) => ({
      field,
      length: String(row.length),
      charset: row.charset,
      prefix: row.prefix === undefined ? "none" : String(row.prefix),
    }));
    expect(page).toEqual(code);
  });
});

describe("the MySQL column types of the schema page (plan 12g Task 9)", () => {
  const text = readFileSync(SCHEMA_PAGE, "utf8");
  const rows = tableRows(part(text, "MySQL column types"));
  const cell = (type: string) => rows.find((r) => r[0] === type)?.[1] ?? "";

  /** Every field of the schema, with its type. */
  const fields = (Object.keys(schema) as ModelName[]).flatMap((model) =>
    Object.entries(schema[model].fields as Record<string, { type: string; int64?: boolean }>).map(
      ([field, def]) => ({ model, field, ...def }),
    ),
  );

  it("states the column of each field type as columnType answers it", () => {
    const of = (f: { model: ModelName; field: string }) => columnType(MYSQL, f.model, f.field);
    const strings = fields.filter((f) => f.type === "string");
    for (const f of strings) {
      const row = MYSQL_STRINGS[`${f.model}.${f.field}`];
      const set =
        row?.charset === "ascii" ? "ascii COLLATE ascii_bin" : "utf8mb4 COLLATE utf8mb4_0900_bin";
      expect(of(f), `${f.model}.${f.field}`).toBe(
        row === undefined ? "TEXT" : `VARCHAR(${row.length}) CHARACTER SET ${set}`,
      );
    }
    expect(codes(cell("string in `MYSQL_STRINGS`"))).toEqual([
      "VARCHAR(<length>) CHARACTER SET ascii COLLATE ascii_bin",
      "utf8mb4",
      "utf8mb4_0900_bin",
    ]);
    expect(codes(cell("any other string"))).toEqual(["TEXT"]);
    for (const [type, column] of [
      ["boolean", "TINYINT(1)"],
      ["date", "BIGINT"],
      ["json", "JSON"],
    ] as const) {
      expect(new Set(fields.filter((f) => f.type === type).map(of)), type).toEqual(
        new Set([column]),
      );
      expect(codes(cell(type))[0], type).toBe(column);
    }
    const ints = fields.filter((f) => f.type === "integer");
    expect(ints.filter((f) => of(f) === "BIGINT").map((f) => f.field)).toEqual([
      "counter",
      "lastStep",
    ]);
    expect(new Set(ints.filter((f) => !f.int64).map(of))).toEqual(new Set(["INT"]));
    expect(codes(cell("integer"))).toEqual(["INT", "BIGINT", "counter", "lastStep"]);
  });

  it("states the InnoDB key limit of the ddl entry", () => {
    const row = tableRows(part(text, "The ddl entry")).find(
      (r) => r[0] === "`MYSQL_KEY_LIMIT_BYTES`",
    );
    expect(row?.[1]?.startsWith(`${MYSQL_KEY_LIMIT_BYTES},`)).toBe(true);
  });
});

describe("the drivers table of the SQLite guide (plan 12g Task 9)", () => {
  const text = readFileSync(SQLITE_GUIDE, "utf8");
  const rows = tableRows(part(text, "The drivers"));
  const pkg = packageJson("adapter-sqlite");

  it("lists each driver entry of the package once", () => {
    expect(rows.map((r) => codes(r[0] ?? "")[0])).toEqual(
      Object.keys(pkg.exports)
        .filter((e) => e !== ".")
        .map((e) => `@authtempo/adapter-sqlite/${e.slice(2)}`),
    );
  });

  it("names each peer dependency, optional as the package says, and no other", () => {
    const named = rows.flatMap((r) => {
      const peer = r[3] ?? "";
      if (peer === "none") return [];
      const [name = ""] = codes(peer);
      return [{ name, optional: peer.endsWith("(optional)") }];
    });
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    expect(named.sort(byName)).toEqual(
      Object.keys(pkg.peerDependencies ?? {})
        .map((name) => ({ name, optional: pkg.peerDependenciesMeta?.[name]?.optional === true }))
        .sort(byName),
    );
  });

  it("states the Node floor of the package", () => {
    const floor = nodeFloor("adapter-sqlite");
    expect(part(text, "Before you start")[1]).toBe(
      `- Node ${floor} or newer, or Bun 1.4.3, the tested version.`,
    );
    expect(rows[0]?.[2]).toBe(`Node ${floor} or newer`);
  });
});

describe("the facts of the MySQL guide (plan 12g Task 9)", () => {
  const text = readFileSync(MYSQL_GUIDE, "utf8");
  const source = (file: string) =>
    readFileSync(`${REPO}packages/adapter-mysql/src/${file}`, "utf8");

  it("states the Node floor of the package", () => {
    expect(part(text, "Before you start")[1]).toBe(
      `- Node ${nodeFloor("adapter-mysql")} or newer.`,
    );
  });

  it("quotes each message of the checks at start as the code writes it", () => {
    const checks = part(text, "The checks at start").join("\n");
    const quoted = [...checks.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(quoted.length).toBe(2);
    for (const q of quoted) expect(source("start-checks.ts"), q).toContain(`"${q}"`);
    expect(source("start-checks.ts")).toContain(
      'export const MYSQL_TABLE_COLLATION = "utf8mb4_0900_bin";',
    );
  });

  it("names the baseline, the deadlock tries, and the lock wait of the code", () => {
    const migrations = part(text, "Migrations").join("\n");
    expect(MYSQL_MIGRATIONS.map((m) => m.name)).toEqual(
      codes(migrations).filter((c) => /^\d{4}_/.test(c)),
    );
    expect(source("adapter.ts")).toContain("const STATEMENT_TRIES = 3;");
    expect(part(text, "Transactions").join("\n")).toContain("with three tries in all");
    expect(source("migrations.ts")).toContain("const LOCK_WAIT_SECONDS = 60;");
    expect(migrations).toContain("for up to 60 seconds");
  });
});
