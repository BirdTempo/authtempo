import { describe, expect, it } from "vitest";

/**
 * The node:fs and node:module reads of this test. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a constant keeps the
 * import out of the typecheck.
 */
interface SourceFs {
  readdirSync(dir: URL, options: { recursive: true }): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";
const MODULE_MODULE = "node:module";
const SRC = new URL("../../src/", import.meta.url);

/** Every module specifier of a static import, an export from, a dynamic import, and a require. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

const FORBIDDEN = [/^xml-crypto(\/|$)/, /^@xmldom\//, /^xpath(\/|$)/, /^node:/];

describe("the SAML dev dependency stays out of the product", () => {
  it("imports no xml-crypto, no xmldom, and no node module from src", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const { builtinModules }: { builtinModules: string[] } = await import(
      /* @vite-ignore */ MODULE_MODULE
    );
    const builtins = new Set(builtinModules);
    const files = readdirSync(SRC, { recursive: true }).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(new URL(file, SRC), "utf8"))) {
        if (FORBIDDEN.some((re) => re.test(spec)) || builtins.has(spec))
          found.push(`${file}: ${spec}`);
      }
    }
    expect(found).toEqual([]);

    // The Global Constraints: xml-crypto is a dev dependency at its exact version, and only
    // `dist` ships, so the package never carries it.
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      files: string[];
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.devDependencies["xml-crypto"]).toBe("6.3.3");
    expect(Object.keys(pkg.dependencies)).not.toContain("xml-crypto");
  });
});
