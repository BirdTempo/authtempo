import { routeAnchor } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { checkErrors, type RouteCodes } from "../scripts/check-errors.ts";

/** A link of a Routes cell, as the site build writes it. */
function link(route: string): string {
  const [method = "", path = ""] = route.split(" ");
  return `<a href="/docs/reference/routes/#${routeAnchor(method, path)}"><code dir="auto">${route}</code></a>`;
}

/** The Routes table of a code, as the site build writes a one-column table. */
function cell(text: string): string {
  return `<table>\n<thead>\n<tr>\n<th>Routes</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>${text}</td>\n</tr>\n</tbody>\n</table>`;
}

/** A Routes cell in the form of the page: each route linked, then a full stop. */
function list(...routes: string[]): string {
  return cell(`${routes.map(link).join(", ")}.`);
}

const core = { invalid_token: 400, rate_limited: 429 };
const oauth = { invalid_token: 401 };
const routes: RouteCodes[] = [
  { method: "GET", path: "/magic-link/verify", codes: ["invalid_token"], oauthCodes: [] },
  {
    method: "POST",
    path: "/magic-link/verify",
    codes: ["invalid_token", "rate_limited"],
    oauthCodes: [],
  },
  { method: "POST", path: "/reauth", codes: ["invalid_token"], oauthCodes: [] },
  { method: "GET", path: "/oauth/userinfo", codes: [], oauthCodes: ["invalid_token"] },
];
const page = `<h2 id="core">Core</h2>
<h3 id="invalid_token"><code>invalid_token</code> 400</h3>
${list("GET /magic-link/verify", "POST /magic-link/verify", "POST /reauth")}
<h3 id="rate_limited"><code>rate_limited</code> 429</h3>
${list("POST /magic-link/verify")}
<h3 id="oauth-invalid_token"><code>invalid_token</code> 401</h3>
${list("GET /oauth/userinfo")}`;

describe("checkErrors", () => {
  it("passes a page with one anchor and the right status per code of both tables", () => {
    const r = checkErrors(page, core, oauth, [], routes);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ codes: 3, anchors: 3, cells: 3, links: 5 });
  });

  it("refuses a code that ERRORS gains with no anchor on the page (plan 11a)", () => {
    const r = checkErrors(page, { ...core, new_code: 400 }, oauth, [], routes);
    expect(r.failures).toEqual(["core code new_code has no anchor #new_code"]);
  });

  it("refuses an anchor that names no code, and a status that differs from the table", () => {
    const r = checkErrors(
      `${page}\n<h3 id="gone"><code>gone</code> 400</h3>`,
      core,
      {
        invalid_token: 400,
      },
      [],
      routes,
    );
    expect(r.failures).toEqual([
      "#oauth-invalid_token says status 401; OAUTH_ERRORS says 400",
      "anchor #gone names no code",
    ]);
  });

  it("says a heading states no status, not undefined", () => {
    const r = checkErrors(
      `<h3 id="a"><code>a</code></h3>\n${list("GET /a")}`,
      { a: 400 },
      {},
      [],
      [{ method: "GET", path: "/a", codes: ["a"], oauthCodes: [] }],
    );
    expect(r.failures).toEqual(["#a states no status; ERRORS says 400"]);
  });

  it("fails on an empty page", () => {
    expect(checkErrors("", {}, {}, [], []).failures).toEqual([
      "read 0 codes",
      "read 0 anchors",
      "read 0 cells",
      "read 0 links",
    ]);
  });

  it("holds the storage codes: one anchor each, with no status, and no code of ERRORS (plan 12g)", () => {
    const storagePage = `${page}\n<h3 id="config_mismatch"><code>config_mismatch</code></h3>`;
    const r = checkErrors(storagePage, core, oauth, ["config_mismatch"], routes);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ codes: 4, anchors: 4, cells: 3, links: 5 });
    expect(checkErrors(page, core, oauth, ["config_mismatch"], routes).failures).toEqual([
      "storage code config_mismatch has no anchor #config_mismatch",
    ]);
    const withStatus = `${page}\n<h3 id="config_mismatch"><code>config_mismatch</code> 500</h3>`;
    expect(checkErrors(withStatus, core, oauth, ["config_mismatch"], routes).failures).toEqual([
      "#config_mismatch must state the code config_mismatch only; a storage code has no status",
    ]);
    expect(checkErrors(page, core, oauth, ["rate_limited"], routes).failures).toEqual([
      "storage code rate_limited is also in ERRORS; the anchor #rate_limited cannot be both",
    ]);
  });

  // The Routes cell of a code against ROUTES (12i follow-up (1), decision 4 of plan 12n).
  it("refuses a Routes cell that omits a route, with a line that names the route and the code", () => {
    const omits = page.replace(
      list("GET /magic-link/verify", "POST /magic-link/verify", "POST /reauth"),
      list("GET /magic-link/verify", "POST /magic-link/verify"),
    );
    expect(checkErrors(omits, core, oauth, [], routes).failures).toEqual([
      "#invalid_token: the Routes cell lacks POST /reauth, which answers invalid_token",
    ]);
  });

  it("refuses a Routes cell that links a route which does not declare the code", () => {
    const extra = page.replace(
      list("GET /oauth/userinfo"),
      list("GET /oauth/userinfo", "POST /reauth"),
    );
    expect(checkErrors(extra, core, oauth, [], routes).failures).toEqual([
      "#oauth-invalid_token: the Routes cell links POST /reauth, which does not answer invalid_token",
    ]);
  });

  it("refuses a code with no Routes cell", () => {
    const none = page.replace(list("POST /magic-link/verify"), "<p>No table.</p>");
    expect(checkErrors(none, core, oauth, [], routes).failures).toEqual([
      "#rate_limited has no Routes cell",
    ]);
  });

  it('passes "The routes of" a code only when the two codes have one route set', () => {
    const same = { ...core, captcha_required: 400, captcha_failed: 403 };
    const captcha: RouteCodes[] = [
      ...routes,
      {
        method: "POST",
        path: "/password/sign-up",
        codes: ["captcha_required", "captcha_failed"],
        oauthCodes: [],
      },
    ];
    const crossPage = `${page}
<h3 id="captcha_required"><code>captcha_required</code> 400</h3>
${list("POST /password/sign-up")}
<h3 id="captcha_failed"><code>captcha_failed</code> 403</h3>
${cell('The routes of <a href="#captcha_required"><code dir="auto">captcha_required</code></a>.')}`;
    expect(checkErrors(crossPage, same, oauth, [], captcha).failures).toEqual([]);
    const differ: RouteCodes[] = [
      ...captcha,
      { method: "POST", path: "/otp/request", codes: ["captcha_failed"], oauthCodes: [] },
    ];
    expect(checkErrors(crossPage, same, oauth, [], differ).failures).toEqual([
      "#captcha_failed: the Routes cell lacks POST /otp/request, which answers captcha_failed (it names the routes of #captcha_required)",
    ]);
  });

  it("passes the impersonation_session paragraph by name, and prints the reason", () => {
    const named = { ...core, impersonation_session: 403 };
    const r = checkErrors(
      `${page}\n<h3 id="impersonation_session"><code>impersonation_session</code> 403</h3>\n${cell("The Errors cell of each route names it.")}`,
      named,
      oauth,
      [],
      [
        ...routes,
        { method: "POST", path: "/sign-out", codes: ["impersonation_session"], oauthCodes: [] },
      ],
    );
    expect(r.failures).toEqual([]);
    expect(r.exempt?.some((e) => e.startsWith("#impersonation_session: "))).toBe(true);
  });

  it("passes the three named mentions, and refuses a mention that the page no longer has", () => {
    const named = { ...core, session_not_fresh: 403 };
    const fresh: RouteCodes[] = [
      ...routes,
      { method: "POST", path: "/sessions/revoke", codes: ["session_not_fresh"], oauthCodes: [] },
    ];
    const mention = `${link("POST /reauth")} makes the session fresh. ${link("POST /sessions/revoke")} needs one.`;
    const withMention = `${page}\n<h3 id="session_not_fresh"><code>session_not_fresh</code> 403</h3>\n${cell(mention)}`;
    const r = checkErrors(withMention, named, oauth, [], fresh);
    expect(r.failures).toEqual([]);
    expect(r.exempt?.some((e) => e.startsWith("#session_not_fresh: POST /reauth "))).toBe(true);
    const gone = withMention.replace(`${link("POST /reauth")} makes the session fresh. `, "");
    expect(checkErrors(gone, named, oauth, [], fresh).failures).toEqual([
      "#session_not_fresh: MENTIONS names POST /reauth, and the cell does not link it; remove the entry",
    ]);
  });

  it("keeps the router-level codes out, and refuses a route that declares one", () => {
    const named = { ...core, body_busy: 503 };
    const busyPage = `${page}\n<h3 id="body_busy"><code>body_busy</code> 503</h3>\n${cell("<code>POST /social/apple/callback</code>.")}`;
    // The Apple callback reads above the floor, so the body_busy cell names it (ruling 36 of plan 12n).
    const apple: RouteCodes = {
      method: "POST",
      path: "/social/apple/callback",
      codes: [],
      oauthCodes: [],
    };
    const r = checkErrors(busyPage, named, oauth, [], [...routes, apple]);
    expect(r.failures).toEqual([]);
    expect(r.exempt?.some((e) => e.startsWith("#body_busy: "))).toBe(true);
    const declares: RouteCodes[] = [...routes, { ...apple, codes: ["body_busy"] }];
    expect(checkErrors(busyPage, named, oauth, [], declares).failures).toEqual([
      "POST /social/apple/callback declares the router-level code body_busy; no entry may declare it",
    ]);
  });

  // Ruling 36 of plan 12n: a test for each failure line that had none.
  it('refuses "The routes of" an anchor that names no code', () => {
    const named = { ...core, captcha_failed: 403 };
    const crossPage = `${page}
<h3 id="captcha_failed"><code>captcha_failed</code> 403</h3>
${cell('The routes of <a href="#captcha_missing"><code dir="auto">captcha_missing</code></a>.')}`;
    expect(checkErrors(crossPage, named, oauth, [], routes).failures).toEqual([
      "#captcha_failed: the Routes cell names the routes of #captcha_missing, which is no code",
    ]);
  });

  it("refuses a mention whose route declares the code", () => {
    const named = { ...core, session_not_fresh: 403 };
    const declares: RouteCodes[] = [
      ...routes.map((x) =>
        x.path === "/reauth" ? { ...x, codes: [...x.codes, "session_not_fresh"] } : x,
      ),
      { method: "POST", path: "/sessions/revoke", codes: ["session_not_fresh"], oauthCodes: [] },
    ];
    const mention = `${link("POST /reauth")} makes the session fresh. ${link("POST /sessions/revoke")} needs one.`;
    const withMention = `${page}\n<h3 id="session_not_fresh"><code>session_not_fresh</code> 403</h3>\n${cell(mention)}`;
    expect(checkErrors(withMention, named, oauth, [], declares).failures).toEqual([
      "#session_not_fresh: MENTIONS names POST /reauth, and the route declares session_not_fresh; remove the entry",
    ]);
  });

  it("refuses a Routes cell that links one route twice", () => {
    const twice = page.replace(
      list("POST /magic-link/verify"),
      list("POST /magic-link/verify", "POST /magic-link/verify"),
    );
    expect(checkErrors(twice, core, oauth, [], routes).failures).toEqual([
      "#rate_limited: the Routes cell links POST /magic-link/verify more than once",
    ]);
  });

  it("holds the body_busy and body_timeout cells to the routes that read a body above the floor", () => {
    const named = { ...core, body_busy: 503, body_timeout: 408 };
    // The three routes of BODY_CAPS in core, then the SAML ACS of LARGE_FORM_READS.
    const all = [
      "POST /social/apple/callback",
      "POST /sso/connections/create",
      "POST /sso/connections/update",
      "POST /sso/:connectionId/acs",
    ];
    const large: RouteCodes[] = [
      ...routes,
      ...all.map((route) => {
        const [method = "", path = ""] = route.split(" ");
        return { method, path, codes: [], oauthCodes: [] };
      }),
    ];
    /** A cell in the form of the page: the routes in code spans, then the prose. */
    const spans = (names: string[]) =>
      cell(
        `${names.map((n) => `<code dir="auto">${n}</code>`).join(", ")}. The SCIM routes answer their own SCIM 503.`,
      );
    const pageOf = (busy: string[], timeout: string[]) => `${page}
<h3 id="body_busy"><code>body_busy</code> 503</h3>
${spans(busy)}
<h3 id="body_timeout"><code>body_timeout</code> 408</h3>
${spans(timeout)}`;
    const held = checkErrors(pageOf(all, all), named, oauth, [], large);
    expect(held.failures).toEqual([]);
    for (const id of ["body_busy", "body_timeout"])
      expect(
        held.exempt?.some((e) => e.startsWith(`#${id}: `) && e.endsWith("its cell to 4 routes")),
      ).toBe(true);
    const lacks = pageOf(
      all.filter((n) => n !== "POST /sso/connections/update"),
      all.filter((n) => n !== "POST /sso/:connectionId/acs"),
    );
    expect(checkErrors(lacks, named, oauth, [], large).failures).toEqual([
      "#body_busy: the Routes cell lacks POST /sso/connections/update, which reads a body above the floor",
      "#body_timeout: the Routes cell lacks POST /sso/:connectionId/acs, which reads a body above the floor",
    ]);
    expect(
      checkErrors(pageOf([...all, "POST /reauth"], all), named, oauth, [], large).failures,
    ).toEqual([
      "#body_busy: the Routes cell names POST /reauth, which reads no body above the floor",
    ]);
  });
});
