import { describe, expect, it } from "vitest";
import {
  ADAPTER_PACKAGES,
  EXEMPT_ENTRIES,
  EXPORT_ENTRIES,
  SDK_PACKAGES,
} from "../scripts/lib/entries.ts";
import { readRepoFile } from "../scripts/lib/load.ts";

/** The `exports` map of a package of the repo: `@authtempo/x` lives in `packages/x`. */
function mapOf(pkg: string): Record<string, { types: string }> {
  const text = readRepoFile(`packages/${pkg.replace("@authtempo/", "")}/package.json`);
  if (text === null) throw new Error(`no package.json for ${pkg}`);
  return (JSON.parse(text) as { exports: Record<string, { types: string }> }).exports;
}

/** The `exports` keys of a package. */
function entriesOf(pkg: string): string[] {
  return Object.keys(mapOf(pkg));
}

/** The source file of an entry, from the `types` target of the map: `./dist/a/b.d.ts` is `src/a/b.ts`. */
function sourceOf(pkg: string, entry: string): string {
  const types = mapOf(pkg)[entry]?.types ?? "";
  return `packages/${pkg.replace("@authtempo/", "")}/${types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts")}`;
}

describe("the export entry list (plan 11d)", () => {
  it("lists every entry of every SDK package and adapter package, with a page or with a reason", () => {
    const listed = new Set([
      ...EXPORT_ENTRIES.map((e) => `${e.pkg} ${e.entry}`),
      ...EXEMPT_ENTRIES.map((e) => `${e.pkg} ${e.entry}`),
    ]);
    for (const pkg of [...SDK_PACKAGES, ...ADAPTER_PACKAGES])
      for (const entry of entriesOf(pkg))
        expect(listed, `${pkg} ${entry}`).toContain(`${pkg} ${entry}`);
  });

  it("names an entry that a package map has, a source file that exists, and a page under /docs/reference/", () => {
    for (const e of [...EXPORT_ENTRIES, ...EXEMPT_ENTRIES])
      expect(entriesOf(e.pkg), `${e.pkg} ${e.entry}`).toContain(e.entry);
    for (const e of EXPORT_ENTRIES) {
      expect(readRepoFile(e.source), e.source).not.toBeNull();
      // The source is the file of the entry, not any file that exists (plan 11d Task 15 review, L1).
      expect(e.source, `${e.pkg} ${e.entry}`).toBe(sourceOf(e.pkg, e.entry));
      expect(e.page).toMatch(/^\/docs\/reference\/[a-z-]+\/$/);
    }
    for (const e of EXEMPT_ENTRIES) expect(e.reason.length).toBeGreaterThan(0);
    // Each row names the sections of its exports tables (plan 11d Task 15 review, P5).
    for (const e of EXPORT_ENTRIES) expect(e.headings.length, e.label).toBeGreaterThan(0);
    expect(new Set(EXPORT_ENTRIES.map((e) => e.label)).size).toBe(EXPORT_ENTRIES.length);
  });
});
