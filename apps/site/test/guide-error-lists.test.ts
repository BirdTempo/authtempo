import { readFileSync } from "node:fs";
import { ROUTES, type RouteFeature } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { DOCS } from "../scripts/lib/paths.ts";
import { FEATURES, type Feature } from "../src/data/features.ts";

/** The error codes that the "If it fails" section of a guide links, sorted. */
function linkedCodes(page: string): string[] {
  const text = readFileSync(`${DOCS}docs/guides/${page}`, "utf8");
  const lines = text.split("\n");
  const at = lines.indexOf("## If it fails");
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  if (at < 0) throw new Error(`${page} has no "If it fails" section`);
  const section = lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
  const codes = [...section.matchAll(/\/docs\/reference\/errors\/#([a-z_]+)\)/g)].map((m) => m[1]);
  return [...new Set(codes as string[])].sort();
}

/** The codes that ROUTES lists for the routes of some features, sorted. */
function routeCodes(features: readonly string[]): string[] {
  const codes = ROUTES.filter((r) => features.includes(r.feature)).flatMap((r) => r.codes);
  return [...new Set<string>(codes)].sort();
}

// Review m1 of plan 12d Task 13: a guide links each code that its routes answer.
// A guide may link more, such as sso_required of the other sign-in routes.
// Item 30 of the 12i final fix wave: the pages come from FEATURES, so a new
// feature with a guide page is held at once, with no hand list to update.
// The guide of a feature may carry an anchor; the page is what counts. A
// feature whose guide is a reference page, such as `operator`, is not held.

/** The guide pages of FEATURES, each with the features that point to it. */
function guidePages(): Map<string, RouteFeature[]> {
  const pages = new Map<string, RouteFeature[]>();
  for (const [feature, row] of Object.entries(FEATURES) as [RouteFeature, Feature][]) {
    const m = /^\/docs\/guides\/([a-z-]+)\/(#[a-z-]+)?$/.exec(row.guide);
    if (m) pages.set(`${m[1]}.mdx`, [...(pages.get(`${m[1]}.mdx`) ?? []), feature]);
  }
  return pages;
}

/**
 * A guide that holds a feature of another page. native-apple.mdx shows the
 * Apple sheet of `socialIdToken`, whose FEATURES row names one-tap.mdx.
 */
const EXTRA: readonly (readonly [string, readonly RouteFeature[]])[] = [
  ["native-apple.mdx", ["socialIdToken"]],
];

/**
 * The guides written before the rule of plan 12d Task 13. They link the
 * codes a person meets most, not each code of their routes. A test below
 * fails when one of them links every code, so the list only shrinks.
 */
const OLDER = new Set([
  "account-settings.mdx",
  "magic-link.mdx",
  "social.mdx",
  "passkeys.mdx",
  "password.mdx",
  "second-factor.mdx",
  "email-code.mdx",
  "handoff.mdx",
  "organizations.mdx",
  "roles-and-permissions.mdx",
  "api-tokens.mdx",
  "jwt.mdx",
  "oauth-provider.mdx",
]);

/** The codes of the routes of some features that a guide does not link. */
function missingCodes(page: string, features: readonly string[]): string[] {
  const linked = linkedCodes(page);
  return routeCodes(features).filter((c) => !linked.includes(c));
}

describe("the If it fails section of each feature guide", () => {
  const pages = guidePages();
  const held = [...pages].filter(([page]) => !OLDER.has(page));

  it("holds the guides of plan 12d and plan 12i, and more", () => {
    const names = held.map(([page]) => page);
    for (const page of ["sso.mdx", "scim.mdx", "phone.mdx", "username.mdx", "one-tap.mdx"])
      expect(names).toContain(page);
  });

  it.each([...held, ...EXTRA])("%s links every code of the routes of %j", (page, features) => {
    expect(missingCodes(page, features)).toEqual([]);
  });

  it.each([...OLDER])("%s is a feature guide that still misses a code", (page) => {
    const features = pages.get(page);
    expect(features).toBeDefined();
    expect(missingCodes(page, features ?? []).length).toBeGreaterThan(0);
  });
});
