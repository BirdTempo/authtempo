import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelName, schema } from "@authtempo/core";
import { columnName, indexName, TABLES, uniqueIndexName } from "@authtempo/core/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFreshBuild, PKG, runBin } from "./support/bin.js";

// `authtempo generate --format prisma` (plan 12g Task 7). The names of each
// printed model are held to core's naming rules, and prisma validate 7.10.0
// reads each printed schema. Validate runs with no network and no engine:
// PRISMA_SCHEMA_ENGINE_BINARY names a stub that exits 1, and the proxy
// variables point at a closed port (Step 1.3 of the task, opening ruling 1).

const PROVIDERS = { sqlite: "sqlite", postgres: "postgresql", mysql: "mysql" } as const;
const DIALECTS = Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[];

const dir = mkdtempSync(join(tmpdir(), "authtempo-cli-prisma-"));
const STUB = join(dir, "no-engine");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  assertFreshBuild();
  writeFileSync(STUB, "#!/bin/sh\nexit 1\n");
  chmodSync(STUB, 0o755);
});

function printed(dialect: string): string {
  const r = runBin(["generate", "--format", "prisma", "--dialect", dialect]);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

interface ParsedModel {
  table: string | undefined;
  columns: [string, string][];
  unique: [string, string][];
  indexes: [string, string][];
}

/** Each `model … { … }` block of the text by its model name. */
function parseModels(text: string): Map<string, ParsedModel> {
  const out = new Map<string, ParsedModel>();
  for (const m of text.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}$/gm)) {
    const body = m[2] ?? "";
    const keys = (kind: string): [string, string][] =>
      [
        ...body.matchAll(
          new RegExp(`^  @@${kind}\\(\\[([^\\]]*)\\](?:, map: "([^"]+)")?\\)$`, "gm"),
        ),
      ].map((k) => [(k[1] ?? "").replace(/\(length: \d+\)/g, ""), k[2] ?? "(no map)"]);
    out.set(m[1] ?? "", {
      table: /^ {2}@@map\("([^"]+)"\)$/m.exec(body)?.[1],
      columns: [...body.matchAll(/^ {2}(\w+) \S+.*@map\("([^"]+)"\)/gm)].map((c) => [
        c[1] ?? "",
        c[2] ?? "",
      ]),
      unique: keys("unique"),
      indexes: keys("index"),
    });
  }
  return out;
}

/** The model of `m` as core names it: the table, each column, each unique key, and each index. */
function expected(m: ModelName): ParsedModel {
  const def = schema[m];
  return {
    table: TABLES[m],
    columns: Object.keys(def.fields).map((f) => [f, columnName(f)]),
    unique: def.unique.map((fs) => [fs.join(", "), uniqueIndexName(m, fs)]),
    indexes: def.indexes.map((fs) => [fs.join(", "), indexName(m, fs)]),
  };
}

/** prisma validate 7.10.0 on one schema file, offline and with no engine. */
function validate(file: string) {
  return spawnSync(join(PKG, "node_modules/.bin/prisma"), ["validate", "--schema", file], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PRISMA_SCHEMA_ENGINE_BINARY: STUB,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      CHECKPOINT_DISABLE: "1",
    },
    timeout: 120_000,
  });
}

describe("authtempo generate --format prisma (plan 12g Task 7)", () => {
  it("names every table, column, and key of the schema", async () => {
    for (const d of DIALECTS) {
      const text = printed(d);
      const models = parseModels(text);
      const names = Object.keys(schema) as ModelName[];
      expect([...models.keys()], d).toEqual(
        names.map((m) => `Ta${m.charAt(0).toUpperCase()}${m.slice(1)}`),
      );
      for (const m of names)
        expect(models.get(`Ta${m.charAt(0).toUpperCase()}${m.slice(1)}`), `${d} ${m}`).toEqual(
          expected(m),
        );
      // The snapshot comes last, so a lost name fails the name compare first.
      await expect(text).toMatchFileSnapshot(`__snapshots__/generate-prisma-${d}.prisma.snap`);
    }
  });

  it("passes prisma validate", () => {
    for (const d of DIALECTS) {
      const file = join(dir, `${d}.prisma`);
      writeFileSync(file, `datasource db {\n  provider = "${PROVIDERS[d]}"\n}\n\n${printed(d)}`);
      const r = validate(file);
      expect(r.status, `${d}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout + r.stderr).toContain("is valid");
    }
    // The control: the same run refuses a schema with an unknown type, so a pass is a real read.
    const bad = join(dir, "bad.prisma");
    writeFileSync(
      bad,
      'datasource db {\n  provider = "sqlite"\n}\n\nmodel X {\n  id Strin @id\n}\n',
    );
    const r = validate(bad);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('Type "Strin" is neither a built-in type');
  });
});
