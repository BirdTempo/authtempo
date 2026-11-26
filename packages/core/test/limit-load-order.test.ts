import { describe, expect, it } from "vitest";

/**
 * The one node:fs call of this file. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface ReadFs {
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";
const fs = (await import(FS_MODULE)) as ReadFs;

const SRC = new URL("../src/", import.meta.url);

/** The path of a module from `src`, for a specifier that `file` imports. */
function target(file: string, specifier: string): string {
  const url = new URL(specifier.replace(/\.js$/, ".ts"), new URL(file, SRC));
  return url.href.slice(SRC.href.length);
}

/** True for `{ type A, type B }`: an import of types only, which loads no module. */
function typesOnly(clause: string): boolean {
  const names = /^\{([^}]*)\}$/s.exec(clause.trim())?.[1];
  if (names === undefined) return false;
  return names
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "")
    .every((n) => n.startsWith("type "));
}

/** The local modules that a file imports a value from. A type import loads no module. */
function valueImports(file: string): string[] {
  const text = fs.readFileSync(new URL(file, SRC), "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(
    /^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.[^"]+)";/gms,
  )) {
    if (m[1] !== undefined || typesOnly(m[2] ?? "")) continue;
    out.push(target(file, m[3] ?? ""));
  }
  for (const m of text.matchAll(/^import\s+"(\.[^"]+)";/gm)) out.push(target(file, m[1] ?? ""));
  return out;
}

/** Each module that the load of `entry` runs, by its value imports. */
function loads(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of valueImports(file)) walk(next);
  };
  walk(entry);
  return seen;
}

// Many modules load `limiter/limit.ts` first: the entry `@authtempo/core/observe`
// does, and the site checks load that entry. `observe/events.ts` reads
// `LIMIT_FAMILIES` when it loads. So a value import that leads from `limit.ts`
// to the config makes a cycle: the config runs, and with it the events
// module, before `LIMIT_FAMILIES` has its value. The load then throws. The
// site build found this fault on 2026-11-25, and no core test did, because
// the test runner loads modules in another way. So this test reads the imports.
describe("the load of limiter/limit.ts", () => {
  it("reads the value imports of a file, and no type import", () => {
    expect(valueImports("limiter/limit.ts").sort()).toEqual([
      "limiter/ip-key.ts",
      "limiter/limit-window.ts",
    ]);
    // `limits-config.ts` has a value import of the config: the reason for the leaf module.
    expect(valueImports("limiter/limits-config.ts")).toContain("config.ts");
  });

  it("runs no module that reads LIMIT_FAMILIES at its load, and never the config", () => {
    const loaded = loads("limiter/limit.ts");
    expect([...loaded].sort()).toEqual([
      "limiter/ip-key.ts",
      "limiter/limit-window.ts",
      "limiter/limit.ts",
    ]);
    expect(loaded.has("config.ts")).toBe(false);
    expect(loaded.has("observe/events.ts")).toBe(false);
    // The walk can reach the config: it does from the check of the block.
    expect(loads("limiter/limits-config.ts").has("observe/events.ts")).toBe(true);
  });
});
