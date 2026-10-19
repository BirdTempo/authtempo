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

/** A /features/ page with one section per feature and per package. */
function page(passkeyRoutes = "2 routes"): string {
  return [
    `<section id="passkey"><h3>Passkeys</h3><p>${passkeyRoutes}</p></section>`,
    '<section id="openapi"><h3>OpenAPI document</h3><p>1 route</p></section>',
    '<section id="pkg-client"><h3>Client</h3></section>',
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
