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

describe("the per-IP keys (plan 12b Task 16)", () => {
  it("calls ipKey in every per-IP limiter key of core", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    // A key `<flow>:ip:${…}` that does not start with ipKey( would count each
    // IPv6 address of one /64 on its own.
    const misses = readdirSync(src, { recursive: true })
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        readFileSync(new URL(file, src), "utf8")
          .split("\n")
          .flatMap((line, i) => (/:ip:\$\{(?!ipKey\()/.test(line) ? [`src/${file}:${i + 1}`] : [])),
      );
    expect(misses).toEqual([]);
    // The scan must read the sites: a wrong path finds no file and no miss.
    expect(readFileSync(new URL("engine/magic-link.ts", src), "utf8")).toContain(":ip:${ipKey(");
  });
});
