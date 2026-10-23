import { createAuth, type DnsTxtPort } from "@authtempo/core";
import { createTestIdp } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { API, call, harness, signIn } from "../support/harness.ts";
import { entraOidc, entraSaml } from "./sso-entra.ts";
import { googleOidc, googleSaml } from "./sso-google.ts";
import { oktaOidc, oktaSaml } from "./sso-okta.ts";

const APP = { kind: "app", name: "admin-page" } as const;

/** An app with OIDC and SAML connections on, and one organization of an owner. */
async function setup() {
  const h = harness();
  const dns: DnsTxtPort[] = [{ name: "a", txt: async () => [] }];
  const auth = createAuth({
    baseURL: API,
    trustedOrigins: [],
    secret: h.secret,
    storage: h.storage,
    mail: h.mail,
    organizations: {},
    sso: { oidc: true, saml: true, dns },
  });
  const owner = await signIn(auth, h, "owner@owner.example");
  const made = await call(
    auth,
    "POST",
    "/auth/organizations/create",
    { slug: "acme", name: "Acme" },
    { cookie: owner },
  );
  const { organization } = (await made.json()) as { organization: { id: string } };
  const sso = auth.api.sso;
  if (!sso) throw new Error("sso is off");
  return { sso, organizationId: organization.id };
}

describe("the connection of each provider", () => {
  it("takes the OIDC values of Entra ID, Okta, and Google", async () => {
    const { sso, organizationId } = await setup();
    const inputs = [
      entraOidc({
        organizationId,
        tenantId: "aaaabbbb-0000-cccc-1111-dddd2222eeee",
        clientId: "client-1",
        clientSecret: "secret-1",
      }),
      oktaOidc({
        organizationId,
        oktaDomain: "acme.okta.com",
        clientId: "client-2",
        clientSecret: "secret-2",
      }),
      googleOidc({ organizationId, clientId: "client-3", clientSecret: "secret-3" }),
    ];
    const issuers: string[] = [];
    for (const input of inputs) {
      const made = await sso.connections.create({ actor: APP, ...input });
      if (!made.ok) throw new Error(`${made.code} ${made.message ?? ""}`);
      issuers.push(made.value.oidc?.issuer ?? "");
      // No answer holds the client secret.
      expect(JSON.stringify(made.value)).not.toContain("secret-");
    }
    expect(issuers).toEqual([
      "https://login.microsoftonline.com/aaaabbbb-0000-cccc-1111-dddd2222eeee/v2.0",
      "https://acme.okta.com",
      "https://accounts.google.com",
    ]);
  });

  it("takes the SAML values of Entra ID, Okta, and Google, and answers the values for the provider", async () => {
    const { sso, organizationId } = await setup();
    const idp = await createTestIdp({ alg: "rsa" });
    const inputs = [
      entraSaml({
        organizationId,
        loginUrl: "https://login.microsoftonline.com/aaaabbbb-0000-cccc-1111-dddd2222eeee/saml2",
        entraIdentifier: "https://sts.windows.net/aaaabbbb-0000-cccc-1111-dddd2222eeee/",
        certificatePem: idp.certificatePem,
      }),
      oktaSaml({
        organizationId,
        ssoUrl: "https://acme.okta.com/app/acme/sso/saml",
        issuer: "http://www.okta.com/exk1",
        certificatePem: idp.certificatePem,
      }),
      googleSaml({
        organizationId,
        ssoUrl: "https://accounts.google.com/o/saml2/idp?idpid=C01",
        entityId: "https://accounts.google.com/o/saml2?idpid=C01",
        certificatePem: idp.certificatePem,
      }),
    ];
    for (const input of inputs) {
      const made = await sso.connections.create({ actor: APP, ...input });
      if (!made.ok) throw new Error(`${made.code} ${made.message ?? ""}`);
      const id = made.value.id;
      expect(made.value.saml?.attributes).toEqual({ email: "email", name: null });
      // The two values that each admin console asks for.
      expect(made.value.saml?.spEntityId).toBe(`${API}/auth/sso/${id}/metadata`);
      expect(made.value.saml?.acsUrl).toBe(`${API}/auth/sso/${id}/acs`);
    }
  });
});
