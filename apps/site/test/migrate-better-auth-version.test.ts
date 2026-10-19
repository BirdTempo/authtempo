import { readFileSync } from "node:fs";
import { BETTER_AUTH_FIXED } from "@authtempo/cli";
import { describe, expect, it } from "vitest";

/**
 * The pages that name the Better Auth version with the magic link fix. The
 * warning of `authtempo migrate --tables compat` reads `BETTER_AUTH_FIXED`, so
 * the CLI and these pages state one fact (the final review of plan 11f, L8).
 */
const PAGES = [
  "../src/content/docs/docs/migrate/better-auth.mdx",
  "../src/content/docs/docs/migrate/cutover.md",
  "../src/content/docs/docs/reference/cli/migrate.md",
] as const;

/** Each version with three parts on the major and minor version of the fix, such as 1.7.7. */
const PATCH_OF_1_7 = /\b1\.7\.\d+\b/g;

describe("the Better Auth version of the cautions", () => {
  it("is the version of the CLI warning", () => {
    // A typed literal: a change of the CLI version fails here, and then the pages change with it.
    expect(BETTER_AUTH_FIXED).toEqual([1, 7, 7]);
  });

  it("is the only version with three parts on each page", () => {
    for (const page of PAGES) {
      const text = readFileSync(new URL(page, import.meta.url), "utf8");
      const found = text.match(PATCH_OF_1_7) ?? [];
      expect(found.length, page).toBeGreaterThan(0);
      expect(new Set(found), page).toEqual(new Set([BETTER_AUTH_FIXED.join(".")]));
    }
  });
});
