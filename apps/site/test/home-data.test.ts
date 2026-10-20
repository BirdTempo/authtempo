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
import { FOOTER_LINKS, NAV_LINKS, SITE } from "../src/data/site.ts";
import {
  DOCUMENTATION_HOSTS,
  FILE_HOST_EXCEPTIONS,
  unusedDocumentationHosts,
  unusedFileHostExceptions,
  vendorHosts,
} from "../src/data/vendors.ts";

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

/** The .ts files of the real core source, by their path from the repository root. */
function realCore(): Map<string, string> {
  return new Map(
    walk(`${REPO}packages/core/src/`, (p) => p.endsWith(".ts")).map((p) => [
      p.slice(REPO.length),
      readFileSync(p, "utf8"),
    ]),
  );
}

/**
 * The vendors in the path of the real core, typed here and never read from
 * the scan. A new host in core fails this file. The lane that adds it then
 * decides: a vendor joins this list, and a documentation link joins
 * DOCUMENTATION_HOSTS with its reason.
 */
const CORE_VENDORS: readonly string[] = [];

/** A URL of www.w3.org, as an XML namespace name, and a URL of a vendor. */
const W3C = 'const NS = "http://www.w3.org/2000/09/xmldsig#";';
const VENDOR = 'fetch("https://api.vendor.dev/v1");';

/** The keys of SITE that are a URL or a path, typed as keys so a renamed key fails the typecheck. */
const ADDRESSES: readonly (keyof typeof SITE)[] = ["origin", "docs"];

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

  it("skips the DNS resolver presets of src/engine/sso/ and counts a host of another engine folder", () => {
    const files = new Map([
      ["packages/core/src/engine/sso/dns.ts", '"https://cloudflare-dns.com/dns-query"'],
      ["packages/core/src/engine/oauth-clients.ts", 'fetch("https://api.vendor.dev/v1")'],
      ["packages/core/src/engine/ssox/a.ts", '"https://other.vendor.dev/"'],
    ]);
    expect(vendorHosts(files)).toEqual(["api.vendor.dev", "other.vendor.dev"]);
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
    [
      "a template URL after a regex literal that holds a backtick",
      `const A = /[\`{}]/u;\nconst B = (r: string) => \`https://${OPEN}r}.api.flip.dev/x\`;`,
      ["api.flip.dev"],
    ],
    [
      "a string URL after a regex literal of two slashes",
      'const A = /^\\/\\//; const B = "https://r3.vendor.dev/x";',
      ["r3.vendor.dev"],
    ],
    [
      "a template URL after a regex literal at the start of a line",
      `f(\n  /[\`]/,\n  \`https://m.vendor.dev/x\`,\n);`,
      ["m.vendor.dev"],
    ],
    [
      "a string URL after a division",
      'const q = a / 2; const s = "x/y"; const u = "https://div.vendor.dev/x";',
      ["div.vendor.dev"],
    ],
    ["an IPv6 template literal", `\`http://[${OPEN}value}]/\``, []],
  ])("reads the host of %s", (_form, text, hosts) => {
    expect(vendorHosts(core(text))).toEqual(hosts);
  });

  it("fails on a template URL host with no literal domain", () => {
    expect(() => vendorHosts(core(`\`https://${OPEN}host}/x\``))).toThrow(
      `packages/core/src/a.ts: the template URL host "${OPEN}host}" names no literal domain`,
    );
  });

  it("counts a URL after the regex literal of users.ts that holds a backtick", () => {
    const path = "packages/core/src/engine/users.ts";
    const lines = readFileSync(`${REPO}${path}`, "utf8").split("\n");
    const at = lines.findIndex((l) => l.startsWith("const IMAGE_REFUSED = /"));
    expect(lines[at]).toContain("`");
    lines.splice(at + 1, 0, `const ZF = (r: string) => \`https://${OPEN}r}.api.flip.dev/x\`;`);
    expect(vendorHosts(new Map([[path, lines.join("\n")]]))).toEqual(["api.flip.dev"]);
  });

  it("finds the typed list of vendor hosts in the source of core", () => {
    const files = realCore();
    expect(files.size).toBeGreaterThan(0);
    expect(vendorHosts(files)).toEqual(CORE_VENDORS);
  });

  it("does not count our own domain or its subdomains", () => {
    const text = [
      'const a = "https://authtempo.com/docs/";',
      'const b = "https://docs.authtempo.com/x";',
      'const c = "https://authtempo.com.vendor.dev/x";',
      'const d = "https://notauthtempo.com/x";',
    ].join("\n");
    expect(vendorHosts(core(text))).toEqual(["authtempo.com.vendor.dev", "notauthtempo.com"]);
  });

  it("does not count a host of the documentation list", () => {
    const text = 'const SPEC = "https://spec.openapis.org/oas/v3.1.0";';
    const list = [{ host: "spec.openapis.org", reason: "a link in a description" }];
    expect(vendorHosts(core(text), [])).toEqual(["spec.openapis.org"]);
    expect(vendorHosts(core(text), list)).toEqual([]);
    expect(unusedDocumentationHosts(core(text), list)).toEqual([]);
  });

  it("names a host of the documentation list that no core file names", () => {
    const list = [{ host: "spec.openapis.org", reason: "a link in a description" }];
    expect(unusedDocumentationHosts(core('"https://api.vendor.dev/x"'), list)).toEqual([
      "spec.openapis.org",
    ]);
  });

  it("finds each host of the documentation list in the source of core, with a reason", () => {
    expect(unusedDocumentationHosts(realCore())).toEqual([]);
    for (const d of DOCUMENTATION_HOSTS)
      expect({ host: d.host, reason: d.reason.trim() !== "" }).toEqual({
        host: d.host,
        reason: true,
      });
  });

  it.each([
    ["in saml/xml.ts", "packages/core/src/saml/xml.ts", W3C, []],
    ["in saml/dsig.ts", "packages/core/src/saml/dsig.ts", W3C, []],
    ["in another core file", "packages/core/src/engine/a.ts", W3C, ["www.w3.org"]],
    ["in another saml file", "packages/core/src/saml/c14n.ts", W3C, ["www.w3.org"]],
    [
      "in a file of the same name in another folder",
      "packages/core/src/x/saml/dsig.ts",
      W3C,
      ["www.w3.org"],
    ],
    [
      "of another host in a saml file of the list",
      "packages/core/src/saml/dsig.ts",
      VENDOR,
      ["api.vendor.dev"],
    ],
  ])(
    "reads www.w3.org by the exception list of each file: a URL %s",
    (_case, path, text, hosts) => {
      expect(vendorHosts(new Map([[path, text]]))).toEqual(hosts);
    },
  );

  it("drops a host of the exception list in its own file only", () => {
    const list = [
      { path: "packages/core/src/saml/xml.ts", hosts: ["www.w3.org"], reason: "a name" },
    ];
    const files = new Map([
      ["packages/core/src/saml/xml.ts", `${W3C}\n${VENDOR}`],
      ["packages/core/src/saml/dsig.ts", W3C],
    ]);
    expect(vendorHosts(files, [], [])).toEqual(["api.vendor.dev", "www.w3.org"]);
    expect(vendorHosts(files, [], list)).toEqual(["api.vendor.dev", "www.w3.org"]);
    expect(vendorHosts(new Map([["packages/core/src/saml/xml.ts", W3C]]), [], list)).toEqual([]);
  });

  it("names each host of the exception list that its file does not name", () => {
    const list = [
      {
        path: "packages/core/src/saml/xml.ts",
        hosts: ["www.w3.org", "x.vendor.dev"],
        reason: "a name",
      },
    ];
    expect(
      unusedFileHostExceptions(new Map([["packages/core/src/saml/xml.ts", W3C]]), list),
    ).toEqual(["packages/core/src/saml/xml.ts x.vendor.dev"]);
    // The host in another file does not make the entry used.
    expect(unusedFileHostExceptions(new Map([["packages/core/src/a.ts", W3C]]), list)).toEqual([
      "packages/core/src/saml/xml.ts www.w3.org",
      "packages/core/src/saml/xml.ts x.vendor.dev",
    ]);
  });

  it("finds each entry of the exception list in the source of core, with a reason", () => {
    expect(FILE_HOST_EXCEPTIONS.map((e) => [e.path, [...e.hosts]])).toEqual([
      ["packages/core/src/saml/xml.ts", ["www.w3.org"]],
      ["packages/core/src/saml/dsig.ts", ["www.w3.org"]],
    ]);
    expect(unusedFileHostExceptions(realCore())).toEqual([]);
    for (const e of FILE_HOST_EXCEPTIONS)
      expect({ path: e.path, reason: e.reason.trim() !== "" }).toEqual({
        path: e.path,
        reason: true,
      });
  });

  it("fails closed on a URL that the tokenizer reads as a comment", () => {
    const text = 'const s = "";\nif (ok) /"/.test(s) && go("https://vendor.io/a");';
    expect(() => vendorHosts(core(text))).toThrow(
      "packages/core/src/a.ts:2: the vendor scan cannot read this line; a URL reads as a comment",
    );
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
      ...FOOTER_LINKS.map((l) => l.label),
      ...(Object.keys(SITE) as (keyof typeof SITE)[])
        .filter((key) => !ADDRESSES.includes(key))
        .map((key) => SITE[key]),
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
