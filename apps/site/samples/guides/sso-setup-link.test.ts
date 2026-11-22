import { createAuth, dohGoogle } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import {
  createSetupAuth,
  mintSetupLink,
  ownerClient,
  reviewAndActivate,
} from "./sso-setup-link.ts";

/** A fetch that keeps each request and answers each one with the next body. */
function stubFetch(bodies: unknown[]) {
  const seen: { method: string; url: URL; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const text = await req.text();
    seen.push({
      method: req.method,
      url: new URL(req.url),
      body: text === "" ? undefined : JSON.parse(text),
    });
    return Response.json(bodies.shift() ?? {});
  };
  return { fetchImpl, seen };
}

describe("setup link sample", () => {
  it("builds the auth with sso.setup on and answers a bad link with one code", async () => {
    const h = harness();
    const auth = createSetupAuth(h);
    // The page only asks to confirm. It opens no session, so it says nothing of the token.
    const page = await call(auth, "GET", "/auth/sso/setup?token=tsl_wrong");
    expect(page.status).toBe(200);
    expect(page.headers.getSetCookie()).toEqual([]);
    const res = await call(auth, "POST", "/auth/sso/setup/open", { token: "tsl_wrong" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "setup_link_invalid" });
  });

  it("refuses a config that turns the notices off, because no owner would learn of a setup", () => {
    const h = harness();
    expect(() =>
      createAuth({
        baseURL: "https://api.example.com",
        trustedOrigins: [],
        secret: h.secret,
        storage: h.storage,
        mail: h.mail,
        organizations: {},
        sso: { oidc: true, dns: [dohGoogle(fetch)], setup: {} },
        account: { notices: false },
      }),
    ).toThrow(/account\.notices/);
  });

  it("refuses sso.setup without organizations", () => {
    const h = harness();
    expect(() =>
      createAuth({
        baseURL: "https://api.example.com",
        trustedOrigins: [],
        secret: h.secret,
        storage: h.storage,
        mail: h.mail,
        sso: { oidc: true, dns: [dohGoogle(fetch)], setup: {} },
      }),
    ).toThrow(/organizations/);
  });

  it("mints a link with the organization in the query and the rest in the body", async () => {
    const { fetchImpl, seen } = stubFetch([
      { id: "lnk1", token: "tsl_secret value", expiresAt: "2026-11-24T00:00:00.000Z" },
    ]);
    const address = await mintSetupLink(ownerClient(fetchImpl), "org1");
    expect(address).toBe("https://api.example.com/auth/sso/setup?token=tsl_secret%20value");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url.pathname).toBe("/auth/sso/setup-links/create");
    expect(seen[0]?.url.searchParams.get("organizationId")).toBe("org1");
    expect(seen[0]?.body).toMatchObject({ steps: ["domain", "connection", "directory"] });
  });

  it("revokes a link whose preview the owner refuses, and activates one that the owner accepts", async () => {
    const refuse = stubFetch([{ link: { id: "lnk1" }, preview: { domains: [] } }, { ok: true }]);
    expect(await reviewAndActivate(ownerClient(refuse.fetchImpl), "lnk1", () => false)).toBeNull();
    expect(refuse.seen.map((s) => s.url.pathname)).toEqual([
      "/auth/sso/setup-links/get",
      "/auth/sso/setup-links/revoke",
    ]);
    const accept = stubFetch([
      { link: { id: "lnk1" }, preview: { domains: [] } },
      { connection: { id: "con1" } },
    ]);
    await reviewAndActivate(ownerClient(accept.fetchImpl), "lnk1", () => true);
    expect(accept.seen.map((s) => s.url.pathname)).toEqual([
      "/auth/sso/setup-links/get",
      "/auth/sso/setup-links/activate",
    ]);
  });
});
