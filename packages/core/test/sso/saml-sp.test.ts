import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createConnection } from "../../src/engine/sso/connections.js";
import { importIdpMetadata } from "../../src/engine/sso/saml-sp.js";
import { sha256Hex } from "../../src/primitives/crypto.js";
import { childElements, parseXml } from "../../src/saml/xml.js";
import { attrOf, createTestIdp, type TestIdp } from "../../src/testing/saml-idp.js";
import { get } from "../helpers.js";
import { NS_SAML, NS_SAMLP } from "../saml/corpus.js";
import oneloginMetadata from "../saml/fixtures/real/crewjam-onelogin-idp-metadata.xml?raw";
import { SSO_APP, seedOrganization, verifiedDomain } from "./helpers.js";
import { orgWithSaml, samlConnection, samlSignIn, samlStart, samlWorld } from "./saml-helpers.js";

const NS_MD = "urn:oasis:names:tc:SAML:2.0:metadata";

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An IdP metadata document with one HTTP-Redirect service and the certificates of `idps`. */
function metadata(idps: TestIdp[], location = "https://idp.example/sso"): string {
  const keys = idps
    .map(
      (idp) =>
        '<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>' +
        idp.certificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").trim() +
        "</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>",
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<md:EntityDescriptor xmlns:md="${NS_MD}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"` +
    ' entityID="https://idp.example/metadata">' +
    '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">' +
    keys +
    // An encryption key gives no signing certificate.
    '<md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>AAAA' +
    "</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>" +
    '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/post"/>' +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${location}"/>` +
    "</md:IDPSSODescriptor></md:EntityDescriptor>"
  );
}

describe("the SAML service provider (plan 12d Task 8)", () => {
  it("sends an AuthnRequest by redirect with a request row", async () => {
    const w = samlWorld();
    const { connectionId } = await orgWithSaml(w);
    const start = await samlStart(w, connectionId);
    expect(`${start.location.origin}${start.location.pathname}`).toBe("https://idp.example/sso");
    const parsed = parseXml(start.request);
    if (!parsed.ok) throw new Error("no parse");
    const request = parsed.root;
    expect([request.ns, request.local]).toEqual([NS_SAMLP, "AuthnRequest"]);
    expect(start.requestId).toMatch(/^_[0-9a-f]{64}$/);
    expect(attrOf(request, "Version")).toBe("2.0");
    expect(attrOf(request, "Destination")).toBe("https://idp.example/sso");
    expect(attrOf(request, "AssertionConsumerServiceURL")).toBe(
      `https://api.example.com/auth/sso/${connectionId}/acs`,
    );
    expect(attrOf(request, "ProtocolBinding")).toBe(
      "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    );
    expect(attrOf(request, "IssueInstant")).toBe("2026-01-01T00:00:00Z");
    const [issuer] = childElements(request, NS_SAML, "Issuer");
    expect(issuer?.children).toEqual([
      { kind: "text", value: `https://api.example.com/auth/sso/${connectionId}/metadata` },
    ]);
    const [policy] = childElements(request, NS_SAMLP, "NameIDPolicy");
    expect(policy === undefined ? null : attrOf(policy, "Format")).toBe(
      "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    );
    expect(start.relayState).toMatch(/^rs_[A-Za-z0-9_-]{43}$/);
    const rows = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "saml-request" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identifier: connectionId,
      valueHash: await sha256Hex(start.relayState),
      consumedAt: null,
      expiresAt: new Date("2026-01-01T00:10:00.000Z"),
      data: { requestId: start.requestId, next: "/home", bindHash: await sha256Hex(start.bind) },
    });
  });

  it("answers the SP metadata of a connection", async () => {
    const w = samlWorld({ sso: { saml: true, oidc: true } });
    const { connectionId, organizationId } = await orgWithSaml(w);
    const res = await w.handle(get(`/auth/sso/${connectionId}/metadata`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/samlmetadata+xml");
    const parsed = parseXml(await res.text());
    if (!parsed.ok) throw new Error("no parse");
    expect([parsed.root.ns, parsed.root.local]).toEqual([NS_MD, "EntityDescriptor"]);
    expect(attrOf(parsed.root, "entityID")).toBe(
      `https://api.example.com/auth/sso/${connectionId}/metadata`,
    );
    const [sp, ...more] = childElements(parsed.root, NS_MD, "SPSSODescriptor");
    if (sp === undefined) throw new Error("no SPSSODescriptor");
    expect(more).toHaveLength(0);
    expect(attrOf(sp, "WantAssertionsSigned")).toBe("true");
    expect(attrOf(sp, "AuthnRequestsSigned")).toBe("false");
    expect(attrOf(sp, "protocolSupportEnumeration")).toBe("urn:oasis:names:tc:SAML:2.0:protocol");
    const services = childElements(sp, NS_MD, "AssertionConsumerService");
    expect(
      services.map((s) => [attrOf(s, "Binding"), attrOf(s, "Location"), attrOf(s, "index")]),
    ).toEqual([
      [
        "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
        `https://api.example.com/auth/sso/${connectionId}/acs`,
        "0",
      ],
    ]);
    // An unknown id and an OIDC connection answer 404.
    const unknown = await w.handle(get("/auth/sso/no-such-connection/metadata"));
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "sso_not_configured" }]);
    const oidc = await createConnection(w.config, SSO_APP, {
      organizationId,
      kind: "oidc",
      label: "OIDC",
      issuer: "https://login.acme-idp.example/v2.0",
      clientId: "acme-client",
      clientSecret: "acme-secret-0123456789",
    });
    if (!oidc.ok) throw new Error(oidc.code);
    const notSaml = await w.handle(get(`/auth/sso/${oidc.value.id}/metadata`));
    expect([notSaml.status, await notSaml.json()]).toEqual([404, { error: "sso_not_configured" }]);
  });

  it("imports IdP metadata and refuses a third certificate", async () => {
    const w = samlWorld();
    const organizationId = await seedOrganization(w, "acme");
    const [one, two, three] = await Promise.all([
      createTestIdp({ alg: "rsa" }),
      createTestIdp({ alg: "ec" }),
      createTestIdp({ alg: "rsa" }),
    ]);
    if (!one || !two || !three) throw new Error("no IdP");
    const create = (idpMetadata: string) =>
      createConnection(w.config, SSO_APP, {
        organizationId,
        kind: "saml",
        label: "From metadata",
        idpMetadata,
      });
    const made = await create(metadata([one, two]));
    if (!made.ok) throw new Error(`${made.code} ${made.message}`);
    expect(made.value.saml).toMatchObject({
      idpEntityId: "https://idp.example/metadata",
      ssoUrl: "https://idp.example/sso",
    });
    expect(made.value.saml?.certificates).toHaveLength(2);
    expect(await create(metadata([one, two, three]))).toMatchObject({
      ok: false,
      code: "invalid_body",
      message: "idpMetadata holds 1 or 2 signing certificates",
    });
    expect(await create(metadata([one], "http://idp.example/sso"))).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    // The host rule of a typed ssoUrl holds for a Location of the metadata too.
    expect(await create(metadata([one], "https://localhost/sso"))).toMatchObject({
      ok: false,
      code: "invalid_body",
      message: "ssoUrl must be an https URL of a public host",
    });
    // The metadata replaces the three fields; both at once is refused.
    expect(
      await createConnection(w.config, SSO_APP, {
        organizationId,
        kind: "saml",
        label: "Both",
        idpMetadata: metadata([one]),
        idpEntityId: "https://idp.example/metadata",
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    // The real OneLogin document lists only HTTP-POST and SOAP services.
    expect(importIdpMetadata(oneloginMetadata)).toMatchObject({
      ok: false,
      message: "idpMetadata holds one HTTP-Redirect SingleSignOnService with an https Location",
    });
    const redirect = oneloginMetadata.replace("bindings:SOAP", "bindings:HTTP-Redirect");
    const real = importIdpMetadata(redirect);
    if (!real.ok) throw new Error(real.message);
    expect(real.value.idpEntityId).toBe("https://app.onelogin.com/saml/metadata/503983");
    expect(real.value.certificates).toHaveLength(1);
    expect(importIdpMetadata(`${redirect}${" ".repeat(100 * 1024)}`)).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
  });

  it("warns once a day for an expired certificate", async () => {
    const w = samlWorld();
    const idp = await createTestIdp({
      alg: "rsa",
      certificateNotAfter: new Date("2025-06-01T00:00:00Z"),
    });
    const organizationId = await seedOrganization(w, "acme");
    await verifiedDomain(w, organizationId, "acme.example");
    const connectionId = await samlConnection(w, organizationId, idp);
    const line = "authtempo: saml certificate expired";
    const warnings = () => warn.mock.calls.filter((c) => c[0] === line);
    const first = await samlSignIn(w, connectionId, idp);
    // The expired certificate still verifies: the sign-in opens a session.
    expect(first.token).toMatch(/^ts_/);
    await samlSignIn(w, connectionId, idp);
    expect(warnings()).toEqual([[line, connectionId]]);
    w.clock.advance(86_400_000);
    const third = await samlSignIn(w, connectionId, idp);
    expect(third.token).toMatch(/^ts_/);
    expect(warnings()).toEqual([
      [line, connectionId],
      [line, connectionId],
    ]);
  });
});
