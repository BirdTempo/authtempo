import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/engine/sso/connections.js";
import { updateDomain } from "../../src/engine/sso/domains.js";
import { signInPageResponse } from "../../src/http/sign-in-response.js";
import { BASE_URL, makeAuth, post } from "../helpers.js";
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

  it("follows the form post with 303", async () => {
    const { w, cb } = await world();
    const res = await w.handle(formPost({ email: "x@eu.acme.example" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/auth/sso/${cb}/start`);
    // The landing path of the page goes on to the start.
    const next = await w.handle(
      formPost({ email: "x@eu.acme.example", next: "/auth/handoff/continue?h=1" }),
    );
    expect(next.headers.get("location")).toBe(
      `/auth/sso/${cb}/start?next=${encodeURIComponent("/auth/handoff/continue?h=1")}`,
    );
    // An address with no SSO goes to the error page of the app.
    const none = await w.handle(formPost({ email: "x@other.example" }));
    expect(none.status).toBe(302);
    expect(none.headers.get("location")).toBe(
      "https://api.example.com/?auth_error=sso_not_configured",
    );
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
