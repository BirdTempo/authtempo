import { createMemoryLimiter } from "@authtempo/core";
import { base32Decode, createTestIdp, totpCode } from "@authtempo/core/testing";
import { describe, expect, it, vi } from "vitest";
import { createAuthClient } from "../src/client/create-auth-client.js";
import { ssoClient } from "../src/client/plugins.js";
import { organization } from "../src/plugins.js";
import { checkOptions } from "../src/server/check-options.js";
import { compatHooks } from "../src/server/hooks.js";
import { betterAuthRecord, mapOptions } from "../src/server/map-options.js";
import { COOKIE_NAME } from "../src/server/shapes.js";
import { sso } from "../src/sso.js";
import type { BetterAuthOptions, CompatDatabase, SsoOptions } from "../src/types.js";
import { BASE, memory, PASSWORD, SECRET, ssoApp } from "./sso-helpers.js";

// Plan 12d Task 14: @better-auth/sso 1.7.2 on core's SSO. The option names,
// the paths, and the record of the domain proof were read in the 1.7.2
// tarball on 2026-10-22 (index-sM6JWXeV.d.mts and dist/index.mjs).

const dnsPort = { name: "a", txt: async () => [] };

/** The options of an app with the sso plugin and `o`. */
function withSso(o: SsoOptions, extra: Partial<BetterAuthOptions> = {}): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: SECRET,
    database: memory(),
    authtempo: { ssoDns: [dnsPort] },
    plugins: [organization({ sendInvitationEmail: async () => {} }), sso(o)],
    ...extra,
  };
}

const OIDC = {
  clientId: "acme-client",
  clientSecret: "acme-secret-value",
  skipDiscovery: true,
  authorizationEndpoint: "https://idp.acme.example/authorize",
  tokenEndpoint: "https://idp.acme.example/token",
  jwksEndpoint: "https://idp.acme.example/jwks",
  scopes: ["openid", "email", "profile"],
  pkce: true,
};

/** An app with an owner, an organization, and the sso plugin with `o`. */
async function owned(
  o: SsoOptions = { domainVerification: { enabled: true } },
  database: CompatDatabase = memory(),
) {
  const app = ssoApp(database, [sso(o)]);
  const owner = await app.manager("ann@acme.example");
  const organizationId = await app.organizationOf(owner, "acme");
  const register = (body: Record<string, unknown>) =>
    app.call("/sso/register", { organizationId, ...body }, owner.cookie);
  return { ...app, owner, organizationId, register };
}

/** The connections of the organization, read by the app. */
async function connectionsOf(app: Awaited<ReturnType<typeof owned>>) {
  const r = await app.auth.tempo.api.sso?.connections.list({
    actor: { kind: "app", name: "test" },
    organizationId: app.organizationId,
  });
  if (!r?.ok) throw new Error("no connections");
  return r.value;
}

async function domainsOf(app: Awaited<ReturnType<typeof owned>>) {
  const r = await app.auth.tempo.api.sso?.domains.list({
    actor: { kind: "app", name: "test" },
    organizationId: app.organizationId,
  });
  if (!r?.ok) throw new Error("no domains");
  return r.value;
}

describe("the sso plugin (plan 12d Task 14)", () => {
  it("maps each accepted sso option", async () => {
    const mapped = mapOptions(
      withSso({
        organizationProvisioning: { defaultRole: "admin" },
        disableImplicitSignUp: true,
        providersLimit: 3,
        domainVerification: { enabled: true, tokenPrefix: "acme-proof" },
        saml: { clockSkew: 60_000 },
      }),
    );
    expect(mapped.sso).toEqual({ defaultRole: "admin", jit: false, tokenPrefix: "acme-proof" });
    expect(mapped.config.sso).toMatchObject({
      oidc: true,
      saml: { clockSkewSeconds: 60 },
      limits: { connectionsPerOrganization: 3 },
    });
    const mappedSso = mapped.config.sso;
    expect(mappedSso === false ? null : mappedSso?.dns).toEqual([dnsPort]);
    // Better Auth's defaults apply first: 5 minutes of skew, 10 providers, the member role.
    const plain = mapOptions(withSso({}));
    expect(plain.config.sso).toMatchObject({
      saml: { clockSkewSeconds: 300 },
      limits: { connectionsPerOrganization: 10 },
    });
    expect(plain.sso).toEqual({
      defaultRole: "member",
      jit: true,
      tokenPrefix: "better-auth-token",
    });
    // Accepted, because core is at least as strict.
    const strict = checkOptions(
      withSso({
        trustEmailVerified: false,
        domainVerification: { enabled: true },
        saml: {
          requireTimestamps: true,
          maxResponseSize: 262_144,
          algorithms: { onDeprecated: "reject" },
          enableInResponseToValidation: true,
          allowIdpInitiated: false,
          enableSingleLogout: false,
        },
      }),
    );
    expect(strict.refusals).toEqual([]);
    // provisionUser runs as core's beforeSignIn: on a create, and on each sign-in when asked.
    const seen: unknown[] = [];
    const provisionUser = (d: unknown) => void seen.push(d);
    const connection = { label: "acme-oidc", organizationId: "org-1" };
    const profile = { subject: "s1", email: "bo@acme.example", name: "Bo", image: null };
    const hook = compatHooks(withSso({ provisionUser })).sso?.beforeSignIn;
    const event = (user: unknown) => ({ connection, profile, user }) as never;
    await hook?.(event(null));
    await hook?.(event({ id: "u1", email: "bo@acme.example", name: "Bo", emailVerified: true }));
    expect(seen).toEqual([
      {
        user: null,
        userInfo: { id: "s1", email: "bo@acme.example", name: "Bo", image: null },
        provider: { providerId: "acme-oidc", organizationId: "org-1" },
      },
    ]);
    const every = compatHooks(withSso({ provisionUser, provisionUserOnEveryLogin: true })).sso
      ?.beforeSignIn;
    await every?.(event({ id: "u1", email: "bo@acme.example", name: "Bo", emailVerified: true }));
    expect(seen).toHaveLength(2);
  });

  it("refuses each sso option with no core feature", () => {
    const rows: [SsoOptions, string][] = [
      [{ trustEmailVerified: true }, "plugins[sso].trustEmailVerified: "],
      [{ domainVerification: { enabled: false } }, "plugins[sso].domainVerification.enabled: "],
      [{ saml: { allowIdpInitiated: true } }, "plugins[sso].saml.allowIdpInitiated: "],
      [
        { saml: { enableInResponseToValidation: false } },
        "plugins[sso].saml.enableInResponseToValidation: ",
      ],
      [{ saml: { enableSingleLogout: true } }, "plugins[sso].saml.enableSingleLogout: "],
      [
        { saml: { algorithms: { onDeprecated: "warn" } } },
        "plugins[sso].saml.algorithms.onDeprecated: ",
      ],
      [{ saml: { clockSkew: 600_000 } }, "plugins[sso].saml.clockSkew: "],
      [{ saml: { maxResponseSize: 300_000 } }, "plugins[sso].saml.maxResponseSize: "],
      [{ resolvePrivateKey: async () => ({}) }, "plugins[sso].resolvePrivateKey: "],
      [{ redirectURI: "/sso/callback" }, "plugins[sso].redirectURI: "],
      [{ defaultSSO: [] }, "plugins[sso].defaultSSO: "],
      [
        { organizationProvisioning: { getRole: async () => "member" } },
        "plugins[sso].organizationProvisioning.getRole: ",
      ],
      [
        { organizationProvisioning: { disabled: true } },
        "plugins[sso].organizationProvisioning.disabled: ",
      ],
      [{ guardProviderMutation: async () => {} }, "plugins[sso].guardProviderMutation: "],
      [{ resolveUser: async () => ({}) }, "plugins[sso].resolveUser: "],
      [{ providersLimit: async () => 3 }, "plugins[sso].providersLimit: "],
      [{ providersLimit: 0 }, "plugins[sso].providersLimit: "],
      [{ modelName: "provider" }, "plugins[sso].modelName: "],
      [{ fields: {} }, "plugins[sso].fields: "],
      [{ schema: {} }, "plugins[sso].schema: "],
      [{ provisionUser: "no" as never }, "plugins[sso].provisionUser: "],
      [{ provisionUserOnEveryLogin: "yes" as never }, "plugins[sso].provisionUserOnEveryLogin: "],
      [{ disableImplicitSignUp: 1 as never }, "plugins[sso].disableImplicitSignUp: "],
      [{ defaultOverrideUserInfo: true }, "plugins[sso].defaultOverrideUserInfo: "],
      [
        { organizationProvisioning: { defaultRole: "owner" as never } },
        "plugins[sso].organizationProvisioning.defaultRole: ",
      ],
      [
        { domainVerification: { tokenPrefix: "Bad Prefix" } },
        "plugins[sso].domainVerification.tokenPrefix: ",
      ],
      [{ saml: { requireTimestamps: "yes" as never } }, "plugins[sso].saml.requireTimestamps: "],
      [{ saml: { clockSkew: 1500 } }, "plugins[sso].saml.clockSkew: "],
      [
        { saml: { algorithms: { allowedSignatureAlgorithms: [] } } },
        "plugins[sso].saml.algorithms.allowedSignatureAlgorithms: ",
      ],
      [
        { saml: { algorithms: { allowedDigestAlgorithms: [] } } },
        "plugins[sso].saml.algorithms.allowedDigestAlgorithms: ",
      ],
      [
        { saml: { algorithms: { allowedKeyEncryptionAlgorithms: [] } } },
        "plugins[sso].saml.algorithms.allowedKeyEncryptionAlgorithms: ",
      ],
      [
        { saml: { algorithms: { allowedDataEncryptionAlgorithms: [] } } },
        "plugins[sso].saml.algorithms.allowedDataEncryptionAlgorithms: ",
      ],
      [{ saml: { logoutRequestTTL: 1000 } }, "plugins[sso].saml.logoutRequestTTL: "],
      [{ saml: { wantLogoutRequestSigned: true } }, "plugins[sso].saml.wantLogoutRequestSigned: "],
      [
        { saml: { wantLogoutResponseSigned: true } },
        "plugins[sso].saml.wantLogoutResponseSigned: ",
      ],
      [{ saml: { idpInitiatedCallbackUrl: "/" } }, "plugins[sso].saml.idpInitiatedCallbackUrl: "],
      [{ saml: { other: 1 } as never }, "plugins[sso].saml.other: "],
      [{ other: 1 } as never, "plugins[sso].other: "],
    ];
    for (const [o, path] of rows) {
      const { refusals } = checkOptions(withSso(o));
      expect(
        refusals.filter((r) => r.startsWith(path)),
        path,
      ).toHaveLength(1);
      // Each message names the option and gives a reason.
      expect(refusals.find((r) => r.startsWith(path))?.length ?? 0).toBeGreaterThan(
        path.length + 10,
      );
    }
    // The plugin needs organizations and the DNS ports of the proof.
    const bare = checkOptions({ ...withSso({}), plugins: [sso({})] });
    expect(
      bare.refusals.some((r) => r.startsWith("plugins[sso]: needs plugins[organization]")),
    ).toBe(true);
    const noDns = checkOptions(withSso({}, { authtempo: {} }));
    expect(noDns.refusals.some((r) => r.startsWith("authtempo.ssoDns: required"))).toBe(true);
    const badDns = checkOptions(withSso({}, { authtempo: { ssoDns: [{ name: "x" }] as never } }));
    expect(badDns.refusals.some((r) => r.startsWith("authtempo.ssoDns: required"))).toBe(true);
    const strayDns = checkOptions({
      ...withSso({}),
      plugins: [organization({ sendInvitationEmail: async () => {} })],
    });
    expect(strayDns.refusals).toContain("authtempo.ssoDns: only with plugins[sso]");
    // Better Auth's options that core runs its own way are notes at construction, not silence.
    const notes = checkOptions(
      withSso({ provisionUser: () => {}, saml: { requestTTL: 1000, maxMetadataSize: 1000 } }),
    ).notes;
    for (const path of [
      "plugins[sso].provisionUser: ",
      "plugins[sso].saml.requestTTL: ",
      "plugins[sso].saml.maxMetadataSize: ",
      "plugins[sso].domainVerification: ",
    ])
      expect(
        notes.filter((n) => n.startsWith(path)),
        path,
      ).toHaveLength(1);
  });

  it("refuses each provider field with no core feature at the register call", async () => {
    // Each register counts on core's limit of the user before its read (ruling 51 Minor 1
    // of the 12j lane), and this test makes more calls than the 30 of the limit.
    // body-cap.test.ts tests the limit; here a limiter that allows each call.
    const app = await owned(undefined, { ...memory(), limiter: { allow: async () => true } });
    const rows: [Record<string, unknown>, string][] = [
      [
        { oidcConfig: { ...OIDC, tokenEndpointAuthentication: "private_key_jwt" } },
        "oidcConfig.tokenEndpointAuthentication",
      ],
      [{ oidcConfig: { ...OIDC, pkce: false } }, "oidcConfig.pkce"],
      [
        { oidcConfig: { ...OIDC, mapping: { email: "mail", name: "name" } } },
        "oidcConfig.mapping.email",
      ],
      [{ oidcConfig: { ...OIDC, overrideUserInfo: true } }, "oidcConfig.overrideUserInfo"],
      [{ samlConfig: { privateKey: "k" } }, "samlConfig.privateKey"],
      [
        { samlConfig: { idpMetadata: { entityID: "x", encPrivateKey: "k" } } },
        "samlConfig.idpMetadata.encPrivateKey",
      ],
      [
        { samlConfig: { idpMetadata: { entityID: "x", isAssertionEncrypted: true } } },
        "samlConfig.idpMetadata.isAssertionEncrypted",
      ],
      [{ samlConfig: { spMetadata: { isAssertionEncrypted: true } } }, "samlConfig.spMetadata"],
      [{ samlConfig: { wantAssertionsSigned: false } }, "samlConfig.wantAssertionsSigned"],
      [
        { samlConfig: { signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1" } },
        "samlConfig.signatureAlgorithm",
      ],
      [
        { samlConfig: { digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1" } },
        "samlConfig.digestAlgorithm",
      ],
      [
        { samlConfig: { idpMetadata: { entityID: "x", singleLogoutService: [] } } },
        "samlConfig.idpMetadata.singleLogoutService",
      ],
      [{ domain: "acme.example, beta.example" }, "domain"],
      [{ organizationId: undefined }, "organizationId"],
      [{ overrideUserInfo: true }, "overrideUserInfo"],
      [{ additional: "x" }, "additional"],
      [
        {
          oidcConfig: {
            ...OIDC,
            discoveryEndpoint: "https://other.example/.well-known/openid-configuration",
          },
        },
        "oidcConfig.discoveryEndpoint",
      ],
      [
        { oidcConfig: { ...OIDC, userInfoEndpoint: "https://idp.acme.example/userinfo" } },
        "oidcConfig.userInfoEndpoint",
      ],
      [{ oidcConfig: { ...OIDC, privateKeyId: "k1" } }, "oidcConfig.privateKeyId"],
      [{ oidcConfig: { ...OIDC, privateKeyAlgorithm: "ES256" } }, "oidcConfig.privateKeyAlgorithm"],
      [{ oidcConfig: { ...OIDC, allowIdpInitiated: true } }, "oidcConfig.allowIdpInitiated"],
      [
        { oidcConfig: { ...OIDC, mapping: { emailVerified: "email_verified" } } },
        "oidcConfig.mapping.emailVerified",
      ],
      [
        { oidcConfig: { ...OIDC, mapping: { extraFields: { a: "b" } } } },
        "oidcConfig.mapping.extraFields",
      ],
      [{ oidcConfig: { ...OIDC, mapping: { id: "sub" } } }, "oidcConfig.mapping.id"],
      [{ oidcConfig: { ...OIDC, other: 1 } }, "oidcConfig.other"],
      [
        {
          oidcConfig: {
            clientId: "c",
            clientSecret: "s",
            jwksEndpoint: "https://idp.acme.example/jwks",
          },
        },
        "oidcConfig.authorizationEndpoint",
      ],
      [
        { oidcConfig: { clientId: "c", clientSecret: "s", skipDiscovery: true } },
        "oidcConfig.skipDiscovery",
      ],
      [
        { samlConfig: { idpMetadata: { entityID: "x", singleSignOnService: [] } } },
        "samlConfig.idpMetadata.singleSignOnService",
      ],
      [
        { samlConfig: { idpMetadata: { entityID: "x", privateKeyPass: "p" } } },
        "samlConfig.idpMetadata.privateKeyPass",
      ],
      [
        { samlConfig: { idpMetadata: { entityID: "x", other: 1 } } },
        "samlConfig.idpMetadata.other",
      ],
      [
        { samlConfig: { mapping: { email: "email", name: "n", emailVerified: "v" } } },
        "samlConfig.mapping.emailVerified",
      ],
      [
        { samlConfig: { mapping: { email: "email", name: "n", firstName: "f" } } },
        "samlConfig.mapping.firstName",
      ],
      [
        { samlConfig: { mapping: { email: "email", name: "n", lastName: "l" } } },
        "samlConfig.mapping.lastName",
      ],
      [
        { samlConfig: { mapping: { email: "email", name: "n", extraFields: {} } } },
        "samlConfig.mapping.extraFields",
      ],
      [
        { samlConfig: { mapping: { email: "email", name: "n", other: "o" } } },
        "samlConfig.mapping.other",
      ],
      [
        {
          samlConfig: {
            identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
          },
        },
        "samlConfig.identifierFormat",
      ],
      [{ samlConfig: { authnRequestsSigned: true } }, "samlConfig.authnRequestsSigned"],
      [
        { samlConfig: { signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512" } },
        "samlConfig.signatureAlgorithm",
      ],
      [
        { samlConfig: { digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha512" } },
        "samlConfig.digestAlgorithm",
      ],
      [{ samlConfig: { audience: "x" } }, "samlConfig.audience"],
      [{ samlConfig: { callbackUrl: "/" } }, "samlConfig.callbackUrl"],
      [{ samlConfig: { idpInitiatedCallbackUrl: "/" } }, "samlConfig.idpInitiatedCallbackUrl"],
      [{ samlConfig: { other: 1 } }, "samlConfig.other"],
      [
        { samlConfig: { cert: "PEM", idpMetadata: { entityID: "x", cert: "PEM" } } },
        "samlConfig.cert",
      ],
      [
        {
          samlConfig: { entryPoint: "https://idp.example/sso", idpMetadata: { metadata: "<x/>" } },
        },
        "samlConfig.entryPoint",
      ],
    ];
    for (const [body, path] of rows) {
      const res = await app.register({
        providerId: "p1",
        issuer: "https://idp.acme.example",
        domain: "acme.example",
        ...("samlConfig" in body ? {} : { oidcConfig: OIDC }),
        ...body,
      });
      const answer = (await res.json()) as { code: string; message: string };
      expect([res.status, answer.code], path).toEqual([501, "NOT_SUPPORTED"]);
      expect(answer.message.startsWith(`${path}: `), answer.message).toBe(true);
    }
    // A field of the wrong form answers Better Auth's VALIDATION_ERROR (400).
    const invalidRows: [Record<string, unknown>, string][] = [
      [{ providerId: "a b" }, "providerId"],
      // _better-auth-token-<id> must fit one DNS label of 63 characters.
      [{ providerId: "p".repeat(45) }, "providerId"],
      [{ issuer: "" }, "issuer"],
      [{ domain: "" }, "domain"],
      [{ samlConfig: { entryPoint: "https://idp.example/sso" } }, "oidcConfig"],
      [{ oidcConfig: { ...OIDC, clientSecret: "" } }, "oidcConfig.clientSecret"],
      [{ oidcConfig: { ...OIDC, scopes: "openid" } }, "oidcConfig.scopes"],
      [{ samlConfig: { cert: 3 } }, "samlConfig.cert"],
      [{ samlConfig: { mapping: { name: "n" } } }, "samlConfig.mapping.email"],
    ];
    for (const [body, path] of invalidRows) {
      const res = await app.register({
        providerId: "p1",
        issuer: "https://idp.acme.example",
        domain: "acme.example",
        ...("samlConfig" in body && !("oidcConfig" in body) && path !== "oidcConfig"
          ? {}
          : { oidcConfig: OIDC }),
        ...body,
      });
      const answer = (await res.json()) as { code: string; message: string };
      expect([res.status, answer.code], path).toEqual([400, "VALIDATION_ERROR"]);
      expect(answer.message.startsWith(`${path}: `), answer.message).toBe(true);
    }
    expect(await connectionsOf(app)).toEqual([]);
    expect(await domainsOf(app)).toEqual([]);
  });

  it("serves the Better Auth paths", async () => {
    const app = await owned({
      domainVerification: { enabled: true },
      organizationProvisioning: { defaultRole: "admin" },
      disableImplicitSignUp: true,
    });
    const reg = await app.register({
      providerId: "acme-oidc",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    });
    expect(reg.status).toBe(200);
    // One providerId names one provider, as in Better Auth (422).
    const twice = await app.register({
      providerId: "acme-oidc",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    });
    expect([twice.status, ((await twice.json()) as { message: string }).message]).toEqual([
      422,
      "SSO provider with this providerId already exists",
    ]);
    // The label check comes first: the second register writes no connection, so no audit row.
    const creates = await app.database.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "sso_connection_create" },
    ]);
    expect(creates).toHaveLength(1);
    const made = (await reg.json()) as Record<string, unknown>;
    const [conn] = await connectionsOf(app);
    expect(conn).toMatchObject({
      label: "acme-oidc",
      kind: "oidc",
      defaultRole: "admin",
      jit: false,
      oidc: { issuer: "https://idp.acme.example", clientId: "acme-client" },
    });
    expect(made).toMatchObject({
      providerId: "acme-oidc",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      organizationId: app.organizationId,
      domainVerified: false,
      redirectURI: `${BASE}/api/auth/sso/${conn?.id}/callback`,
    });
    // The answer never holds the client secret.
    expect(JSON.stringify(made)).not.toContain("acme-secret-value");
    const [domain] = await domainsOf(app);
    expect(domain).toMatchObject({
      domain: "acme.example",
      verified: false,
      connectionId: conn?.id,
    });
    expect(made.domainVerificationToken).toBe(
      domain?.record?.value.replace("authtempo-domain=", ""),
    );

    const list = await app.read("/sso/providers", app.owner.cookie);
    expect(list.status).toBe(200);
    const { providers } = (await list.json()) as { providers: Record<string, unknown>[] };
    expect(providers.map((p) => [p.providerId, p.type, p.domainVerified])).toEqual([
      ["acme-oidc", "oidc", false],
    ]);
    const one = await app.read("/sso/get-provider?providerId=acme-oidc", app.owner.cookie);
    expect(((await one.json()) as Record<string, unknown>).providerId).toBe("acme-oidc");

    const upd = await app.call(
      "/sso/update-provider",
      { providerId: "acme-oidc", oidcConfig: { clientId: "acme-client-2" } },
      app.owner.cookie,
    );
    expect(upd.status).toBe(200);
    expect((await connectionsOf(app))[0]?.oidc?.clientId).toBe("acme-client-2");

    // A person of another organization reads and changes nothing: core's manager guard.
    const other = await app.person("eve@evil.example");
    const peek = await app.read("/sso/get-provider?providerId=acme-oidc", other.cookie);
    expect(peek.status).toBe(403);
    const grab = await app.call("/sso/delete-provider", { providerId: "acme-oidc" }, other.cookie);
    expect(grab.status).toBe(403);
    expect(await connectionsOf(app)).toHaveLength(1);

    const ask = await app.call(
      "/sso/request-domain-verification",
      { providerId: "acme-oidc" },
      app.owner.cookie,
    );
    expect(ask.status).toBe(201);
    const { domainVerificationToken } = (await ask.json()) as { domainVerificationToken: string };
    expect(domainVerificationToken).toBe(made.domainVerificationToken);
    app.dns.set("_better-auth-token-acme-oidc.acme.example", [
      `_better-auth-token-acme-oidc=${domainVerificationToken}`,
    ]);
    const proof = await app.call(
      "/sso/verify-domain",
      { providerId: "acme-oidc" },
      app.owner.cookie,
    );
    expect(proof.status).toBe(204);
    expect((await domainsOf(app))[0]?.verified).toBe(true);
    const again = await app.call(
      "/sso/verify-domain",
      { providerId: "acme-oidc" },
      app.owner.cookie,
    );
    expect([again.status, ((await again.json()) as { code: string }).code]).toEqual([
      409,
      "DOMAIN_VERIFIED",
    ]);

    // signIn.sso: each of the four keys names the connection, and the answer is core's start.
    const start = `${BASE}/api/auth/sso/${conn?.id}/start?next=%2Fdashboard`;
    for (const key of [
      { email: "bo@acme.example" },
      { providerId: "acme-oidc" },
      { domain: "acme.example" },
      { organizationSlug: "acme" },
    ]) {
      const res = await app.call("/sign-in/sso", { ...key, callbackURL: "/dashboard" });
      expect([res.status, await res.json()], JSON.stringify(key)).toEqual([
        200,
        { url: start, redirect: true },
      ]);
    }
    const none = await app.call("/sign-in/sso", { email: "bo@nowhere.example", callbackURL: "/" });
    expect(none.status).toBe(404);

    // The callback of the provider reaches core's callback of the connection.
    const back = await app.read("/sso/callback/acme-oidc?code=c&state=s");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toContain("sso_failed");
    expect(await app.read("/sso/callback/no-such?code=c&state=s").then((r) => r.status)).toBe(404);

    // The delete takes the connection and its domains.
    const del = await app.call(
      "/sso/delete-provider",
      { providerId: "acme-oidc" },
      app.owner.cookie,
    );
    expect(del.status).toBe(200);
    expect(await connectionsOf(app)).toEqual([]);
    expect(await domainsOf(app)).toEqual([]);
  });

  it("serves the SAML paths and a change of the domain", async () => {
    // A second test: each shim call spends one to four of core's 30 manager calls per 15 minutes.
    const app = await owned();
    const reg = await app.register({
      providerId: "acme-oidc",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    });
    expect(reg.status).toBe(200);
    const [conn] = await connectionsOf(app);
    // A SAML provider: the ACS and the SP metadata of the connection.
    const idp = await createTestIdp({ alg: "ec", entityId: "https://idp.beta.example/metadata" });
    const saml = await app.register({
      providerId: "beta-saml",
      issuer: "https://idp.beta.example",
      domain: "beta.example",
      samlConfig: {
        entryPoint: "https://idp.beta.example/sso",
        cert: idp.certificatePem,
        idpMetadata: { entityID: idp.entityId },
        mapping: { email: "email", name: "displayName" },
      },
    });
    expect(saml.status).toBe(200);
    const samlConn = (await connectionsOf(app)).find((c) => c.label === "beta-saml");
    expect(samlConn?.saml).toMatchObject({
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.beta.example/sso",
      attributes: { email: "email", name: "displayName" },
    });
    const meta = await app.read("/sso/saml2/sp/metadata?providerId=beta-saml");
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toContain("samlmetadata+xml");
    expect(await meta.text()).toContain(`${BASE}/api/auth/sso/${samlConn?.id}/acs`);
    const acs = await app.auth.handler(
      new Request(`${BASE}/api/auth/sso/saml2/sp/acs/beta-saml`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "SAMLResponse=bm8%3D",
      }),
    );
    expect(acs.status).toBe(302);
    expect(acs.headers.get("location")).toContain("sso_failed");

    // A SAML connection by its domain: core's discovery names it (ruling 61 F6).
    const samlProof = (await (
      await app.call(
        "/sso/request-domain-verification",
        { providerId: "beta-saml" },
        app.owner.cookie,
      )
    ).json()) as { domainVerificationToken: string };
    app.dns.set("_better-auth-token-beta-saml.beta.example", [samlProof.domainVerificationToken]);
    expect(
      (await app.call("/sso/verify-domain", { providerId: "beta-saml" }, app.owner.cookie)).status,
    ).toBe(204);
    const samlStart = `${BASE}/api/auth/sso/${samlConn?.id}/start?next=%2F`;
    for (const key of [{ email: "cy@beta.example" }, { domain: "beta.example" }]) {
      const res = await app.call("/sign-in/sso", { ...key, callbackURL: "/" });
      expect([res.status, await res.json()], JSON.stringify(key)).toEqual([
        200,
        { url: samlStart, redirect: true },
      ]);
    }
    // The claim still names the connection when it is disabled, but core's discovery
    // answers no. The shim takes the connectionId of that answer only.
    const off = await app.auth.tempo.api.sso?.connections.update({
      actor: { kind: "app", name: "test" },
      id: samlConn?.id ?? "",
      enabled: false,
    });
    expect(off?.ok).toBe(true);
    expect((await domainsOf(app)).find((d) => d.domain === "beta.example")?.connectionId).toBe(
      samlConn?.id,
    );
    for (const key of [{ email: "cy@beta.example" }, { domain: "beta.example" }]) {
      const res = await app.call("/sign-in/sso", { ...key, callbackURL: "/" });
      expect(res.status, JSON.stringify(key)).toBe(404);
    }

    // A new domain is added, pending, and routed; the old one goes, as Better Auth clears the proof.
    const moved = await app.call(
      "/sso/update-provider",
      { providerId: "acme-oidc", domain: "acme-two.example" },
      app.owner.cookie,
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ domain: "acme-two.example", domainVerified: false });
    expect((await domainsOf(app)).map((d) => [d.domain, d.connectionId]).sort()).toEqual(
      [
        ["acme-two.example", conn?.id],
        ["beta.example", samlConn?.id],
      ].sort(),
    );
  });

  it("keeps one connection when two registers of one providerId race", async () => {
    // A storage that runs a rival register of the same providerId right after the
    // shim's first read of the label, as a parallel request would.
    const base = memory();
    let rival: (() => Promise<unknown>) | null = null;
    const storage = new Proxy(base.storage, {
      get(target, key) {
        if (key === "findMany")
          return async (...args: Parameters<typeof target.findMany>) => {
            const [model, where] = args;
            const run = rival;
            if (
              model === "ssoConnection" &&
              run &&
              (where as readonly { field: string }[]).some((w) => w.field === "label")
            ) {
              rival = null;
              const out = await target.findMany(...args);
              await run();
              return out;
            }
            return target.findMany(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = await owned(undefined, { ...base, storage });
    const body = {
      providerId: "acme",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    };
    let rivalAnswer: Response | null = null;
    rival = async () => {
      rivalAnswer = await app.register(body);
    };
    const late = await app.register(body);
    // Both passed the first label check. The rival ended first and keeps its row; the
    // late register finds it after its own create and undoes its own.
    expect((rivalAnswer as Response | null)?.status).toBe(200);
    expect([late.status, ((await late.json()) as { message: string }).message]).toEqual([
      422,
      "SSO provider with this providerId already exists",
    ]);
    // One connection stays, with its domain; the other is undone.
    expect((await connectionsOf(app)).map((c) => c.label)).toEqual(["acme"]);
    expect((await domainsOf(app)).map((d) => d.connectionId)).toEqual([
      (await connectionsOf(app))[0]?.id,
    ]);
  });

  it("gives a new token when the pending proof ran out of time", async () => {
    const app = await owned({ domainVerification: { enabled: true } });
    const made = (await (
      await app.register({
        providerId: "acme",
        issuer: "https://idp.acme.example",
        domain: "acme.example",
        oidcConfig: OIDC,
      })
    ).json()) as { domainVerificationToken: string };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Core keeps a pending domain 7 days. The first session is older than that.
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      await app.owner.signInAgain();
      const late = await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie);
      expect([late.status, ((await late.json()) as { code: string }).code]).toEqual([
        404,
        "NO_PENDING_VERIFICATION",
      ]);
      const ask = await app.call(
        "/sso/request-domain-verification",
        { providerId: "acme" },
        app.owner.cookie,
      );
      expect(ask.status).toBe(201);
      const token = ((await ask.json()) as { domainVerificationToken: string })
        .domainVerificationToken;
      expect(token).not.toBe(made.domainVerificationToken);
      app.dns.set("_better-auth-token-acme.acme.example", [token]);
      expect(
        (await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie)).status,
      ).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 501 on the three paths that stay", async () => {
    const app = await owned();
    for (const [method, path] of [
      ["GET", "/sso/callback?code=c&state=s"],
      ["GET", "/sso/saml2/sp/slo/acme-saml"],
      ["POST", "/sso/saml2/sp/slo/acme-saml"],
      ["POST", "/sso/saml2/logout/acme-saml"],
    ] as const) {
      const res = await app.send(
        method,
        path,
        method === "POST" ? {} : undefined,
        app.owner.cookie,
      );
      expect([res.status, ((await res.json()) as { code: string }).code], path).toEqual([
        501,
        "NOT_SUPPORTED",
      ]);
    }
  });

  it("verifies a domain by the Better Auth record", async () => {
    const app = await owned({ domainVerification: { enabled: true } });
    await app.register({
      providerId: "acme",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    });
    const ask = await app.call(
      "/sso/request-domain-verification",
      { providerId: "acme" },
      app.owner.cookie,
    );
    const { domainVerificationToken: token } = (await ask.json()) as {
      domainVerificationToken: string;
    };
    // No record yet: Better Auth's 502 DOMAIN_VERIFICATION_FAILED, and both resolvers are asked for Better Auth's name.
    const none = await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie);
    expect([none.status, ((await none.json()) as { code: string }).code]).toEqual([
      502,
      "DOMAIN_VERIFICATION_FAILED",
    ]);
    expect(app.a.calls).toEqual(["_better-auth-token-acme.acme.example"]);
    // Core's own record name does not count for the shim's verify.
    app.dns.set("_authtempo-challenge.acme.example", [`authtempo-domain=${token}`]);
    const own = await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie);
    expect(own.status).toBe(502);
    // The value alone, as Better Auth also accepts it.
    app.dns.set("_better-auth-token-acme.acme.example", [token]);
    const proof = await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie);
    expect(proof.status).toBe(204);
    expect((await domainsOf(app))[0]).toMatchObject({ domain: "acme.example", verified: true });
  });

  it("refuses the record of an old challenge", async () => {
    // Lead note of 2026-10-21: the value comes from the row's current challenge.
    const app = await owned({ domainVerification: { enabled: true } });
    const body = {
      providerId: "acme",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    };
    const first = (await (await app.register(body)).json()) as { domainVerificationToken: string };
    app.dns.set("_better-auth-token-acme.acme.example", [first.domainVerificationToken]);
    // The provider goes and comes back: its domain row is new, with a new challenge.
    await app.call("/sso/delete-provider", { providerId: "acme" }, app.owner.cookie);
    const second = (await (await app.register(body)).json()) as { domainVerificationToken: string };
    expect(second.domainVerificationToken).not.toBe(first.domainVerificationToken);
    const stale = await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie);
    expect(stale.status).toBe(502);
    expect((await domainsOf(app))[0]?.verified).toBe(false);
  });
  it("refuses each update field and each sign-in key with no core feature", async () => {
    // The register and the 6 updates are 7 large reads of the owner, one past core's limit of
    // an hour (ruling 69 of the 12j lane). So the limiter's clock moves an hour after the register.
    let later = 0;
    const app = await owned(undefined, {
      ...memory(),
      limiter: createMemoryLimiter({ now: () => new Date(Date.now() + later) }),
    });
    await app.register({
      providerId: "acme",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    });
    later = 3_600_000;
    const updates: [Record<string, unknown>, number, string][] = [
      [{ samlConfig: {} }, 501, "samlConfig"],
      [{ oidcConfig: { pkce: false } }, 501, "oidcConfig.pkce"],
      [{ organizationId: "other" }, 501, "organizationId"],
      [{ domain: "a.example, b.example" }, 501, "domain"],
      [{ domain: "" }, 400, "domain"],
      [{ issuer: 3 }, 400, "issuer"],
    ];
    for (const [body, status, path] of updates) {
      const res = await app.call(
        "/sso/update-provider",
        { providerId: "acme", ...body },
        app.owner.cookie,
      );
      const answer = (await res.json()) as { code: string; message: string };
      expect([res.status, answer.message.startsWith(`${path}: `)], path).toEqual([status, true]);
    }
    const signIns: [Record<string, unknown>, number, string][] = [
      [{ errorCallbackURL: "/e" }, 501, "errorCallbackURL"],
      [{ newUserCallbackURL: "/n" }, 501, "newUserCallbackURL"],
      [{ scopes: ["openid"] }, 501, "scopes"],
      [{ loginHint: "bo" }, 501, "loginHint"],
      [{ additionalParams: { a: "b" } }, 501, "additionalParams"],
      [{ requestSignUp: true }, 501, "requestSignUp"],
      [{ other: 1 }, 501, "other"],
      [{ callbackURL: undefined }, 400, "callbackURL"],
    ];
    for (const [body, status, path] of signIns) {
      const res = await app.call("/sign-in/sso", { providerId: "acme", callbackURL: "/", ...body });
      const answer = (await res.json()) as { code: string; message: string };
      expect([res.status, answer.message.startsWith(`${path}: `)], path).toEqual([status, true]);
    }
    // A providerType of another kind finds no provider, as Better Auth's filter does.
    const saml = await app.call("/sign-in/sso", {
      providerId: "acme",
      callbackURL: "/",
      providerType: "saml",
    });
    expect(saml.status).toBe(404);
    // Nothing changed: the connection is as registered.
    expect((await connectionsOf(app))[0]).toMatchObject({
      label: "acme",
      oidc: { clientId: "acme-client" },
    });
  });

  it("proves by the Better Auth record only through the shim's verify, as the caller", async () => {
    const app = await owned({ domainVerification: { enabled: true } });
    await app.register({
      providerId: "acme",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    });
    const ask = await app.call(
      "/sso/request-domain-verification",
      { providerId: "acme" },
      app.owner.cookie,
    );
    const proof = (await ask.json()) as {
      domainVerificationToken: string;
      domainVerificationRecords: { name: string; value: string }[];
    };
    // Both records, Better Auth's first (ruling 61 P7).
    expect(proof.domainVerificationRecords.map((r) => r.name)).toEqual([
      "_better-auth-token-acme.acme.example",
      "_authtempo-challenge.acme.example",
    ]);
    app.dns.set("_better-auth-token-acme.acme.example", [
      `_better-auth-token-acme=${proof.domainVerificationToken}`,
    ]);
    // Core's own route with no mark reads core's own record: the Better Auth record proves nothing there.
    const [domain] = await domainsOf(app);
    const plain = await app.auth.tempo.handle(
      new Request(`${BASE}/api/auth/sso/domains/verify`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json", cookie: app.owner.cookie },
        body: JSON.stringify({ id: domain?.id }),
      }),
    );
    expect([plain.status, ((await plain.json()) as { error: string }).error]).toEqual([
      400,
      "domain_unverified",
    ]);
    // No session: core's session check answers first, through the shim too.
    expect((await app.call("/sso/verify-domain", { providerId: "acme" })).status).toBe(401);
    const verified = await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie);
    expect(verified.status).toBe(204);
    // The audit row names the caller: the owner's user id, through core's route.
    const rows = await app.database.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "sso_domain_verify" },
    ]);
    expect(rows.map((r) => [r.actorKind, r.actorId])).toEqual([["user", app.owner.user.id]]);
  });

  it("keeps a domain that the Better Auth record proved at the 30-day recheck (ruling 61 F4)", async () => {
    const app = await owned({ domainVerification: { enabled: true } });
    const made = (await (
      await app.register({
        providerId: "acme",
        issuer: "https://idp.acme.example",
        domain: "acme.example",
        oidcConfig: OIDC,
      })
    ).json()) as { domainVerificationToken: string };
    app.dns.set("_better-auth-token-acme.acme.example", [made.domainVerificationToken]);
    expect(
      (await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie)).status,
    ).toBe(204);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      app.a.calls.length = 0;
      await app.auth.tempo.api.sweepExpired();
      // Core's own record first, then Better Auth's: the claim holds with no failure.
      expect(app.a.calls).toEqual([
        "_authtempo-challenge.acme.example",
        "_better-auth-token-acme.acme.example",
      ]);
      const row = await app.database.storage.findOne("ssoDomain", [
        { field: "domain", op: "eq", value: "acme.example" },
      ]);
      expect(row).toMatchObject({ claimedDomain: "acme.example", failures: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("gives no Better Auth record for a label with a dot (review M1)", async () => {
    const record = betterAuthRecord("better-auth-token");
    const row = { domain: "acme.example", challenge: "tok" };
    expect(record(row, "acme")?.name).toBe("_better-auth-token-acme.acme.example");
    // The name of a dotted label sits in the zone of sub.acme.example, which another owner may hold.
    for (const label of ["x.sub", "x.", ".x", "a b", ""])
      expect(record(row, label), label).toBeNull();
    const app = await owned({ domainVerification: { enabled: true } });
    const made = (await (
      await app.register({
        providerId: "acme",
        issuer: "https://idp.acme.example",
        domain: "acme.example",
        oidcConfig: OIDC,
      })
    ).json()) as { domainVerificationToken: string };
    app.dns.set("_better-auth-token-acme.acme.example", [made.domainVerificationToken]);
    expect(
      (await app.call("/sso/verify-domain", { providerId: "acme" }, app.owner.cookie)).status,
    ).toBe(204);
    // Core's own route, outside the shim, takes a dot in a label. The query names the row (plan 12l).
    const [connection] = await connectionsOf(app);
    const relabel = await app.auth.tempo.handle(
      new Request(
        `${BASE}/api/auth/sso/connections/update?id=${encodeURIComponent(connection?.id ?? "")}`,
        {
          method: "POST",
          headers: { origin: BASE, "content-type": "application/json", cookie: app.owner.cookie },
          body: JSON.stringify({ label: "x.sub" }),
        },
      ),
    );
    expect(relabel.status).toBe(200);
    // Only the zone of sub.acme.example answers: the recheck does not count it.
    app.dns.clear();
    app.dns.set("_better-auth-token-x.sub.acme.example", [made.domainVerificationToken]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      app.a.calls.length = 0;
      await app.auth.tempo.api.sweepExpired();
      expect(app.a.calls).toEqual(["_authtempo-challenge.acme.example"]);
      const row = await app.database.storage.findOne("ssoDomain", [
        { field: "domain", op: "eq", value: "acme.example" },
      ]);
      expect(row).toMatchObject({ claimedDomain: "acme.example", failures: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds the record from one read of the label inside the verify (review M1)", async () => {
    const base = memory();
    // A label change lands after the shim's read of the label, before core's read.
    let between: null | (() => Promise<void>) = null;
    const storage = new Proxy(base.storage, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (key === "findOne")
          return async (model: string, ...rest: unknown[]) => {
            if (model === "ssoConnection" && between) {
              const go = between;
              between = null;
              await go();
            }
            return (v as (...a: unknown[]) => unknown).call(target, model, ...rest);
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const app = await owned({ domainVerification: { enabled: true } }, { ...base, storage });
    const made = (await (
      await app.register({
        providerId: "p1",
        issuer: "https://idp.acme.example",
        domain: "victim.example",
        oidcConfig: OIDC,
      })
    ).json()) as { domainVerificationToken: string };
    const [connection] = await connectionsOf(app);
    // Only the zone of sub.victim.example answers, and no record sits at the apex.
    app.dns.set("_better-auth-token-x.sub.victim.example", [made.domainVerificationToken]);
    let relabelled = 0;
    between = async () => {
      const r = await app.auth.tempo.handle(
        new Request(
          `${BASE}/api/auth/sso/connections/update?id=${encodeURIComponent(connection?.id ?? "")}`,
          {
            method: "POST",
            headers: {
              origin: BASE,
              "content-type": "application/json",
              cookie: app.owner.cookie,
            },
            body: JSON.stringify({ label: "x.sub" }),
          },
        ),
      );
      relabelled = r.status;
    };
    const res = await app.call("/sso/verify-domain", { providerId: "p1" }, app.owner.cookie);
    expect([relabelled, res.status]).toEqual([200, 502]);
    const row = await base.storage.findOne("ssoDomain", [
      { field: "domain", op: "eq", value: "victim.example" },
    ]);
    expect(row?.claimedDomain).toBeNull();
  });

  it("keeps a providerId out of reach of core's label routes (review M2)", async () => {
    const app = await owned({ domainVerification: { enabled: true } });
    expect(
      (
        await app.register({
          providerId: "acme",
          issuer: "https://idp.acme.example",
          domain: "acme.example",
          oidcConfig: OIDC,
        })
      ).status,
    ).toBe(200);
    const mal = await app.manager("mal@evil.example");
    const evil = await app.organizationOf(mal, "evil");
    // Core's two writes name their row in the query (plan 12l).
    const createPath = `/sso/connections/create?organizationId=${encodeURIComponent(evil)}`;
    const create = (label: string) =>
      app.call(
        createPath,
        {
          kind: "oidc",
          label,
          issuer: "https://idp.evil.example",
          clientId: "evil",
          clientSecret: "evil-secret-0123456789",
        },
        mal.cookie,
      );
    // A manager of another organization cannot take the providerId through core's route.
    for (const label of ["acme", "evil-sso"]) {
      const res = await create(label);
      expect([res.status, ((await res.json()) as { error: string }).error], label).toEqual([
        400,
        "invalid_body",
      ]);
    }
    const own = await create("Evil SSO");
    expect(own.status).toBe(200);
    const { connection: evilConnection } = (await own.json()) as { connection: { id: string } };
    const update = (id: string | undefined, label: string, cookie: string) =>
      app.call(`/sso/connections/update?id=${encodeURIComponent(id ?? "")}`, { label }, cookie);
    expect((await update(evilConnection.id, "acme", mal.cookie)).status).toBe(400);
    // The owner's own provider keeps its label too: register and update-provider own it.
    const [acme] = (await connectionsOf(app)).filter((c) => c.label === "acme");
    expect((await update(acme?.id, "Acme Corp", app.owner.cookie)).status).toBe(400);
    // A body that is not a JSON object is refused unread.
    const raw = await app.auth.handler(
      new Request(`${BASE}/api/auth${createPath}`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json", cookie: mal.cookie },
        body: "[1]",
      }),
    );
    expect(raw.status).toBe(400);
    // The paths of acme still find its one row.
    expect((await app.call("/sign-in/sso", { providerId: "acme", callbackURL: "/" })).status).toBe(
      200,
    );
    expect((await app.read("/sso/get-provider?providerId=acme", app.owner.cookie)).status).toBe(
      200,
    );
    const rows = await app.database.storage.findMany("ssoConnection", []);
    expect(rows.map((r) => r.label).sort()).toEqual(["Evil SSO", "acme"]);
  });

  it("keeps the token endpoint method of a provider (12d fix wave item 18)", async () => {
    const app = await owned();
    const reg = await app.register({
      providerId: "acme-oidc",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: { ...OIDC, tokenEndpointAuthentication: "client_secret_basic" },
    });
    expect(reg.status).toBe(200);
    const method = async () => (await connectionsOf(app))[0]?.oidc?.tokenEndpointAuthMethod;
    expect(await method()).toBe("client_secret_basic");
    const read = async () =>
      (
        (await (
          await app.read("/sso/get-provider?providerId=acme-oidc", app.owner.cookie)
        ).json()) as { oidcConfig: { tokenEndpointAuthentication: string } }
      ).oidcConfig.tokenEndpointAuthentication;
    expect(await read()).toBe("client_secret_basic");
    const moved = await app.call(
      "/sso/update-provider",
      {
        providerId: "acme-oidc",
        oidcConfig: { tokenEndpointAuthentication: "client_secret_post" },
      },
      app.owner.cookie,
    );
    expect(moved.status).toBe(200);
    expect([await method(), await read()]).toEqual(["client_secret_post", "client_secret_post"]);
  });

  it("serves authClient.sso and signIn.sso through the shim's paths", async () => {
    const app = await owned({ domainVerification: { enabled: true } });
    const client = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [ssoClient()],
      fetchOptions: {
        customFetchImpl: async (input, init) => app.auth.handler(new Request(input, init)),
        headers: { cookie: app.owner.cookie, origin: BASE },
      },
    });
    const made = await client.sso.register({
      providerId: "acme",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      organizationId: app.organizationId,
      oidcConfig: OIDC,
    });
    expect([made.error, made.data?.providerId]).toEqual([null, "acme"]);
    expect((await client.sso.providers()).data?.providers.map((p) => p.providerId)).toEqual([
      "acme",
    ]);
    expect((await client.sso.getProvider({ query: { providerId: "acme" } })).data?.type).toBe(
      "oidc",
    );
    const updated = await client.sso.updateProvider({
      providerId: "acme",
      oidcConfig: { clientId: "acme-2" },
    });
    expect(updated.data?.oidcConfig).toMatchObject({ clientIdLastFour: "me-2" });
    const ask = await client.sso.requestDomainVerification({ providerId: "acme" });
    const token = ask.data?.domainVerificationToken ?? "";
    app.dns.set("_better-auth-token-acme.acme.example", [token]);
    // Better Auth answers 204 with no body: data is null, and so is the error.
    expect(await client.sso.verifyDomain({ providerId: "acme" })).toEqual({
      data: null,
      error: null,
    });
    const go = await client.signIn.sso({ providerId: "acme", callbackURL: "/home" });
    expect(go.data?.url).toMatch(/\/api\/auth\/sso\/[^/]+\/start\?next=%2Fhome$/);
    expect((await client.sso.deleteProvider({ providerId: "acme" })).data).toEqual({
      success: true,
    });
    expect((await client.sso.getProvider({ query: { providerId: "acme" } })).error?.code).toBe(
      "NOT_FOUND",
    );
  });

  it("starts a sign-in on the second entry of a baseURL list with its callback there", async () => {
    // Plan 12i Task 18, review I2: the shim builds core's requests and URLs on the request's entry.
    const B = "https://b.example.com";
    const app = ssoApp(memory(), [sso({})], {
      baseURL: { allowedHosts: ["api.example.com", "b.example.com"], protocol: "https" },
    });
    const owner = await app.manager("ann@acme.example");
    const organizationId = await app.organizationOf(owner, "acme");
    const reg = await app.callOn(
      B,
      "/sso/register",
      {
        organizationId,
        providerId: "acme-oidc",
        issuer: "https://idp.acme.example",
        domain: "acme.example",
        oidcConfig: OIDC,
      },
      owner.cookie,
    );
    expect(reg.status).toBe(200);
    const made = (await reg.json()) as { redirectURI: string };
    const id = /\/sso\/([^/]+)\/callback$/.exec(made.redirectURI)?.[1];
    expect(made.redirectURI).toBe(`${B}/api/auth/sso/${id}/callback`);
    const signIn = await app.callOn(B, "/sign-in/sso", {
      providerId: "acme-oidc",
      callbackURL: "/",
    });
    const { url } = (await signIn.json()) as { url: string };
    expect(url).toBe(`${B}/api/auth/sso/${id}/start?next=%2F`);
    const start = await app.auth.handler(new Request(url));
    expect(start.status).toBe(302);
    const idp = new URL(start.headers.get("location") ?? "");
    expect(idp.searchParams.get("redirect_uri")).toBe(`${B}/api/auth/sso/${id}/callback`);
  });
});

const DAY_MS = 86_400_000;

/**
 * An app whose owner registered `acme-oidc`, with a session that is due for
 * a sliding refresh and still fresh (plan 12n). Run it with a fake Date.
 * The owner signs in, turns TOTP on through Better Auth's two paths, and
 * registers. Half a day later the owner proves the password and a code at
 * core's `/reauth`. That read is not due, so the proof moves `freshAt` and
 * keeps `lastSeenAt`. Half a day and a minute after that, Better Auth's
 * `updateAge` of one day has passed since `lastSeenAt`. The fresh window of
 * one day has not passed since the proof.
 */
async function dueOwner() {
  const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
  const owner = await app.person("ann@acme.example");
  // As `manager` of sso-helpers.ts, but the test keeps the secret for the proof.
  const enable = await app.call("/two-factor/enable", { password: PASSWORD }, owner.cookie);
  const { totpURI } = (await enable.json()) as { totpURI: string };
  const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
  const code = () => totpCode(secret, new Date());
  const confirm = await app.call("/two-factor/verify-totp", { code: await code() }, owner.cookie);
  expect(confirm.status).toBe(200);
  const organizationId = await app.organizationOf(owner, "acme");
  const reg = await app.call(
    "/sso/register",
    {
      organizationId,
      providerId: "acme-oidc",
      issuer: "https://idp.acme.example",
      domain: "acme.example",
      oidcConfig: OIDC,
    },
    owner.cookie,
  );
  expect(reg.status).toBe(200);
  const { redirectURI } = (await reg.json()) as { redirectURI: string };
  const connectionId = /\/sso\/([^/]+)\/callback$/.exec(redirectURI)?.[1] ?? "";
  vi.setSystemTime(Date.now() + DAY_MS / 2);
  const proof = await app.call("/reauth", { password: PASSWORD, code: await code() }, owner.cookie);
  // Not due yet: the proof slides nothing and sends no cookie.
  expect([proof.status, proof.headers.getSetCookie()]).toEqual([200, []]);
  vi.setSystemTime(Date.now() + DAY_MS / 2 + 60_000);
  return { app, cookie: owner.cookie, organizationId, connectionId };
}

type DueOwner = Awaited<ReturnType<typeof dueOwner>>;

/**
 * Each read of the session in the shim's SSO paths, with the status of its
 * answer (plan 12n). The shim reads with no write. So core's own route does
 * the one due refresh, and the shim's answer carries core's cookie.
 */
const DUE_CASES: [path: string, status: number, send: (o: DueOwner) => Promise<Response>][] = [
  [
    "POST /sso/register",
    200,
    (o) =>
      o.app.call(
        "/sso/register",
        {
          organizationId: o.organizationId,
          providerId: "acme-two",
          issuer: "https://idp.acme.example",
          domain: "acme-two.example",
          oidcConfig: OIDC,
        },
        o.cookie,
      ),
  ],
  ["GET /sso/providers", 200, (o) => o.app.read("/sso/providers", o.cookie)],
  [
    "POST /sso/update-provider",
    200,
    (o) =>
      o.app.call(
        "/sso/update-provider",
        { providerId: "acme-oidc", oidcConfig: { clientId: "acme-client-2" } },
        o.cookie,
      ),
  ],
  [
    "POST /sso/connections/create",
    200,
    (o) =>
      o.app.call(
        `/sso/connections/create?organizationId=${encodeURIComponent(o.organizationId)}`,
        {
          kind: "oidc",
          label: "Acme SSO",
          issuer: "https://idp.acme.example",
          clientId: "acme-client",
          clientSecret: "acme-secret-0123456789",
        },
        o.cookie,
      ),
  ],
  [
    "POST /sso/connections/update",
    200,
    (o) =>
      o.app.call(
        `/sso/connections/update?id=${encodeURIComponent(o.connectionId)}`,
        { clientId: "acme-client-3" },
        o.cookie,
      ),
  ],
  [
    "GET /sso/get-provider",
    200,
    (o) => o.app.read("/sso/get-provider?providerId=acme-oidc", o.cookie),
  ],
  [
    "POST /sso/delete-provider",
    200,
    (o) => o.app.call("/sso/delete-provider", { providerId: "acme-oidc" }, o.cookie),
  ],
  [
    "POST /sso/request-domain-verification",
    201,
    (o) => o.app.call("/sso/request-domain-verification", { providerId: "acme-oidc" }, o.cookie),
  ],
  // No DNS record: Better Auth's 502, after core's reads of the provider.
  [
    "POST /sso/verify-domain",
    502,
    (o) => o.app.call("/sso/verify-domain", { providerId: "acme-oidc" }, o.cookie),
  ],
];

describe("the sliding refresh on the shim's SSO paths (plan 12n)", () => {
  it.each(DUE_CASES)(
    "%s with a session due for a refresh answers core's renewed cookie, and the row agrees",
    async (_path, status, send) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const o = await dueOwner();
        const res = await send(o);
        expect(res.status).toBe(status);
        // One renewed cookie from core's own route: the same token, with the full life of seven days.
        const renewed = res.headers.getSetCookie().filter((c) => c.startsWith(`${COOKIE_NAME}=`));
        expect(renewed.map((c) => c.split(";")[0])).toEqual([o.cookie]);
        expect(renewed[0]).toContain(`Max-Age=${(7 * DAY_MS) / 1000};`);
        // The row agrees with the cookie: it lives seven days from now.
        const read = await o.app.auth.tempo.session(
          new Request(`${BASE}/api/auth/session`, { headers: { cookie: o.cookie } }),
          { refresh: false },
        );
        expect(read?.session.expiresAt.getTime()).toBe(Date.now() + 7 * DAY_MS);
      } finally {
        vi.useRealTimers();
      }
    },
    60_000,
  );
});
