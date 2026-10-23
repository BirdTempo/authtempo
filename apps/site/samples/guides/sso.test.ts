import { createHash } from "node:crypto";
import type { DnsTxtPort } from "@authtempo/core";
import { createTestIdp } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { API, call, harness, sessionCookieOf, signIn } from "../support/harness.ts";
import { addDomain, connectSaml, createSsoAuth } from "./sso.ts";

const OPERATOR = "sso-desk-secret-0123456789abcdef0123456789";
const BIND = "__Secure-tempo_session_oauth";

/** Two resolvers of a test: each answers the records that `zone` holds. */
function resolvers(zone: Map<string, string[]>): DnsTxtPort[] {
  return ["a", "b"].map((name) => ({ name, txt: async (n: string) => zone.get(n) ?? [] }));
}

/** base64 of a UTF-8 text, the form of `SAMLResponse`. */
function b64(xml: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(xml)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function setup() {
  const h = harness();
  const zone = new Map<string, string[]>();
  const auth = createSsoAuth(h, {
    operatorHash: createHash("sha256").update(OPERATOR).digest("hex"),
    dns: resolvers(zone),
  });
  return { h, zone, auth };
}

describe("enterprise SSO", () => {
  it("proves a domain, signs a person in through SAML, enforces SSO, and lets the operator turn it off", async () => {
    const { h, zone, auth } = setup();
    // The owner signs in from another domain, so the enforce flag below does not shut the owner out.
    const owner = await signIn(auth, h, "owner@owner.example");
    const made = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "acme", name: "Acme" },
      { cookie: owner },
    );
    const { organization } = (await made.json()) as { organization: { id: string } };

    // Step 1: the record to publish. Steps 2 to 4: the owner publishes it, and the app verifies.
    const domain = await addDomain(auth, organization.id, "acme.example");
    expect(domain.record?.name).toBe("_authtempo-challenge.acme.example");
    expect(domain.record?.value).toMatch(/^authtempo-domain=/);
    zone.set(domain.record?.name ?? "", [domain.record?.value ?? ""]);
    const idp = await createTestIdp({ alg: "rsa", entityId: "https://idp.acme.example" });
    const { connectionId, spEntityId, acsUrl } = await connectSaml(auth, {
      organizationId: organization.id,
      domainId: domain.id,
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.acme.example/sso",
      certificatePem: idp.certificatePem,
    });
    expect(spEntityId).toBe(`${API}/auth/sso/${connectionId}/metadata`);
    expect(acsUrl).toBe(`${API}/auth/sso/${connectionId}/acs`);

    // The start sends the browser to the provider with the AuthnRequest and a binding cookie.
    const start = await call(auth, "GET", `/auth/sso/${connectionId}/start?next=/home`);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://idp.acme.example/sso");
    const bind = start.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${BIND}=`))
      ?.split(";")[0];
    const inflated = await new Response(
      new Blob([
        Uint8Array.from(atob(location.searchParams.get("SAMLRequest") ?? ""), (c) =>
          c.charCodeAt(0),
        ),
      ])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw")),
    ).text();
    const requestId = /\bID="([^"]+)"/.exec(inflated)?.[1] ?? "";

    // The provider posts a signed Response to the ACS. A persistent NameID names the person.
    const now = new Date();
    const xml = await idp.response({
      audience: spEntityId,
      recipient: acsUrl,
      inResponseTo: requestId,
      nameId: "ada-1",
      attributes: { email: ["ada@acme.example"] },
      notBefore: new Date(now.getTime() - 60_000),
      notOnOrAfter: new Date(now.getTime() + 5 * 60_000),
      now,
    });
    const acs = await auth.handle(
      new Request(acsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://idp.acme.example",
          "sec-fetch-site": "cross-site",
          cookie: bind ?? "",
        },
        body: new URLSearchParams({
          SAMLResponse: b64(xml),
          RelayState: location.searchParams.get("RelayState") ?? "",
        }).toString(),
      }),
    );
    expect(acs.status).toBe(302);
    expect(acs.headers.get("location")).toBe("https://app.example.com/home");
    const session = sessionCookieOf(acs);
    const me = await call(auth, "GET", "/auth/session", undefined, { cookie: session });
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("ada@acme.example");

    // With enforce on, a magic link request gives its normal answer and sends no mail.
    const before = h.sent.length;
    const link = await call(auth, "POST", "/auth/magic-link/request", {
      email: "ada@acme.example",
    });
    expect(link.status).toBe(200);
    expect(h.sent).toHaveLength(before);

    // The provider is down: the operator turns enforce off with a reason.
    const off = await call(
      auth,
      "POST",
      "/auth/operator/sso/enforce-off",
      { domainId: domain.id, reason: "the provider of acme.example is down" },
      { authorization: `Operator ${OPERATOR}` },
    );
    expect(off.status).toBe(200);
    expect(((await off.json()) as { enforce: boolean }).enforce).toBe(false);
    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@acme.example" });
    expect(h.sent).toHaveLength(before + 1);
  });
});
