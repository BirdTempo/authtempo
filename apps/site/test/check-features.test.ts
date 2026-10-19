import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFeatures } from "../scripts/check-features.ts";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { FEATURES_PROSE_PATH, featuresProsePage } from "../scripts/lib/features-prose.ts";
import { docsPages } from "../scripts/lib/load.ts";
import { SITE } from "../scripts/lib/paths.ts";
import { prosePages } from "../scripts/lib/prose.ts";
import { FEATURES_PAGE, PACKAGE_FEATURES } from "../src/data/features.ts";

/** Two route features and two package folders, with a guide page each. */
const FEATURES = {
  passkey: { title: "Passkeys", line: "Sign in with a passkey.", guide: "/docs/guides/passkeys/" },
  openapi: {
    title: "OpenAPI document",
    line: "The document of the routes.",
    guide: "/docs/reference/openapi/#before-you-start",
  },
};
const ROUTES = [{ feature: "passkey" }, { feature: "openapi" }, { feature: "passkey" }];
const PACKAGES = {
  client: { title: "Client", line: "The app side.", guide: "/docs/reference/client/" },
};
const EXEMPT = { core: "every route feature is a row of FEATURES" };

/** The built pages that the guides name, by their path in dist. */
const PAGES = new Map([
  ["docs/guides/passkeys/index.html", "<h1>Passkeys</h1>"],
  ["docs/reference/openapi/index.html", '<h2 id="before-you-start">Before you start</h2>'],
  ["docs/reference/client/index.html", "<h1>Client</h1>"],
]);

/** One section as features.astro writes it: the title links the guide, then the line and the count. */
function section(id: string, guide: string, title: string, line: string, count = ""): string {
  return `<section id="${id}" class="card astro-x"><h3><a href="${guide}">${title}</a></h3><p class="line">${line}</p>${count}</section>`;
}

/** A /features/ page with one section per feature and per package. */
function page(passkeyRoutes = "2 routes"): string {
  return [
    section(
      "passkey",
      "/docs/guides/passkeys/",
      "Passkeys",
      "Sign in with a passkey.",
      `<p>${passkeyRoutes}</p>`,
    ),
    section(
      "openapi",
      "/docs/reference/openapi/#before-you-start",
      "OpenAPI document",
      "The document of the routes.",
      "<p>1 route</p>",
    ),
    section("pkg-client", "/docs/reference/client/", "Client", "The app side."),
  ].join("");
}

/** The input of a passing run, with each part open to a change. */
function input(change: Partial<Parameters<typeof checkFeatures>[0]> = {}) {
  return {
    folders: ["client", "core"],
    built: page(),
    files: new Set(PAGES.keys()),
    read: (file: string) => PAGES.get(file) ?? null,
    features: FEATURES,
    routes: ROUTES,
    packages: PACKAGES,
    exempt: EXEMPT,
    ...change,
  };
}

describe("checkFeatures", () => {
  it("passes when each folder has a row and each guide a page", () => {
    const r = checkFeatures(input());
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ features: 2, packages: 1, exempt: 1 });
    expect(r.exempt).toEqual(["packages/core: every route feature is a row of FEATURES"]);
  });

  it("fails a folder with no row and no exemption", () => {
    const r = checkFeatures(input({ folders: ["client", "core", "zz-probe"] }));
    expect(r.failures).toEqual([
      "packages/zz-probe has no row in PACKAGE_FEATURES and no exemption",
    ]);
  });

  it("fails a folder with a row and an exemption", () => {
    const r = checkFeatures(
      input({ exempt: { ...EXEMPT, client: "a test package of the SDKs, not a feature" } }),
    );
    expect(r.failures).toEqual([
      "packages/client has a row in PACKAGE_FEATURES and an exemption; keep one",
    ]);
  });

  it("fails a row or an exemption with no folder", () => {
    const r = checkFeatures(input({ folders: ["client"] }));
    expect(r.failures).toEqual(["PACKAGE_EXEMPT names core, which is not a folder of packages/"]);
  });

  it("fails a guide that names no page", () => {
    const r = checkFeatures(
      input({ packages: { client: { ...PACKAGES.client, guide: "/docs/reference/nothing/" } } }),
    );
    expect(r.failures).toEqual([
      "PACKAGE_FEATURES.client: the guide /docs/reference/nothing/ names no page of the build",
      // The built section still links the old guide, so it fails the link rule too.
      "/features/#pkg-client does not link its guide /docs/reference/nothing/",
    ]);
  });

  it("fails a guide anchor that the page does not hold", () => {
    const r = checkFeatures(
      input({
        features: {
          ...FEATURES,
          openapi: { ...FEATURES.openapi, guide: "/docs/reference/openapi/#steps" },
        },
      }),
    );
    expect(r.failures).toEqual([
      "FEATURES.openapi: the guide /docs/reference/openapi/#steps names no id steps on its page",
      "/features/#openapi does not link its guide /docs/reference/openapi/#steps",
    ]);
  });

  it("fails a feature section with another route count", () => {
    const r = checkFeatures(input({ built: page("0 routes") }));
    expect(r.failures).toEqual(["/features/#passkey says 0 routes; ROUTES has 2"]);
  });

  it("fails a feature section with no route count", () => {
    const r = checkFeatures(input({ built: page("") }));
    expect(r.failures).toEqual(["/features/#passkey states no route count; ROUTES has 2"]);
  });

  it("fails a feature or a package with no section, or with two", () => {
    const built = page().replace('id="openapi"', 'id="other"');
    const r = checkFeatures(
      input({ built: `${built}<section id="pkg-client"><h3>Client</h3></section>` }),
    );
    expect(r.failures).toEqual([
      '/features/ has 0 sections with id="openapi"; it needs 1',
      '/features/ has 2 sections with id="pkg-client"; it needs 1',
    ]);
  });

  it("fails a section that does not link its guide, for a feature and a package", () => {
    const built = page()
      .replace('href="/docs/guides/passkeys/"', 'href="/docs/"')
      .replace('href="/docs/reference/client/"', 'href="/docs/"');
    const r = checkFeatures(input({ built }));
    expect(r.failures).toEqual([
      "/features/#passkey does not link its guide /docs/guides/passkeys/",
      "/features/#pkg-client does not link its guide /docs/reference/client/",
    ]);
  });

  it("fails a section that does not show its line, for a feature and a package", () => {
    const built = page()
      .replace('<p class="line">Sign in with a passkey.</p>', "")
      .replace('<p class="line">The app side.</p>', '<p class="line">Another line.</p>');
    const r = checkFeatures(input({ built }));
    expect(r.failures).toEqual([
      '/features/#passkey does not show its line "Sign in with a passkey."',
      '/features/#pkg-client does not show its line "The app side."',
    ]);
  });

  it("reads the route count from the text of the section, not from its open tag", () => {
    const built = page().replace(
      '<section id="passkey"',
      '<section id="passkey" data-note="2 routes"',
    );
    const r = checkFeatures(input({ built: built.replace("<p>2 routes</p>", "") }));
    expect(r.failures).toEqual(["/features/#passkey states no route count; ROUTES has 2"]);
  });

  it("fails on zero folders", () => {
    const r = checkFeatures(input({ folders: [], packages: {}, exempt: {} }));
    expect(r.failures).toEqual(["read 0 folders of packages/"]);
  });
});

describe("the check runner (ruling 11 of the plan 11b lane)", () => {
  // A row that stops calling its list stays green on every fixture, so the rows are read as text.
  const runner = readFileSync(`${SITE}scripts/check.ts`, "utf8");

  it("runs the prose rows and the site page row on their lists", () => {
    for (const call of [
      "checkTerms(prosePages())",
      "checkSentences(prosePages())",
      "checkSitePages(sitePages(), rootPages(), MINIMUM_ENTRIES)",
    ])
      expect({ call, found: runner.includes(call) }).toEqual({ call, found: true });
  });
});

describe("the prose of /features/ (plan 11b)", () => {
  it("puts each label and each package title and line in the prose page as its own paragraph", () => {
    const body = featuresProsePage().source.split("\n---\n")[1] ?? "";
    const paragraphs = body.split("\n\n").map((p) => p.trim());
    for (const text of [
      ...Object.values(FEATURES_PAGE),
      ...Object.values(PACKAGE_FEATURES).flatMap((p) => [p.title, p.line]),
    ])
      expect({ text, found: paragraphs.includes(text) }).toEqual({ text, found: true });
  });

  it("keeps the prose inside the term and sentence rules, through the one prose list", () => {
    expect(prosePages().map((p) => p.path)).toContain(FEATURES_PROSE_PATH);
    expect(checkTerms([...docsPages(), featuresProsePage()]).failures).toEqual([]);
    expect(checkSentences([featuresProsePage()]).failures).toEqual([]);
  });
});
