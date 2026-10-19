import { readFileSync } from "node:fs";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { walk } from "../scripts/lib/files.ts";
import { HOME_PROSE_PATH, homeProsePage } from "../scripts/lib/home-prose.ts";
import { docsPages } from "../scripts/lib/load.ts";
import { REPO } from "../scripts/lib/paths.ts";
import { FEATURES, featureOrder } from "../src/data/features.ts";
import { ICON_NAMES } from "../src/data/icons.ts";
import { vendorHosts } from "../src/data/vendors.ts";

describe("the data of the home page (plan 11b1)", () => {
  it("has one feature row per RouteFeature member", () => {
    expect([...featureOrder(ROUTES)].sort()).toEqual(Object.keys(FEATURES).sort());
  });

  it("orders the features by their first route", () => {
    expect(
      featureOrder([{ feature: "tokens" }, { feature: "session" }, { feature: "tokens" }]),
    ).toEqual(["tokens", "session"]);
  });

  it("gives each feature an icon of the sprite", () => {
    for (const f of Object.values(FEATURES)) expect(ICON_NAMES).toContain(f.icon);
  });

  it("counts a vendor host and skips the presets, the test helpers, and the reserved names", () => {
    const files = new Map([
      ["packages/core/src/a.ts", 'fetch("https://api.vendor.dev/v1")'],
      ["packages/core/src/social/google.ts", '"https://accounts.google.com/o/oauth2/v2/auth"'],
      ["packages/core/src/storage/conformance.ts", '"https://api.example.com"'],
      ["packages/core/src/b.ts", '"https://app.example.com/x", "https://x.invalid/"'],
    ]);
    expect(vendorHosts(files)).toEqual(["api.vendor.dev"]);
  });

  it("finds no vendor host in the source of core", () => {
    const files = new Map(
      walk(`${REPO}packages/core/src/`, (p) => p.endsWith(".ts")).map((p) => [
        p.slice(REPO.length),
        readFileSync(p, "utf8"),
      ]),
    );
    expect(files.size).toBeGreaterThan(0);
    expect(vendorHosts(files)).toEqual([]);
  });

  it("keeps the home prose inside the term and sentence rules", () => {
    expect(homeProsePage().path).toBe(HOME_PROSE_PATH);
    expect(checkTerms([...docsPages(), homeProsePage()]).failures).toEqual([]);
    expect(checkSentences([homeProsePage()]).failures).toEqual([]);
  });

  it("names the home prose in a term failure", () => {
    const page = homeProsePage();
    const broken = { ...page, source: `${page.source}\nLog in with one click.\n` };
    expect(
      checkTerms([...docsPages(), broken]).failures.some((f) => f.startsWith(HOME_PROSE_PATH)),
    ).toBe(true);
  });
});
