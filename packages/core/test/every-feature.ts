import { type AuthConfig, type ResolvedConfig, resolveConfig } from "../src/config.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";

export const BASE = "https://api.example.com";
export const base = {
  baseURL: BASE,
  secret: "0123456789abcdef0123456789abcdef",
  trustedOrigins: [],
  storage: createMemoryAdapter(),
  mail: { send: async () => {} },
};

/** Every kind of social provider, so each provider route exists. */
export const SOCIAL: NonNullable<AuthConfig["social"]> = {
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
};

/** A config with every feature on: every route that core can serve exists. */
export function everyFeature(): ResolvedConfig {
  return resolveConfig({
    ...base,
    social: SOCIAL,
    passkey: {
      rpID: "api.example.com",
      rpName: "Example",
      origins: [BASE],
      relatedOrigins: true,
    },
    handoff: { schemes: ["example://"] },
    organizations: {
      platformRole: "owner",
      platformOrganization: "platform-co",
      dynamicRoles: {},
      teams: {},
    },
    password: {},
    oauth: {
      resources: [`${BASE}/mcp`],
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    // A secret with every scope, the user tools, and the impersonation of plan 12f.
    operator: {
      secrets: [
        {
          name: "default",
          secretHash: "0".repeat(64),
          scopes: ["keys", "secrets", "users", "sessions", "audit", "sso"],
        },
      ],
      users: true,
      impersonation: {},
    },
    // Plan 12d: one resolver that answers no record. No test of the list asks it.
    sso: { dns: [{ name: "none", txt: async () => [] }] },
    // Plan 12d Task 9b: the SCIM token routes and the SCIM server.
    scim: {},
    openapi: true,
    // Plan 12i Task 2: the two username routes.
    username: {},
    // Plan 12i Task 5: the five phone routes, on the memory limiter.
    phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow", signUp: true },
    // Plan 12i Task 6: the two anonymous routes.
    anonymous: { isolateLimiter: "allow" },
    // The readiness route of plan 12h needs a sink; this one keeps nothing.
    observe: { sink: { write: () => {} }, readiness: true },
  });
}
