import { describe, expect, it } from "vitest";
import { EXEMPT_ENTRIES, EXPORT_ENTRIES, SDK_PACKAGES } from "../scripts/lib/entries.ts";
import { readRepoFile } from "../scripts/lib/load.ts";

/** The `exports` keys of a package of the repo: `@authtempo/x` lives in `packages/x`. */
function entriesOf(pkg: string): string[] {
  const text = readRepoFile(`packages/${pkg.replace("@authtempo/", "")}/package.json`);
  if (text === null) throw new Error(`no package.json for ${pkg}`);
  return Object.keys((JSON.parse(text) as { exports: Record<string, unknown> }).exports);
}

describe("the export entry list (plan 11d)", () => {
  it("lists every entry of every SDK package, with a page or with a reason", () => {
    const listed = new Set([
      ...EXPORT_ENTRIES.map((e) => `${e.pkg} ${e.entry}`),
      ...EXEMPT_ENTRIES.map((e) => `${e.pkg} ${e.entry}`),
    ]);
    for (const pkg of SDK_PACKAGES)
      for (const entry of entriesOf(pkg))
        expect(listed, `${pkg} ${entry}`).toContain(`${pkg} ${entry}`);
  });

  it("names an entry that a package map has, a source file that exists, and a page under /docs/reference/", () => {
    for (const e of [...EXPORT_ENTRIES, ...EXEMPT_ENTRIES])
      expect(entriesOf(e.pkg), `${e.pkg} ${e.entry}`).toContain(e.entry);
    for (const e of EXPORT_ENTRIES) {
      expect(readRepoFile(e.source), e.source).not.toBeNull();
      expect(e.page).toMatch(/^\/docs\/reference\/[a-z-]+\/$/);
    }
    for (const e of EXEMPT_ENTRIES) expect(e.reason.length).toBeGreaterThan(0);
    expect(new Set(EXPORT_ENTRIES.map((e) => e.label)).size).toBe(EXPORT_ENTRIES.length);
  });
});
