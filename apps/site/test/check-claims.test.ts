import { describe, expect, it } from "vitest";
import { ALLOWED_PHRASES, checkClaims } from "../scripts/check-claims.ts";
import { otherNames } from "../src/data/compare.ts";

/** One root page with `body` in its main element. */
const page = (body: string) =>
  new Map([
    ["pricing/index.html", `<header>Auth0 $5</header><main id="main" class="x">${body}</main>`],
  ]);
const run = (body: string) => checkClaims({ pages: page(body), names: otherNames() }).failures;

// Spec 24 item 4 (final review m1 of plan 11b): no customer, quote, logo of
// another company, or price of another company outside /compare/.
describe("check-claims", () => {
  it("reads the name of each other product of the compare data, in full and in short", () => {
    expect(otherNames()).toEqual([
      "Better Auth",
      "Supabase Auth",
      "Supabase",
      "Clerk",
      "Auth0",
      "Firebase Auth",
      "Firebase",
      "Amazon Cognito",
      "Cognito",
      "WorkOS",
      "Auth.js",
    ]);
  });

  it("passes a page with no claim, and reads the main element only", () => {
    expect(run("<p>authtempo charges nothing. Workers Paid runs the hash.</p>")).toEqual([]);
  });

  it("fails a price of another company", () => {
    expect(run("<p>It costs $<span>35</span> a month.</p>")).toEqual([
      'pricing/index.html names a price: "$ 35"',
    ]);
    expect(run("<p>It costs 25 USD.</p>")).toEqual(['pricing/index.html names a price: "25 USD"']);
  });

  it("fails a quote and an image, as a logo", () => {
    for (const tag of ["blockquote", "q", "img", "picture", "figure"])
      expect(run(`<p>x</p><${tag} src="a">y</${tag}>`)).toEqual([
        `pricing/index.html has a ${tag} element`,
      ]);
  });

  it("fails a customer claim", () => {
    expect(run("<p>Trusted by Acme Corp.</p>")).toEqual([
      'pricing/index.html makes a customer claim: "Trusted by"',
    ]);
    expect(run("<p>Our customers say so.</p>")).toEqual([
      'pricing/index.html makes a customer claim: "customers"',
    ]);
  });

  it("fails a name of another product, also in short, as a whole word only", () => {
    expect(run("<p>Move from Auth0 or from Cognito.</p>")).toEqual([
      "pricing/index.html names Auth0",
      "pricing/index.html names Cognito",
    ]);
    expect(run("<p>The clerkship and Auth0x pass.</p>")).toEqual([]);
  });

  it("passes an allowed phrase of the compatibility package, and nothing more", () => {
    expect(ALLOWED_PHRASES.length).toBe(3);
    expect(
      run("<h2>Better Auth compatibility</h2><p>Run an app written for Better Auth.</p>"),
    ).toEqual([]);
    expect(run("<p>Better Auth compatibility. Better Auth is slow.</p>")).toEqual([
      "pricing/index.html names Better Auth",
    ]);
  });

  it("fails a page with no main element, and a run with no page", () => {
    const none = checkClaims({ pages: new Map([["a/index.html", "<p>$5</p>"]]), names: ["X"] });
    expect(none.failures).toEqual(["a/index.html has no main element"]);
    expect(checkClaims({ pages: new Map(), names: ["X"] }).failures).toEqual(["read 0 pages"]);
  });
});
