import { describe, expect, it } from "vitest";

/**
 * The two node:fs calls the site scan uses. Core's typecheck has no Node
 * types, because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface SourceFs {
  readdirSync(dir: URL, options: { recursive: true }): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/** The per-IP key sites at plan 12b Task 16. A new site raises the count. */
const MIN_SITES = 21;

describe("the per-IP keys (plan 12b Task 16)", () => {
  it("calls ipKey in every per-IP limiter key of core", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    // The scan must read the sites: a list with no file finds no miss.
    expect(files).toContain("engine/magic-link.ts");
    // The scan matches only a template key `:ip:${` on one line. A key joined
    // with + or built in a variable escapes it. No such form exists today.
    // A key `<flow>:ip:${…}` that does not start with ipKey( would count each
    // IPv6 address of one /64 on its own.
    const lines = files.flatMap((file) =>
      readFileSync(new URL(file, src), "utf8")
        .split("\n")
        .map((line, i) => ({ at: `src/${file}:${i + 1}`, line })),
    );
    const misses = lines.filter(({ line }) => /:ip:\$\{(?!ipKey\()/.test(line)).map(({ at }) => at);
    expect(misses).toEqual([]);
    const sites = lines.filter(({ line }) => line.includes(":ip:${ipKey(")).length;
    expect(sites).toBeGreaterThanOrEqual(MIN_SITES);
  });
});
