import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The OAuth provider guide against the code of plan 12e (the docs review of
// 86c5a94). A fact changed on one side only fails this test.
const GUIDE = readFileSync(`${DOCS}docs/guides/oauth-provider.mdx`, "utf8");
const ROUTE = readFileSync(`${REPO}packages/core/src/http/routes/oauth.ts`, "utf8");

/** The text of a `## ` section of the guide, from its heading to the next one. */
function section(heading: string): string {
  const start = GUIDE.indexOf(`\n## ${heading}\n`);
  expect({ heading, found: start >= 0 }).toEqual({ heading, found: true });
  const end = GUIDE.indexOf("\n## ", start + 1);
  return GUIDE.slice(start, end < 0 ? undefined : end);
}

describe("the OAuth provider guide", () => {
  // Rulings 46 and 47: a framed GET with no session gets a page with a top-level link.
  it("states the framed end-session page that core serves", () => {
    expect(ROUTE).toContain('kind: "framed"');
    const text = section("Sign-out at the provider");
    expect(text).toContain("`Sec-Fetch-Dest` other than `document`");
    expect(text).toContain("a page with a top-level link to the same GET");
    // The signed-out page is the last case: a framed request never gets it.
    expect(text.indexOf("Sec-Fetch-Dest")).toBeLessThan(text.indexOf("the signed-out page"));
  });
});
