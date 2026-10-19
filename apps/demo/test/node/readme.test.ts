import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_LIMITS } from "../../src/facts.ts";

// The limits table of the README names a source line of src/facts.ts for
// each limit. A change of facts.ts moved every line once, and no test saw it.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("the limits table of the README", () => {
  it("names each key of DEMO_LIMITS once, at the line of facts.ts that sets it", () => {
    const readme = readFileSync(resolve(PKG, "README.md"), "utf8");
    const facts = readFileSync(resolve(PKG, "src/facts.ts"), "utf8").split("\n");
    const rows = [...readme.matchAll(/`src\/facts\.ts:(\d+)` `(\w+)`/g)];
    expect(rows.map((m) => m[2])).toEqual(Object.keys(DEMO_LIMITS));
    for (const [, line = "", key = ""] of rows)
      expect({ key, text: facts[Number(line) - 1]?.trim().startsWith(`${key}: `) }).toEqual({
        key,
        text: true,
      });
  });
});
