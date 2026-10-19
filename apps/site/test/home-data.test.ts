import { readFileSync } from "node:fs";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { walk } from "../scripts/lib/files.ts";
import { HOME_PROSE_PATH, homeProsePage } from "../scripts/lib/home-prose.ts";
import { docsPages } from "../scripts/lib/load.ts";
import { parseFrontmatter } from "../scripts/lib/markdown.ts";
import { REPO } from "../scripts/lib/paths.ts";
import { FEATURES, featureOrder } from "../src/data/features.ts";
import { HOME } from "../src/data/home.ts";
import { ICON_NAMES } from "../src/data/icons.ts";
import { NAV_LINKS, SITE } from "../src/data/site.ts";
import { vendorHosts } from "../src/data/vendors.ts";

/** Every string inside a value, at any depth. */
function leaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(leaves);
  if (v !== null && typeof v === "object") return Object.values(v).flatMap(leaves);
  return [];
}

/** The two characters that open a template placeholder, as data. */
const OPEN = "\u0024{";

/** One core file with the text, for the vendor scan. */
function core(text: string): Map<string, string> {
  return new Map([["packages/core/src/a.ts", text]]);
}

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

  it("does not count a host in a line comment or a block comment", () => {
    const text = [
      "// see https://docs.vendor.dev/x",
      "/* https://api.stripe.com/v1 */",
      'const u = "https://api.vendor.dev/v1"; // https://c.vendor.dev',
    ].join("\n");
    expect(vendorHosts(core(text))).toEqual(["api.vendor.dev"]);
  });

  it.each([
    [
      "a template URL with a template label",
      `\`https://${OPEN}region}.api.vendor.dev/v1\``,
      ["api.vendor.dev"],
    ],
    [
      "a template URL with a template path",
      `\`https://api.vendor.dev/${OPEN}path}\``,
      ["api.vendor.dev"],
    ],
    ["an http URL", '"http://api.vendor.dev/x"', ["api.vendor.dev"]],
    ["a wss URL", '"wss://rt.vendor.dev/socket"', ["rt.vendor.dev"]],
    ["a userinfo part", '"https://user:pw@api.vendor.dev/x"', ["api.vendor.dev"]],
    ["an underscore", '"https://api_x.vendor.dev/"', ["api_x.vendor.dev"]],
    ["a root dot", '"https://api.vendor.dev./x"', ["api.vendor.dev"]],
    ["a port", '"https://api.vendor.dev:8443/x"', ["api.vendor.dev"]],
    ["an IPv4 literal", '"https://10.0.0.1/x"', []],
    ["an IPv6 literal", '"http://[::1]:8080/"', []],
    ["an IPv6 template literal", `\`http://[${OPEN}value}]/\``, []],
  ])("reads the host of %s", (_form, text, hosts) => {
    expect(vendorHosts(core(text))).toEqual(hosts);
  });

  it("fails on a template URL host with no literal domain", () => {
    expect(() => vendorHosts(core(`\`https://${OPEN}host}/x\``))).toThrow(
      `packages/core/src/a.ts: the template URL host "${OPEN}host}" names no literal domain`,
    );
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

  it("puts each string of the home data in the prose page as its own paragraph", () => {
    const body = parseFrontmatter(homeProsePage().source)?.body ?? "";
    const paragraphs = body
      .split("\n\n")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const strings = [
      ...leaves(HOME),
      ...Object.values(FEATURES).flatMap((f) => [f.title, f.line]),
      ...NAV_LINKS.map((l) => l.label),
      SITE.nav,
      SITE.repo,
    ];
    expect(paragraphs.sort()).toEqual(strings.sort());
  });

  it("names the home prose in a term failure", () => {
    const page = homeProsePage();
    const broken = { ...page, source: `${page.source}\nLog in with one click.\n` };
    expect(
      checkTerms([...docsPages(), broken]).failures.some((f) => f.startsWith(HOME_PROSE_PATH)),
    ).toBe(true);
  });
});
