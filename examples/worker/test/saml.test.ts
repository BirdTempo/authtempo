import { createAuth, createMemoryAdapter } from "@authtempo/core";
import { createTestIdp } from "@authtempo/core/testing";
import { expect, it } from "vitest";

/**
 * The SAML service provider on workerd (plan 12d Task 8). The runtime has
 * `CompressionStream("deflate-raw")` for the redirect binding, and core's
 * own parser, canonicalizer, and signature check run with no Node module.
 * `checkResponse` is not a public entry, so the test runs it through the
 * ACS route. The steps are a start, a Response of the test IdP, and the post.
 */

const BASE = "https://example.test";
const APP = { kind: "app", name: "saml-example" } as const;

async function deflateRoundTrip(text: string): Promise<string> {
  const packed = await new Response(
    new Blob([new TextEncoder().encode(text)])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw")),
  ).arrayBuffer();
  return new Response(
    new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();
}

it("verifies a test IdP Response on workerd", async () => {
  expect(typeof CompressionStream).toBe("function");
  expect(await deflateRoundTrip("abc")).toBe("abc");

  const txt: Record<string, string[]> = {};
  const mail: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async (m) => void mail.push(m.text) },
    organizations: {},
    sso: { saml: true, dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }] },
  });
  const sso = auth.api.sso;
  if (!sso) throw new Error("no sso api");
  // The owner is verified by a magic link, a path of the product.
  await auth.api.requestMagicLink({ email: "owner@acme.example", ip: null });
  const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const owner = await auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
  if (!owner.ok || !("token" in owner.value)) throw new Error("no owner");
  const made = await auth.api.createOrganization({
    user: owner.value.user,
    slug: "acme",
    name: "Acme",
  });
  if (!made.ok) throw new Error(made.code);
  const organizationId = made.value.organization.id;
  const domain = await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" });
  if (!domain.ok || domain.value.record === null) throw new Error("no domain");
  txt[domain.value.record.name] = [domain.value.record.value];
  const verified = await sso.domains.verify({ actor: APP, id: domain.value.id });
  if (!verified.ok) throw new Error(verified.code);
  const idp = await createTestIdp({ alg: "ec" });
  const connection = await sso.connections.create({
    actor: APP,
    organizationId,
    kind: "saml",
    label: "Acme IdP",
    idpEntityId: idp.entityId,
    ssoUrl: "https://idp.example/sso",
    certificates: [idp.certificatePem],
  });
  if (!connection.ok) throw new Error(connection.code);
  const id = connection.value.id;

  const started = await auth.handle(new Request(`${BASE}/auth/sso/${id}/start?next=/home`));
  const location = new URL(started.headers.get("location") ?? "");
  const request = await new Response(
    new Blob([
      Uint8Array.from(atob(location.searchParams.get("SAMLRequest") ?? ""), (c) => c.charCodeAt(0)),
    ])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();
  const requestId = /\sID="([^"]+)"/.exec(request)?.[1] ?? "";
  const bind = started.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
    ?.split(";")[0];
  const now = new Date();
  const xml = await idp.response({
    audience: `${BASE}/auth/sso/${id}/metadata`,
    recipient: `${BASE}/auth/sso/${id}/acs`,
    inResponseTo: requestId,
    nameId: "ada-1",
    attributes: { email: ["ada@acme.example"] },
    notBefore: new Date(now.getTime() - 60_000),
    notOnOrAfter: new Date(now.getTime() + 5 * 60_000),
    now,
  });
  let bin = "";
  for (const b of new TextEncoder().encode(xml)) bin += String.fromCharCode(b);
  const res = await auth.handle(
    new Request(`${BASE}/auth/sso/${id}/acs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: bind ?? "" },
      body: new URLSearchParams({
        SAMLResponse: btoa(bin),
        RelayState: location.searchParams.get("RelayState") ?? "",
      }).toString(),
    }),
  );
  expect([res.status, res.headers.get("location")]).toEqual([302, `${BASE}/home`]);
  const session = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  expect(session).toMatch(/^__Host-tempo_session=ts_/);
});
