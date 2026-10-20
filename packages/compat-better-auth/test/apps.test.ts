import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import {
  adminAc,
  createAccessControl,
  defaultStatements,
  memberAc,
  ownerAc,
} from "../src/access.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { emailOTP, magicLink, organization, passkey } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";

/** Core's organizations config of mapped options. The organization plugin is set, so it is an object. */
function organizationsOf(o: BetterAuthOptions) {
  const organizations = mapOptions(o).config.organizations;
  if (!organizations) throw new Error("no organizations config");
  return { config: { organizations } };
}

const database = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});
const SECRET = "0123456789abcdef0123456789abcdef";

/**
 * consumerc services/identity/src/roles.ts and auth.ts at 8e604d1b, read
 * 2026-10-21. Removed, because the README still lists each as a refusal or a
 * required edit: `hooks`, the `expo` plugin, the Apple provider with its
 * `clientSecret`. Added, as the README tells it: `sendInvitationEmail`, and
 * `authtempo.roleRanks` from its own RANKS (viewer 0 becomes 1, so each
 * other rank is one higher; operator, absent there, ranks 1).
 */
function consumerc(): BetterAuthOptions {
  const identityStatement = {
    ...defaultStatements,
    project: ["read", "create", "update", "delete"],
  } as const;
  const ac = createAccessControl(identityStatement);
  const ALL_ORGANIZATION = ["update", "delete"] as const;
  const ALL_MEMBER = ["create", "update", "delete"] as const;
  const ALL_TEAM = ["create", "update", "delete"] as const;
  const ALL_AC = ["create", "read", "update", "delete"] as const;
  const ALL_PROJECT = ["read", "create", "update", "delete"] as const;
  const owner = ac.newRole({
    organization: [...ALL_ORGANIZATION],
    member: [...ALL_MEMBER],
    invitation: ["create", "cancel"],
    team: [...ALL_TEAM],
    ac: [...ALL_AC],
    project: [...ALL_PROJECT],
  });
  const admin = ac.newRole({
    organization: ["update"],
    member: [...ALL_MEMBER],
    invitation: ["create", "cancel"],
    team: [...ALL_TEAM],
    ac: [...ALL_AC],
    project: [...ALL_PROJECT],
  });
  const member = ac.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ["read"],
    project: ["read", "create", "update"],
  });
  const viewer = ac.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: [],
    project: ["read"],
  });
  const operator = ac.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ["read"],
    project: ["read"],
  });
  return {
    appName: "Consumerc",
    secret: SECRET,
    baseURL: "https://api.example.com",
    // The passkey origin: core's router answers 403 to a post from an origin it does not trust.
    trustedOrigins: ["https://consumerc.app"],
    database: database(),
    emailAndPassword: { enabled: false },
    socialProviders: { google: { clientId: "g", clientSecret: "g" } },
    advanced: { database: { generateId: () => "0190-uuid-v7" } },
    databaseHooks: { session: { create: { before: async (s: object) => ({ data: s }) } } },
    plugins: [
      organization({
        creatorRole: "owner",
        ac,
        roles: { owner, admin, member, viewer, operator },
        dynamicAccessControl: { enabled: true },
        organizationHooks: {},
        sendInvitationEmail: async () => {},
      }),
      passkey({ rpID: "consumerc.app", rpName: "Consumerc", origin: "https://consumerc.app" }),
      magicLink({ expiresIn: 600, sendMagicLink: async () => {} }),
    ],
    authtempo: { roleRanks: { viewer: 1, operator: 1, member: 2, admin: 3, owner: 4 } },
  };
}

/**
 * consumerd apps/api/src/auth/access.ts and create-auth.ts at c43c307, read
 * 2026-10-21. Removed, because the README still lists each as a refusal:
 * `hooks`, the `admin` and `anonymous` plugins, `disableOrganizationDeletion`,
 * `rateLimit.customStorage`, and `requireEmailVerificationOnInvitation:
 * false`. Added: `baseURL`, `secret`, the passkey `origin`, and
 * `authtempo.roleRanks` from its own ROLE_RANK. `teams: { enabled: true }`
 * is consumerd's fixed key of packages/db/src/auth-options.ts (plan 12k Task 11).
 */
function consumerd(): BetterAuthOptions {
  const statement = {
    ...defaultStatements,
    learner: ["read", "create", "update", "delete"],
    consent: ["read", "create", "revoke"],
    billing: ["read", "manage"],
    transcript: ["read"],
  } as const;
  const ac = createAccessControl(statement);
  const roles = {
    learner: ac.newRole({ learner: ["read"], consent: ["read"] }),
    guardian: ac.newRole({
      ...memberAc.statements,
      invitation: ["create", "cancel"],
      learner: ["read", "create", "update", "delete"],
      consent: ["read", "create", "revoke"],
      transcript: ["read"],
    }),
    teacher: ac.newRole({
      ...memberAc.statements,
      learner: ["read", "update"],
      consent: ["read"],
      transcript: ["read"],
    }),
    admin: ac.newRole({
      ...adminAc.statements,
      learner: ["read", "create", "update", "delete"],
      consent: ["read", "create", "revoke"],
      transcript: ["read"],
    }),
    owner: ac.newRole({
      ...ownerAc.statements,
      learner: ["read", "create", "update", "delete"],
      consent: ["read", "create", "revoke"],
      billing: ["read", "manage"],
      transcript: ["read"],
    }),
  };
  return {
    baseURL: "https://api.example.com/api/auth",
    basePath: "/api/auth",
    secret: SECRET,
    trustedOrigins: ["https://app.example.com"],
    database: database(),
    emailAndPassword: { enabled: false },
    advanced: {
      database: { generateId: () => "0190-uuid-v7" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      deferSessionRefresh: true,
      freshAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: true },
    plugins: [
      organization({
        teams: { enabled: true },
        creatorRole: "owner",
        membershipLimit: 100,
        organizationLimit: 1,
        ac,
        roles,
        sendInvitationEmail: async () => {},
        organizationHooks: {},
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: async () => {},
      }),
      magicLink({ expiresIn: 600, storeToken: "hashed", sendMagicLink: async () => {} }),
      passkey({ rpID: "app.example.com", rpName: "Consumerd", origin: "https://app.example.com" }),
    ],
    authtempo: {
      roleRanks: { learner: 1, guardian: 2, teacher: 2, admin: 3, owner: 4 },
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  };
}

describe("the apps' access control (plan 12k Task 10)", () => {
  it("constructs consumerc's option set with no refusal for ac, roles, or dynamicAccessControl", () => {
    const o = consumerc();
    expect(checkOptions(o).refusals).toEqual([]);
    expect(() => betterAuth(o)).not.toThrow();
    const org = organizationsOf(o).config.organizations;
    expect(Object.keys(org?.roles ?? {})).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
      "operator",
    ]);
    expect(org?.statements).toEqual({ project: ["read", "create", "update", "delete"] });
    expect(org?.dynamicRoles).toEqual({});
  });

  it("constructs consumerd's option set with no refusal for ac or roles", () => {
    const o = consumerd();
    expect(checkOptions(o).refusals).toEqual([]);
    expect(() => betterAuth(o)).not.toThrow();
    const org = organizationsOf(o).config.organizations;
    expect(Object.keys(org?.roles ?? {})).toEqual([
      "learner",
      "guardian",
      "teacher",
      "admin",
      "owner",
    ]);
    expect(org?.roles?.guardian?.permissions).toEqual({
      ac: ["read"],
      invitation: ["read", "create", "cancel"],
      learner: ["read", "create", "update", "delete"],
      consent: ["read", "create", "revoke"],
      transcript: ["read"],
      member: ["read"],
    });
    expect(org?.dynamicRoles).toBeUndefined();
  });

  it("constructs consumerd's option set with no refusal for teams", () => {
    const o = consumerd();
    expect(checkOptions(o).refusals).toEqual([]);
    expect(() => betterAuth(o)).not.toThrow();
    const org = organizationsOf(o).config.organizations;
    // Better Auth's defaults: a default team at each create, and no delete of the last team.
    expect(org?.teams).toEqual({ defaultTeam: true, keepLastTeam: true });
    expect(org?.limits).toEqual({
      perUser: 1,
      membersPerOrganization: 100,
      pendingInvitationsPerOrganization: 100,
    });
  });
});
