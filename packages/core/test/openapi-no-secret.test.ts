import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { openApiDocument, openApiJson, openApiOptionsFrom } from "../src/openapi/index.js";
import { BASE, base, SOCIAL } from "./every-feature.js";

/** Known strings for each value of the config that is not one of the six keys. */
const SECRETS = {
  secret: "nosecret-app-secret-7a1c9e0b3d5f2846aa",
  secretHash: "5e".repeat(32),
  google: "nosecret-google-client-secret",
  github: "nosecret-github-client-secret",
  linkedin: "nosecret-linkedin-client-secret",
  oidc: "nosecret-oidc-client-secret",
  oauth2: "nosecret-oauth2-client-secret",
  privateKey: "nosecret-apple-private-key",
  teamId: "NOSECRETTEAM",
  keyId: "NOSECRETKEY",
  origin: "https://nosecret-passkey.api.example.com",
};

function config() {
  const oidc = SOCIAL.oidc?.[0];
  const oauth2 = SOCIAL.oauth2?.[0];
  if (!oidc || !oauth2) throw new Error("SOCIAL has no oidc or oauth2 entry");
  const input: AuthConfig = {
    ...base,
    secret: SECRETS.secret,
    trustedOrigins: [SECRETS.origin],
    social: {
      google: { clientId: "g", clientSecret: SECRETS.google },
      apple: {
        clientId: "a",
        teamId: SECRETS.teamId,
        keyId: SECRETS.keyId,
        privateKey: SECRETS.privateKey,
      },
      github: { clientId: "h", clientSecret: SECRETS.github },
      linkedin: { clientId: "l", clientSecret: SECRETS.linkedin },
      oidc: [{ ...oidc, clientSecret: SECRETS.oidc }],
      oauth2: [{ ...oauth2, clientSecret: SECRETS.oauth2 }],
    },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE, SECRETS.origin] },
    password: {},
    organizations: {},
    oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false } },
    operator: { secretHash: SECRETS.secretHash },
  };
  return resolveConfig(input);
}

describe("the OpenAPI document holds no secret (plan 11g, spec 25 item 10)", () => {
  it("holds no value of the config that is not one of the six keys", () => {
    const c = config();
    const doc = openApiJson(openApiDocument(openApiOptionsFrom(c)));
    const options = JSON.stringify(openApiOptionsFrom(c));
    // The document is of this config: the operator route and a provider route are in it.
    expect(doc).toContain('"/operator/keys/rotate"');
    expect(doc).toContain('"/social/{provider}/start"');
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(doc.includes(value), `${name} in the document`).toBe(false);
      expect(options.includes(value), `${name} in the options`).toBe(false);
    }
  });

  it("takes the six keys only", () => {
    expect(Object.keys(openApiOptionsFrom(config())).sort()).toEqual([
      "basePath",
      "cookieName",
      "features",
      "scopes",
      "serverUrl",
      "version",
    ]);
  });
});
