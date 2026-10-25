import { describe, expect, it } from "vitest";
import { type ModelName, schema } from "../src/schema.js";
import { schemaDdl } from "../src/storage/ddl.js";
import {
  AUX_TABLES,
  columnName,
  type Dialect,
  fieldsFromUniqueIndex,
  indexName,
  MYSQL,
  POSTGRES,
  SQLITE,
  TABLES,
  uniqueIndexName,
} from "../src/storage/sql.js";

const DIALECTS: readonly Dialect[] = [SQLITE, POSTGRES, MYSQL];
const MODELS = Object.keys(schema) as ModelName[];

interface Key {
  table: string;
  kind: "unique" | "index";
  name: string;
  columns: string[];
}

const byKey = (a: Key, b: Key) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The keys that the schema and AUX_TABLES name, with core's index names. */
function schemaKeys(): Key[] {
  const keys: Key[] = [];
  for (const m of MODELS) {
    for (const f of schema[m].unique)
      keys.push({
        table: TABLES[m],
        kind: "unique",
        name: uniqueIndexName(m, f),
        columns: f.map(columnName),
      });
    for (const f of schema[m].indexes)
      keys.push({
        table: TABLES[m],
        kind: "index",
        name: indexName(m, f),
        columns: f.map(columnName),
      });
  }
  for (const t of AUX_TABLES)
    for (const ix of t.indexes)
      keys.push({ table: t.name, kind: "index", name: ix.name, columns: [...ix.columns] });
  return keys.sort(byKey);
}

/** The column list of a key, without quotes and without a prefix length. */
const columnList = (text: string) =>
  text.split(",").map((c) => c.trim().replace(/^`(.*)`(\(\d+\))?$/, "$1"));

/** The keys that the DDL text of `d` makes. */
function ddlKeys(d: Dialect): Key[] {
  const keys: Key[] = [];
  for (const s of schemaDdl(d)) {
    const separate = /^CREATE (UNIQUE )?INDEX (\S+) ON (\S+) \((.*)\)$/.exec(s);
    if (separate)
      keys.push({
        table: separate[3] ?? "",
        kind: separate[1] ? "unique" : "index",
        name: separate[2] ?? "",
        columns: columnList(separate[4] ?? ""),
      });
    const table = /^CREATE TABLE `([^`]+)`/.exec(s)?.[1];
    if (table === undefined) continue;
    for (const k of s.matchAll(/^ {2}(UNIQUE )?KEY `([^`]+)` \((.*)\),?$/gm))
      keys.push({
        table,
        kind: k[1] ? "unique" : "index",
        name: k[2] ?? "",
        columns: columnList(k[3] ?? ""),
      });
  }
  return keys.sort(byKey);
}

describe("schemaDdl (plan 12g)", () => {
  it("prints the same text for the same schema", () => {
    for (const d of DIALECTS) {
      const first = schemaDdl(d);
      const second = schemaDdl(d);
      expect(first.length).toBeGreaterThan(MODELS.length);
      expect({ dialect: d.name, statements: second }).toEqual({
        dialect: d.name,
        statements: first,
      });
    }
  });

  it("names each index as fieldsFromUniqueIndex reads it back", () => {
    const want = schemaKeys();
    // 27 models of version 13 hold 50 named keys, and ta_limit holds one.
    // Version 14 (plan 12d) adds 6 models with 13 named keys. Version 15
    // (plan 12i) adds the unique keys of user.username and user.phone, and
    // the index of user on isAnonymous and createdAt (ruling 25 H1).
    expect(want).toHaveLength(67);
    for (const d of DIALECTS) {
      const have = ddlKeys(d);
      expect({ dialect: d.name, keys: have }).toEqual({ dialect: d.name, keys: want });
      for (const k of have) {
        const model = MODELS.find((m) => TABLES[m] === k.table);
        if (k.kind !== "unique" || model === undefined) continue;
        expect({
          name: k.name,
          fields: fieldsFromUniqueIndex(model, k.name)?.map(columnName),
        }).toEqual({ name: k.name, fields: k.columns });
      }
    }
  });

  it("creates each table with its indexes in one MySQL statement", () => {
    const statements = schemaDdl(MYSQL);
    const tables = statements.filter((s) => s.startsWith("CREATE TABLE "));
    expect(tables).toHaveLength(MODELS.length + AUX_TABLES.length);
    for (const s of tables) {
      expect(s.endsWith(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin")).toBe(
        true,
      );
      expect(s).toMatch(/^ {2}PRIMARY KEY \(`[a-z_]+`\),?$/m);
    }
    for (const m of MODELS) {
      const s = tables.find((t) => t.startsWith(`CREATE TABLE \`${TABLES[m]}\` (`)) ?? "";
      for (const f of schema[m].unique)
        expect(s).toContain(`UNIQUE KEY \`${uniqueIndexName(m, f)}\` (`);
      for (const f of schema[m].indexes) expect(s).toContain(`  KEY \`${indexName(m, f)}\` (`);
    }
    expect(statements.filter((s) => /^CREATE (UNIQUE )?INDEX /.test(s))).toEqual([]);
    expect(statements).toHaveLength(MODELS.length + AUX_TABLES.length + 1);
  });

  it("ends with the version row", () => {
    expect(schemaDdl(SQLITE).at(-1)).toBe(
      "INSERT INTO ta_meta (key, value) VALUES ('schema_version', '15')",
    );
    expect(schemaDdl(POSTGRES).at(-1)).toBe(
      "INSERT INTO ta_meta (key, value) VALUES ('schema_version', '15')",
    );
    expect(schemaDdl(MYSQL).at(-1)).toBe(
      "INSERT INTO `ta_meta` (`key`, `value`) VALUES ('schema_version', '15')",
    );
  });

  it("puts the prefix only on a plain index", () => {
    const statements = schemaDdl(MYSQL);
    const verification = statements.find((s) => s.startsWith("CREATE TABLE `ta_verification` ("));
    expect(verification).toContain(
      "  KEY `ix_ta_verification__purpose__identifier` (`purpose`, `identifier`(255))",
    );
    const prefixed = statements.flatMap((s) => s.match(/^ {2}.*`\(\d+\).*$/gm) ?? []);
    expect(prefixed).toEqual([
      "  KEY `ix_ta_verification__purpose__identifier` (`purpose`, `identifier`(255))",
    ]);
    for (const s of statements)
      for (const line of s.match(/^ {2}(UNIQUE KEY|PRIMARY KEY) .*$/gm) ?? [])
        expect(line).not.toMatch(/`\(\d+\)/);
  });
});
