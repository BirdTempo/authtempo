import { readFileSync } from "node:fs";
import { openApiDocument, openApiJson, openApiReferenceOptions } from "@authtempo/core/openapi";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { checkRoutes } from "../scripts/check-routes.ts";
import { routeAnchor } from "../scripts/lib/anchors.ts";

// Six real entries and their rows on a page in the forms of plan 11g Task 9.
const KEYS = [
  "POST /sign-out",
  "POST /magic-link/request",
  "GET /magic-link/verify",
  "POST /tokens",
  "GET /tokens/current",
  "POST /oauth/revoke",
];
const routes = ROUTES.filter((r) => KEYS.includes(`${r.method} ${r.path}`));
const page = readFileSync(new URL("./fixtures/openapi/routes.html", import.meta.url), "utf8");
// The parsed site document, as check.ts reads it from dist.
const doc = JSON.parse(openApiJson(openApiDocument(openApiReferenceOptions()))) as unknown;

/** The fixture page with one text replaced. It throws when the text is not in the page. */
function edit(from: string, to: string): string {
  if (!page.includes(from)) throw new Error(`the fixture lacks ${from}`);
  return page.replace(from, to);
}

describe("checkRoutes", () => {
  it("builds one anchor per route", () => {
    expect(routeAnchor("POST", "/social/:provider/start")).toBe("post-social-provider-start");
    expect(routeAnchor("GET", "/.well-known/openid-configuration")).toBe(
      "get-well-known-openid-configuration",
    );
  });

  it("passes a page with one heading per route and the three cells of each", () => {
    expect(routes).toHaveLength(6);
    const r = checkRoutes(page, routes, doc);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ routes: 6, anchors: 6, cells: 18, rules: 9 });
  });

  it("refuses a route with no anchor, an anchor with no route, and a heading that names another route", () => {
    const r = checkRoutes(
      `${edit("<code>POST /tokens</code>", "<code>GET /tokens</code>")}\n<h3 id="get-gone"><code>GET /gone</code></h3>`,
      [...routes, { method: "POST", path: "/gone", auth: ["none"], codes: [], oauthCodes: [] }],
      doc,
    );
    expect(r.failures).toEqual([
      "#post-tokens names GET /tokens; the route is POST /tokens",
      "route POST /gone has no anchor #post-gone",
      "anchor #get-gone names no route",
    ]);
  });

  it("fails when the Errors cell lacks a declared code", () => {
    const r = checkRoutes(
      edit(
        ', <a href="/docs/reference/errors/#token_limit"><code dir="auto">token_limit</code></a>',
        "",
      ),
      routes,
      doc,
    );
    expect(r.failures).toEqual(["POST /tokens: Errors lacks token_limit"]);
  });

  it("fails when the Errors cell names a code that the route does not declare", () => {
    const r = checkRoutes(
      edit(
        '<a href="/docs/reference/errors/#oauth-invalid_request">',
        '<a href="/docs/reference/errors/#not_found"><code dir="auto">not_found</code></a>, <a href="/docs/reference/errors/#oauth-invalid_request">',
      ),
      routes,
      doc,
    );
    expect(r.failures).toEqual([
      "POST /oauth/revoke: Errors names not_found; the route does not declare it",
    ]);
  });

  it("fails when the Errors cell links one code twice", () => {
    const link =
      '<a href="/docs/reference/errors/#token_limit"><code dir="auto">token_limit</code></a>';
    const r = checkRoutes(edit(link, `${link}, ${link}`), routes, doc);
    expect(r.failures).toEqual(["POST /tokens: Errors links token_limit more than once"]);
  });

  it("fails when the Needs cell differs from auth", () => {
    const r = checkRoutes(
      edit(
        'A <code dir="auto">tk_</code> bearer token',
        'A session cookie, or a <code dir="auto">ts_</code> bearer token',
      ),
      routes,
      doc,
    );
    expect(r.failures).toEqual(["GET /tokens/current: Needs names session; ROUTES says apiToken"]);
  });

  it("fails when the Needs cell drops one form of auth", () => {
    const r = checkRoutes(
      edit(
        'Nothing; or a session cookie, or a <code dir="auto">ts_</code> bearer token. A call',
        "Nothing. A call",
      ),
      routes,
      doc,
    );
    expect(r.failures).toEqual(["POST /sign-out: Needs names none; ROUTES says none, session"]);
  });

  it("fails when the Needs cell names the forms of auth in another order", () => {
    const r = checkRoutes(
      edit(
        'Nothing; or a session cookie, or a <code dir="auto">ts_</code> bearer token. A call',
        'A session cookie, or a <code dir="auto">ts_</code> bearer token; or nothing. A call',
      ),
      routes,
      doc,
    );
    expect(r.failures).toEqual([
      "POST /sign-out: Needs names session, none; ROUTES says none, session",
    ]);
  });

  it("fails when the Input cell differs from the document", () => {
    const r = checkRoutes(edit("{ email, next? }", "{ email, next?, extra }"), routes, doc);
    expect(r.failures).toEqual([
      "POST /magic-link/request: Input names extra; the document has email, next?",
    ]);
  });

  it("fails when the Input cell lacks a key, marks a required key optional, or names another media", () => {
    const lacks = checkRoutes(
      edit(
        "{ token, client_id?, client_secret?, client_assertion_type?, client_assertion? }",
        "{ token, client_secret?, client_assertion_type?, client_assertion? }",
      ),
      routes,
      doc,
    );
    expect(lacks.failures).toEqual([
      "POST /oauth/revoke: Input lacks client_id?; the document has token, client_id?, client_secret?, client_assertion_type?, client_assertion?",
    ]);
    const optional = checkRoutes(edit("{ token }", "{ token? }"), routes, doc);
    expect(optional.failures).toEqual([
      "GET /magic-link/verify: Input names token?; Input lacks token; the document has token",
    ]);
    const media = checkRoutes(edit("Form <code", "JSON <code"), routes, doc);
    expect(media.failures).toEqual(["POST /oauth/revoke: Input says JSON; the document has Form"]);
  });

  it("fails when the Input cell names a part that the document lacks, or lacks one that it has", () => {
    const extra = checkRoutes(
      edit(
        '<td>None</td>\n</tr>\n<tr>\n<td>Answer</td>\n<td><code dir="auto">{ token }',
        '<td>Query <code>{ id }</code></td>\n</tr>\n<tr>\n<td>Answer</td>\n<td><code dir="auto">{ token }',
      ),
      routes,
      doc,
    );
    expect(extra.failures).toEqual([
      "GET /tokens/current: Input has a Query part; the document has none",
    ]);
    const lacks = checkRoutes(edit('Query <code dir="auto">{ token }</code>', "None"), routes, doc);
    expect(lacks.failures).toEqual([
      "GET /magic-link/verify: Input has no Query part; the document has Query { token }",
    ]);
  });

  it("fails on a cell that does not parse", () => {
    const r = checkRoutes(
      edit("<td>Nothing</td>", "<td>No credential</td>")
        .replace('JSON <code dir="auto">{ email, next? }</code>', "Some JSON")
        // The sign-out cell: plan 12f declares impersonation_session there.
        .replace(
          '<td><a href="/docs/reference/errors/#impersonation_session"><code dir="auto">impersonation_session</code></a></td>\n</tr>\n</tbody>',
          "<td>No code</td>\n</tr>\n</tbody>",
        ),
      routes,
      doc,
    );
    expect(r.failures).toEqual([
      "POST /sign-out: the Errors cell does not parse: No code",
      "POST /magic-link/request: the Needs cell does not parse: No credential",
      "POST /magic-link/request: the Input cell does not parse: Some JSON",
    ]);
  });

  it("fails on a route with no table row of a field", () => {
    const r = checkRoutes(edit("<tr>\n<td>Needs</td>\n<td>Nothing</td>\n</tr>\n", ""), routes, doc);
    expect(r.failures).toEqual(["POST /magic-link/request: the table has no Needs row"]);
  });

  it("fails when the document has no operation of a route", () => {
    const r = checkRoutes(page, routes, { openapi: "3.1.2", paths: {} });
    expect(r.failures).toEqual([
      ...KEYS.map((k) => `${k}: the document has no operation`),
      "the document states no rule",
      "read 0 rules",
    ]);
    expect(checkRoutes(page, routes, null).failures).toEqual([
      "the built document is missing or is not JSON, so no Input cell is read",
      "read 0 rules",
    ]);
  });

  it("fails when it reads no route", () => {
    expect(checkRoutes("", [], doc).failures).toEqual([
      "the page has no section The rules of every route",
      "read 0 routes",
      "read 0 anchors",
      "read 0 cells",
      "read 0 rules",
    ]);
  });

  it("fails when the page and the document state other rules", () => {
    const exceptions =
      " Two routes are exceptions: Apple’s form post callback, and the token endpoint, which states its own rule.";
    const r = checkRoutes(edit(exceptions, ""), routes, doc);
    expect(r.failures).toEqual([
      "the page lacks the rule: A POST with an Origin header that is not baseURL and not in trustedOrigins answers 403 origin_not_trusted. Two routes are exceptions: Apple's form post callback, and the token endpoint, which states its own rule.",
      "the document lacks the rule: A POST with an Origin header that is not baseURL and not in trustedOrigins answers 403 origin_not_trusted.",
    ]);
    expect(r.counts.rules).toBe(8);
  });

  it("holds a rule of the cells to the page only", () => {
    const r = checkRoutes(
      edit("<li>The Needs cell names", "<li>The Input cell names"),
      routes,
      doc,
    );
    expect(r.failures).toEqual([
      'the document lacks the rule: The Input cell names each credential form that the route takes. "A session cookie, or a ts_ bearer token" is a session in either form.',
    ]);
  });
});
