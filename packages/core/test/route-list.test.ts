import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { ROUTES } from "../src/http/route-list.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

const BASE = "https://api.example.com";
const base = {
  baseURL: BASE,
  secret: "0123456789abcdef0123456789abcdef",
  trustedOrigins: [],
  storage: createMemoryAdapter(),
  mail: { send: async () => {} },
};

/** A config with every feature on: every route that core can serve exists. */
function everyFeature() {
  return resolveConfig({
    ...base,
    social: {
      google: { clientId: "g", clientSecret: "g" },
      apple: { clientId: "a", teamId: "t", keyId: "k", privateKey: "pem" },
      github: { clientId: "h", clientSecret: "h" },
      linkedin: { clientId: "l", clientSecret: "l" },
      oidc: [
        {
          name: "acme",
          label: "Acme",
          issuer: "https://id.acme.example",
          clientId: "c",
          clientSecret: "s",
          endpoints: {
            authorizeUrl: "https://id.acme.example/authorize",
            tokenUrl: "https://id.acme.example/token",
            jwksUrl: "https://id.acme.example/jwks",
          },
        },
      ],
      oauth2: [
        {
          name: "chat",
          label: "Chat",
          authorizeUrl: "https://chat.example/authorize",
          tokenUrl: "https://chat.example/token",
          clientId: "c",
          clientSecret: "s",
          scope: "email",
          userinfo: async () => ({
            subject: "1",
            email: null,
            emailVerified: false,
            name: null,
            image: null,
          }),
        },
      ],
    },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE] },
    handoff: { schemes: ["example://"] },
    organizations: {},
    password: {},
    oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false } },
  });
}

/** A provider route as ROUTES writes it: one template for every provider, except Apple's POST callback. */
function templated(r: { method: string; path: string }): string {
  const social = /^\/social\/([a-z][a-z0-9-]*)\/(start|callback)$/.exec(r.path);
  if (social && !(r.method === "POST" && social[1] === "apple"))
    return `${r.method} /social/:provider/${social[2]}`;
  return `${r.method} ${r.path}`;
}

describe("ROUTES (plan 11a)", () => {
  it("the router serves exactly ROUTES when every feature is on", () => {
    const served = [...new Set(coreRoutes(everyFeature()).map(templated))].sort();
    const listed = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(served).toEqual([...listed].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.length).toBe(72);
  });

  it("serves only the routes of the features that are on by default for a minimal config", () => {
    const served = coreRoutes(resolveConfig(base)).map(templated).sort();
    const always = new Set(["session", "magicLink", "emailOtp", "tokens", "jwtMint"]);
    const listed = ROUTES.filter((r) => always.has(r.feature)).map((r) => `${r.method} ${r.path}`);
    expect(served).toEqual(listed.sort());
  });

  it("names each route's feature from the config that turns it on", () => {
    const withPassword = coreRoutes(resolveConfig({ ...base, password: {} })).map(templated);
    for (const r of ROUTES.filter((x) => x.feature === "emailOtpReset" || x.feature === "totp"))
      expect(withPassword).toContain(`${r.method} ${r.path}`);
  });
});
