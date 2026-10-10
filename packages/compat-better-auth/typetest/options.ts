import type { LimiterPort, StorageAdapter } from "@tempo-auth/core";
import { bearer, expo, magicLink, organization, passkey } from "../src/plugins.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";

// Real values, not `declare const`: test/check-options.test.ts (Task 7) imports
// these objects at run time. The check never calls the storage or the limiter.
const database: CompatDatabase = {
  kind: "tempo-auth-compat-database",
  dialect: "postgres",
  storage: {} as StorageAdapter,
  limiter: {} as LimiterPort,
};
const env = {
  SECRET: "0123456789abcdef0123456789abcdef",
  BASE_URL: "https://api.example.com",
  APP_URL: "https://app.example.com",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  WEB: "https://web.example.com",
};
const send = async (_: { user: { email: string }; url: string }) => {};

// consumere apps/web/src/lib/auth.ts, read 2026-10-10.
export const consumere = {
  secret: env.SECRET,
  baseURL: env.BASE_URL,
  database,
  secondaryStorage: {
    get: async (_k: string) => null as string | null,
    set: async (_k: string, _v: string, _ttl?: number) => {},
    delete: async (_k: string) => {},
    getAndDelete: async (_k: string) => null as string | null,
    increment: async (_k: string, _a = 1, _ttl?: number) => 1,
  },
  session: { storeSessionInDatabase: false },
  advanced: { ipAddress: { disableIpTracking: true }, database: { generateId: false } },
  databaseHooks: {
    session: {
      create: {
        before: async (s: { userAgent: string | null }) => ({ data: { ...s, userAgent: null } }),
      },
    },
  },
  emailAndPassword: { enabled: true, requireEmailVerification: false, sendResetPassword: send },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: send,
  },
  socialProviders: {
    google: { clientId: "g", clientSecret: "g" },
    github: { clientId: "h", clientSecret: "h" },
    linkedin: { clientId: "l", clientSecret: "l" },
  },
} satisfies BetterAuthOptions;

// consumer-i apps/api/src/auth/auth.ts, read 2026-10-10.
export const consumeri = {
  baseURL: env.APP_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database,
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  session: { cookieCache: { enabled: true, maxAge: 60 } },
  trustedOrigins: [env.APP_URL, "reception://"],
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customStorage: {
      consume: async (_k: string, _r: { window: number; max: number }) => ({
        allowed: true,
        retryAfter: null,
      }),
    },
    customRules: {
      "/sign-in/*": (_req: Request, _cur: { window: number; max: number }) => false as const,
      "/**": (_req: Request, cur: { window: number; max: number }) => cur,
    },
  },
  advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
  plugins: [
    bearer(),
    expo(),
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 5,
      creatorRole: "owner",
      organizationHooks: {
        afterCreateOrganization: async (_: { organization: { id: string } }) => {},
      },
    }),
  ],
} satisfies BetterAuthOptions;

// consumerc services/identity/src/auth.ts, read through the usage report 2026-10-10.
export const consumerc = {
  appName: "Consumerc",
  secret: env.SECRET,
  baseURL: env.BASE_URL,
  trustedOrigins: [env.WEB],
  database,
  emailAndPassword: { enabled: false },
  socialProviders: {
    google: { clientId: "g", clientSecret: "g" },
    apple: { clientId: "a", clientSecret: "jwt" },
  },
  advanced: { database: { generateId: () => "0190-uuid-v7" } },
  databaseHooks: { session: { create: { before: async (s: object) => ({ data: s }) } } },
  hooks: { before: async (_ctx: { path: string }) => {} },
  plugins: [
    organization({
      creatorRole: "owner",
      ac: {},
      roles: {},
      dynamicAccessControl: { enabled: true },
      organizationHooks: {},
    }),
    passkey({ rpID: "consumerc.app", rpName: "Consumerc", origin: "https://consumerc.app" }),
    magicLink({ expiresIn: 600, sendMagicLink: async (_: { email: string; url: string }) => {} }),
    expo(),
  ],
} satisfies BetterAuthOptions;

// consumerd apps/api/src/auth/create-auth.ts and packages/db/src/auth-options.ts, through the usage report.
export const consumerd = {
  basePath: "/api/auth",
  trustedOrigins: [env.WEB],
  database,
  emailAndPassword: { enabled: false },
  advanced: {
    database: { generateId: "uuid" },
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
  },
  session: {
    expiresIn: 2592000,
    updateAge: 86400,
    deferSessionRefresh: true,
    freshAge: 600,
    cookieCache: { enabled: true, strategy: "compact", version: 2 },
  },
  rateLimit: { customStorage: { get: async () => null, set: async () => {} } },
  hooks: { before: async () => {}, after: async () => {} },
  plugins: [
    organization({
      teams: { enabled: true },
      creatorRole: "owner",
      membershipLimit: 50,
      organizationLimit: 3,
      disableOrganizationDeletion: true,
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: async () => {},
      ac: {},
      roles: {},
      organizationHooks: {},
    }),
    { id: "admin", defaultRole: "user", adminRoles: ["admin"] },
    { id: "email-otp", otpLength: 6 },
    magicLink({ storeToken: "hashed", sendMagicLink: async () => {} }),
    bearer(),
    { id: "anonymous", emailDomainName: "anon.consumerd.app" },
    passkey({ rpID: "consumerd.app", rpName: "Consumerd" }),
  ],
} satisfies BetterAuthOptions;

// consumerb apps/api/src/auth.ts, through the usage report.
export const consumerb = {
  appName: "Consumerb",
  baseURL: env.BASE_URL,
  basePath: "/api/auth",
  secret: env.SECRET,
  trustedOrigins: [env.WEB],
  database,
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  emailVerification: {
    sendVerificationEmail: send,
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 3600,
  },
  telemetry: { enabled: false },
  advanced: { defaultCookieAttributes: { sameSite: "none", secure: true } },
  plugins: [
    organization({
      creatorRole: "owner",
      requireEmailVerificationOnInvitation: true,
      ac: {},
      roles: {},
      organizationHooks: {},
    }),
    { id: "admin" },
    { id: "api-key", defaultPrefix: "laaa_" },
    { id: "jwt" },
    passkey({ rpID: "consumerb.com", rpName: "Consumerb" }),
    magicLink({ sendMagicLink: async () => {} }),
    { id: "mcp", loginPage: "/login" },
    { id: "cimd" },
  ],
} satisfies BetterAuthOptions;
