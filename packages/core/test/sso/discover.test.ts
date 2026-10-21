import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/engine/sso/connections.js";
import { updateDomain } from "../../src/engine/sso/domains.js";
import { signInPageResponse } from "../../src/http/sign-in-response.js";
import { BASE_URL, get, makeAuth, post } from "../helpers.js";
import { SSO_APP, seedOrganization, ssoAuth, verifiedDomain } from "./helpers.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

type World = ReturnType<typeof ssoAuth>;

/** An OIDC connection of the organization with fixed endpoints, made by the app. */
async function connection(w: World, organizationId: string, slug: string): Promise<string> {
  const host = `https://login.${slug}-idp.example`;
  const r = await createConnection(w.config, SSO_APP, {
    organizationId,
    kind: "oidc",
    label: slug,
    issuer: host,
    clientId: `${slug}-client`,
    clientSecret: `${slug}-secret-0123456789`,
    endpoints: {
      authorizeUrl: `${host}/authorize`,
      tokenUrl: `${host}/token`,
      jwksUrl: `${host}/keys`,
    },
  });
  if (!r.ok) throw new Error(r.code);
  return r.value.id;
}

/** A verified domain of the organization, routed to the connection. */
async function routed(
  w: World,
  organizationId: string,
  domain: string,
  connectionId: string,
  includeSubdomains = false,
) {
  const id = await verifiedDomain(w, organizationId, domain);
  const r = await updateDomain(w.config, SSO_APP, { id, connectionId, includeSubdomains });
  if (!r.ok) throw new Error(r.code);
}

/** Organization A holds `acme.example` with its subdomains; B holds `eu.acme.example`. */
async function world() {
  const w = ssoAuth({ sso: { oidc: true } });
  const a = await seedOrganization(w, "acme");
  const b = await seedOrganization(w, "globex");
  const ca = await connection(w, a, "acme");
  const cb = await connection(w, b, "globex");
  await routed(w, a, "acme.example", ca, true);
  await routed(w, b, "eu.acme.example", cb);
  return { w, ca, cb };
}

/** A JSON discovery through the router. */
async function discover(w: World, email: string, ip = "203.0.113.7") {
  return w.handle(post("/auth/sso/discover", { email }, { "cf-connecting-ip": ip }));
}

/** The `form-action` sources of a page answer. */
function formActionOf(res: Response): string[] {
  const policy = res.headers.get("content-security-policy") ?? "";
  const directive = policy.split(";").find((d) => d.trim().startsWith("form-action "));
  return directive?.trim().split(/\s+/).slice(1) ?? [];
}

/** True when a `form-action` source list admits the URL, for a page of `BASE_URL`. */
function admits(sources: string[], url: URL): boolean {
  return sources.some((s) =>
    s === "'self'"
      ? url.origin === BASE_URL
      : s.endsWith(":")
        ? url.protocol === s
        : url.origin === s,
  );
}

/**
 * The answers of a form post of the sign-in page, as Chromium follows them.
 * Chromium applies `form-action` to each redirect of the post. `hops` holds
 * each redirect target. `blocked` holds each target outside `sources`.
 * The walk follows a target of this origin with a GET, as the browser does.
 */
async function afterFormPost(w: World, sources: string[], fields: Record<string, string>) {
  const hops: string[] = [];
  const blocked: string[] = [];
  let last = await w.handle(formPost(fields));
  while (last.status === 302 || last.status === 303) {
    const target = new URL(last.headers.get("location") ?? "", BASE_URL);
    hops.push(target.href);
    if (!admits(sources, target)) blocked.push(target.href);
    if (target.origin !== BASE_URL) break;
    last = await w.handle(get(`${target.pathname}${target.search}`));
  }
  return { hops, blocked, last };
}

/** A form post of the sign-in page: same origin, no script. */
function formPost(fields: Record<string, string>): Request {
  return new Request(`${BASE_URL}/auth/sso/discover`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      "sec-fetch-site": "same-origin",
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("the discovery at sign-in (plan 12d Task 4)", () => {
  it("routes an address to the connection of its verified domain, the most specific first", async () => {
    const { w, ca, cb } = await world();
    expect(await (await discover(w, "x@eu.acme.example")).json()).toEqual({
      sso: true,
      start: `/auth/sso/${cb}/start`,
    });
    expect(await (await discover(w, "X@US.acme.example")).json()).toEqual({
      sso: true,
      start: `/auth/sso/${ca}/start`,
    });
    expect(await (await discover(w, "x@other.example")).json()).toEqual({ sso: false });
  });

  it("answers the same for an address with and without a user", async () => {
    const { w } = await world();
    await w.seedUser("known@acme.example");
    const known = await discover(w, "known@acme.example");
    const unknown = await discover(w, "unknown@acme.example");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
  });

  it("ends the form post on this origin, so form-action never stops the step to the IdP", async () => {
    const { w, cb } = await world();
    const sources = formActionOf(signInPageResponse(w.config, "/auth/handoff/continue?h=1"));
    expect(sources).toEqual(["'self'", "https://app.example.com"]);
    const next = "/auth/handoff/continue?h=1";
    const sso = await afterFormPost(w, sources, { email: "x@eu.acme.example", next });
    // No redirect follows the post, so Chromium applies form-action to none.
    expect(sso.blocked).toEqual([]);
    expect(sso.hops).toEqual([]);
    const page = sso.last;
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.example.com; base-uri 'none'; frame-ancestors 'none'",
    );
    const html = await page.text();
    const start = `/auth/sso/${cb}/start?next=${encodeURIComponent(next)}`;
    const escaped = start.replaceAll("&", "&amp;");
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${escaped}">`);
    expect(html).toContain(`<a href="${escaped}">Continue</a>`);
    expect(html).not.toContain("<script");
    // The page goes on with a GET, a navigation that is not a form post. The start then sends the browser to the IdP.
    const go = await w.handle(get(start));
    expect(go.status).toBe(302);
    expect(new URL(go.headers.get("location") ?? "").origin).toBe(
      "https://login.globex-idp.example",
    );
    // An address with no SSO goes to the error page of the app, an origin of form-action.
    const none = await afterFormPost(w, sources, { email: "x@other.example" });
    expect(none.blocked).toEqual([]);
    expect(none.hops).toEqual(["https://api.example.com/?auth_error=sso_not_configured"]);
    // A form post with no address goes there too.
    const bad = await afterFormPost(w, sources, { mail: "x" });
    expect(bad.blocked).toEqual([]);
    expect(bad.hops).toEqual(["https://api.example.com/?auth_error=invalid_body"]);
  });

  it("refuses a body with no address, and counts the calls of one IP", async () => {
    const { w } = await world();
    const bad = await w.handle(post("/auth/sso/discover", { mail: "x" }));
    expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid_body" }]);
    for (let i = 0; i < 30; i++)
      expect((await discover(w, "x@acme.example", "198.51.100.3")).status).toBe(200);
    const over = await discover(w, "x@acme.example", "198.51.100.3");
    expect([over.status, await over.json()]).toEqual([429, { error: "rate_limited" }]);
  });

  it("shows the form Sign in with SSO on the sign-in page only while sso is on", async () => {
    const { w } = await world();
    const page = await signInPageResponse(w.config, "/auth/handoff/continue?h=1").text();
    expect(page).toContain('<form id="sso" method="post" action="/auth/sso/discover"');
    expect(page).toContain('<label for="sso-email">Sign in with SSO</label>');
    expect(page).toContain('<input type="hidden" name="next" value="/auth/handoff/continue?h=1">');
    expect(page).toContain('<button type="submit">Continue</button>');
    const off = await signInPageResponse(makeAuth().config, "/auth/handoff/continue?h=1").text();
    expect(off).not.toContain("Sign in with SSO");
  });
});
