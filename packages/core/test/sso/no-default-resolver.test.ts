import { describe, expect, it } from "vitest";

/**
 * The two node:fs calls of the scan. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface SourceFs {
  readdirSync(dir: URL, options: { recursive: true }): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/**
 * A call of a DoH preset, or a rename of one. A rename (`dohGoogle as g`)
 * counts, because a call of the new name escapes the first form. A re-export
 * (`export { dohCloudflare }`) has no parenthesis, so it is no call.
 */
const PRESET_CALL_RE = /\b(dohCloudflare|dohGoogle)(\s*\(|\s+as\b)/;

describe("the DoH presets (plan 12d, ruling 15)", () => {
  it("are called by no core source file other than engine/sso/dns.ts, so core has no default resolver", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    // The scan must read the files: a list with no file finds no call.
    expect(files).toContain("engine/sso/dns.ts");
    expect(files).toContain("config.ts");
    // A comment that writes a call counts too. The scan fails closed.
    const calls = files.flatMap((file) =>
      readFileSync(new URL(file, src), "utf8")
        .split("\n")
        .flatMap((line, i) => (PRESET_CALL_RE.test(line) ? [`src/${file}:${i + 1}`] : [])),
    );
    // The two definitions in dns.ts match, so the pattern can find a call.
    expect(calls.filter((at) => at.startsWith("src/engine/sso/dns.ts:")).length).toBe(2);
    expect(calls.filter((at) => !at.startsWith("src/engine/sso/dns.ts:"))).toEqual([]);
  });
});
