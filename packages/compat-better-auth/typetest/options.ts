import type { LimiterPort, StorageAdapter } from "@tempo-auth/core";
import type { DrizzleAdapterConfig } from "../src/adapters/drizzle.js";
import { expoClient } from "../src/client/expo.js";
import {
  bearer,
  emailOTP,
  expo,
  magicLink,
  organization,
  passkey,
  twoFactor,
} from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { BetterAuthOptions, ClientOptions, CompatDatabase } from "../src/types.js";

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
};

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
};

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
      // @ts-expect-error since plan 9b a refused key fails the compile; TypeScript reports the first one per literal (ac)
      ac: {},
      roles: {},
      dynamicAccessControl: { enabled: true },
      organizationHooks: {},
    }),
    passkey({ rpID: "consumerc.app", rpName: "Consumerc", origin: "https://consumerc.app" }),
    magicLink({ expiresIn: 600, sendMagicLink: async (_: { email: string; url: string }) => {} }),
    expo(),
  ],
};

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
      // @ts-expect-error since plan 9b a refused key fails the compile; TypeScript reports the first one per literal (teams)
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
    // Since plan 9e consumerd's emailOTP options run unchanged (apps/api/src/auth/create-auth.ts:175-181).
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "hashed",
      sendVerificationOTP: async () => {},
    }),
    magicLink({ storeToken: "hashed", sendMagicLink: async () => {} }),
    bearer(),
    { id: "anonymous", emailDomainName: "anon.consumerd.app" },
    passkey({ rpID: "consumerd.app", rpName: "Consumerd" }),
  ],
};

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
      // @ts-expect-error since plan 9b a refused key fails the compile; TypeScript reports the first one per literal (ac)
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
};

// One guard per option type that lost its index signature in plan 9b. Each
// line below the directive holds a key the type does not name. If an index
// signature comes back on that type, the key compiles, the directive is
// unused, and the typecheck fails (TS2578). The organization() literals of
// consumerc, consumerd, and consumerb above guard OrganizationOptions:
// consumer-i's has no refused key since plan 9d.
export const strictOptionGuards = [
  passkey({
    rpID: "example.com",
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  }),
  magicLink({
    sendMagicLink: async () => {},
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  }),
  emailOTP({
    sendVerificationOTP: async () => {},
    // @ts-expect-error since plan 9e a key that Better Auth 1.7.2 does not name fails the compile
    notMapped: true,
  }),
  bearer({
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  }),
  expo({
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  }),
  twoFactor({
    // @ts-expect-error a refused key fails the compile (plan 9f)
    notMapped: true,
  }),
  {
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  } satisfies BetterAuthOptions,
  {
    emailAndPassword: {
      // @ts-expect-error since plan 9b a refused key fails the compile
      notMapped: true,
    },
  } satisfies BetterAuthOptions,
  {
    emailVerification: {
      // @ts-expect-error since plan 9b a refused key fails the compile
      notMapped: true,
    },
  } satisfies BetterAuthOptions,
  {
    socialProviders: {
      // @ts-expect-error since plan 9b a refused key fails the compile; github and linkedin map since plan 9c
      discord: { clientId: "d", clientSecret: "d" },
    },
  } satisfies BetterAuthOptions,
  {
    socialProviders: {
      google: {
        clientId: "g",
        clientSecret: "g",
        // @ts-expect-error since plan 9b a refused key fails the compile
        notMapped: true,
      },
    },
  } satisfies BetterAuthOptions,
  {
    socialProviders: {
      apple: {
        clientId: "a",
        // @ts-expect-error since plan 9b a refused key fails the compile
        notMapped: true,
      },
    },
  } satisfies BetterAuthOptions,
  {
    session: {
      // @ts-expect-error since plan 9b a refused key fails the compile
      notMapped: true,
    },
  } satisfies BetterAuthOptions,
  {
    session: {
      cookieCache: {
        // @ts-expect-error since plan 9b a refused key fails the compile
        notMapped: true,
      },
    },
  } satisfies BetterAuthOptions,
  {
    advanced: {
      // @ts-expect-error since plan 9b a refused key fails the compile
      notMapped: true,
    },
  } satisfies BetterAuthOptions,
  {
    advanced: {
      ipAddress: {
        // @ts-expect-error since plan 9b a refused key fails the compile
        notMapped: true,
      },
    },
  } satisfies BetterAuthOptions,
  {
    advanced: {
      defaultCookieAttributes: {
        // @ts-expect-error since plan 9b a refused key fails the compile
        notMapped: true,
      },
    },
  } satisfies BetterAuthOptions,
  {
    advanced: {
      database: {
        // @ts-expect-error since plan 9b a refused key fails the compile
        notMapped: true,
      },
    },
  } satisfies BetterAuthOptions,
  {
    rateLimit: {
      // @ts-expect-error since plan 9b a refused key fails the compile
      notMapped: true,
    },
  } satisfies BetterAuthOptions,
  {
    telemetry: {
      // @ts-expect-error since plan 9b a refused key fails the compile
      notMapped: true,
    },
  } satisfies BetterAuthOptions,
  {
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  } satisfies ClientOptions,
  {
    fetchOptions: {
      // @ts-expect-error since plan 9b a refused key fails the compile
      notMapped: true,
    },
  } satisfies ClientOptions,
  expoClient({
    scheme: "app",
    storage: { getItem: () => null, setItem: () => {} },
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  }),
  {
    provider: "pg",
    // @ts-expect-error since plan 9b a refused key fails the compile
    notMapped: true,
  } satisfies DrizzleAdapterConfig,
];

// The weak-type rule (TS2559, under TS2345 for an argument). `betterAuth`
// infers its type parameter, so TypeScript does not check its argument for
// extra keys. It still refuses a nested object that has no key in common with
// its type, because each nested option type has only optional keys: consumerd's
// `rateLimit: { customStorage }` stops the compile, and a literal
// `rateLimit: { max: 1 }` stops it with TS2353. These functions never run.
export const weakTypeGuards = [
  // @ts-expect-error weak type: consumerd's rateLimit has no key in common with { enabled?: boolean }
  () => betterAuth(consumerd),
  () =>
    betterAuth({
      database,
      // @ts-expect-error weak type: { max: 1 } has no key in common with { enabled?: boolean }
      rateLimit: { max: 1 },
    }),
];
