import { describe, expect, it } from "vitest";

// Ruling 19 of plan 12h: each auth error redirect of core carries the mark that the router reads.

/** Core's typecheck has no Node types; the specifier in a constant keeps node:fs out of it. */
interface SourceFs {
  readdirSync(dir: URL, options: { recursive: true }): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/** A code line that builds the auth_error parameter itself: a literal, a template, or a set call. */
const BUILDS = [
  /auth_error=/,
  /\$\{AUTH_ERROR_PARAM\}/,
  /searchParams\.(set|append)\(\s*(AUTH_ERROR_PARAM|["']auth_error["'])/,
];

/**
 * The files that may name the parameter with no mark. `redirect.ts` builds
 * it. `routes.ts` exports the name. The contracts and the OpenAPI text only
 * describe the answer and build no URL.
 */
const MAY_NAME = (file: string) =>
  file === "http/redirect.ts" ||
  file === "routes.ts" ||
  file.startsWith("http/contract/") ||
  file.startsWith("openapi/");

/** A code line that names the parameter in any form, an object key too. */
const NAMES = /auth_error|AUTH_ERROR_PARAM/;

/** A line of a comment: the scan reads code only. */
const isComment = (line: string) => /^\s*(\*|\/\*|\/\/)/.test(line);

describe("the auth error redirect (ruling 19 of plan 12h)", () => {
  it("is built only by authErrorRedirect, which marks it", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    // The scan must read the routes: a list with no file finds no miss.
    expect(files).toContain("http/routes/magic-link.ts");
    const found: string[] = [];
    const named: string[] = [];
    let users = 0;
    for (const file of files) {
      const text = readFileSync(new URL(file, src), "utf8");
      if (/\bauthErrorRedirect\(/.test(text) && file !== "http/redirect.ts") users++;
      text.split("\n").forEach((line, i) => {
        if (isComment(line)) return;
        if (BUILDS.some((re) => re.test(line))) found.push(`${file}:${i + 1}: ${line.trim()}`);
        if (!MAY_NAME(file) && NAMES.test(line)) named.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    // The one place that builds the URL, beside its mark.
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^http\/redirect\.ts:\d+: const res = redirect\(/);
    // No other file names the parameter, so a URLSearchParams object cannot build it.
    expect(named).toEqual([]);
    // The 13 call sites of plan 12h sit in 7 route files: a scan that reads them finds each.
    expect(users).toBeGreaterThanOrEqual(7);
  });
});
