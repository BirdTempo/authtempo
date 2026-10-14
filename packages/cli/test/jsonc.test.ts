import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/jsonc.js";
import { REPO } from "./support/bin.js";

describe("parseJsonc (plan 11c)", () => {
  it("drops line and block comments, and keeps a comment mark inside a string", () => {
    expect(parseJsonc('{\n // a\n "a": "x//y", /* b */ "b": "/* c */"\n}')).toEqual({
      a: "x//y",
      b: "/* c */",
    });
  });

  it("drops a trailing comma before a bracket or a brace, also after a comment, and keeps a comma inside a string", () => {
    expect(parseJsonc('{ "a": [1, 2,], "b": ",]", "c": { "d": 1, // e\n }, }')).toEqual({
      a: [1, 2],
      b: ",]",
      c: { d: 1 },
    });
  });

  it("keeps an escaped quote inside a string", () => {
    expect(parseJsonc('{ "a": "say \\"hi\\" // no" }')).toEqual({ a: 'say "hi" // no' });
  });

  it("throws on text that is not JSON after the comments go", () => {
    expect(() => parseJsonc("{ a: 1 }")).toThrow();
  });

  it("reads the wrangler.jsonc of the D1 example", () => {
    const config = parseJsonc(
      readFileSync(join(REPO, "examples/worker-d1/wrangler.jsonc"), "utf8"),
    ) as {
      d1_databases: { migrations_dir: string }[];
    };
    expect(config.d1_databases[0]?.migrations_dir).toBe(
      "node_modules/@authtempo/adapter-d1/migrations",
    );
  });
});
