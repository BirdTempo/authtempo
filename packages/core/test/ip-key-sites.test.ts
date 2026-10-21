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
    // A subject of a `<flow>:ip` family that does not start with ipKey( would
    // count each IPv6 address of one /64 on its own. Since plan 12h Task 7,
    // each key is `limit(config, "<flow>:ip", subject, window)`. The scan reads
    // that call over line breaks. It also refuses a template key `:ip:${` on
    // one line. A subject built in a variable escapes it; no such form exists today.
    const texts = files.map((file) => ({
      file: `src/${file}`,
      text: readFileSync(new URL(file, src), "utf8"),
    }));
    const calls = texts.flatMap(({ file, text }) =>
      [...text.matchAll(/\blimit\(\s*[\w.]+,\s*"[a-z][a-z-]*:ip",\s*([^,]*),/g)].map((m) => ({
        at: `${file}:${text.slice(0, m.index).split("\n").length}`,
        subject: m[1] ?? "",
      })),
    );
    const templates = texts.flatMap(({ file, text }) =>
      text
        .split("\n")
        .map((line, i) => ({ at: `${file}:${i + 1}`, line }))
        .filter(({ line }) => /:ip:\$\{(?!ipKey\()/.test(line)),
    );
    const misses = [
      ...calls.filter(({ subject }) => !subject.startsWith("ipKey(")),
      ...templates,
    ].map(({ at }) => at);
    expect(misses).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(MIN_SITES);
  });
});
