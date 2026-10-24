import { DatabaseSync } from "node:sqlite";
import {
  type Caller,
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import type { Statements } from "@authtempo/core/access";
import { describe, expect, it } from "vitest";
import {
  adminAc,
  createAccessControl,
  defaultRoles,
  defaultStatements,
  memberAc,
  ownerAc,
  role,
} from "../src/access.js";
import { createAuthClient, organizationClient } from "../src/client/index.js";
import { BetterAuthCompatError } from "../src/compat-error.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import type { BetterAuthOptions, CompatDatabase, OrganizationOptions } from "../src/types.js";
import {
  BETTER_AUTH_PG,
  BETTER_AUTH_ROLE_PG,
  BETTER_AUTH_ROLE_SQLITE,
  BETTER_AUTH_SQLITE,
} from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock } from "./pg.js";

/** Core's organizations config of mapped options. The organization plugin is set, so it is an object. */
function organizationsOf(o: BetterAuthOptions) {
  const organizations = mapOptions(o).config.organizations;
  if (!organizations) throw new Error("no organizations config");
  return { config: { organizations } };
}

const BASE = "https://api.example.com";
const PASSWORD = "correct horse battery";
const SECRET = "0123456789abcdef0123456789abcdef";
const at = new Date("2026-10-21T00:00:00.000Z");

const memory = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});

/** An app's own statements and three roles, in Better Auth's form, as consumerc and consumerd build them. */
const ac = createAccessControl({
  ...defaultStatements,
  project: ["read", "write", "delete"],
  apiKey: ["read", "create"],
});
const roles = {
  owner: ac.newRole({
    ...ownerAc.statements,
    project: ["read", "write", "delete"],
    apiKey: ["read"],
  }),
  admin: ac.newRole({ ...adminAc.statements, project: ["read", "write"] }),
  member: ac.newRole({ ...memberAc.statements, project: ["read"] }),
  lead: ac.newRole({ invitation: ["create"], project: ["read"] }),
};
const roleRanks = { member: 1, lead: 2, admin: 3, owner: 4 };

function options(
  org: OrganizationOptions,
  authtempo: NonNullable<BetterAuthOptions["authtempo"]> = {},
  database: CompatDatabase = memory(),
): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    database,
    plugins: [organization({ ...org, sendInvitationEmail: async () => {} })],
    authtempo,
  };
}

/** A shim app with passwords, so a test signs people up as an app does. */
function app(database: CompatDatabase, org: OrganizationOptions) {
  const mails: { email: string; token: string }[] = [];
  const auth = betterAuth({
    ...options(org, {
      roleRanks,
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    }),
    database,
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) => void mails.push({ email: d.user.email, token: d.token }),
    },
    plugins: [bearer(), organization({ ...org, sendInvitationEmail: async () => {} })],
  });
  /** Signs up, confirms the verify link as a person does, and signs in again. */
  const person = async (email: string) => {
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    const link = mails.findLast((m) => m.email === email);
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
        body: new URLSearchParams({ token: link?.token ?? "" }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    const token = (await auth.api.signInEmail({ body: { email, password: PASSWORD } })).token;
    const caller = await auth.tempo.caller(
      new Request(BASE, { headers: { authorization: `Bearer ${token}` } }),
    );
    if (caller?.kind !== "session") throw new Error(`no session caller for ${email}`);
    return { token, caller };
  };
  return { auth, person };
}

type SessionCaller = Extract<Caller, { kind: "session" }>;

describe("the access control shim (spec 29 item 18)", () => {
  it("keeps Better Auth's AND and OR in authorize", () => {
    const r = role({ project: ["read", "write"], member: ["create"] });
    // AND, the default: every resource and every action.
    expect(r.authorize({ project: ["read", "write"], member: ["create"] })).toEqual({
      success: true,
    });
    expect(r.authorize({ project: ["read", "delete"] })).toEqual({
      success: false,
      error: 'unauthorized to access resource "project"',
    });
    expect(r.authorize({ billing: ["read"] })).toEqual({
      success: false,
      error: "You are not allowed to access resource: billing",
    });
    expect(r.authorize({ project: [] })).toEqual({
      success: false,
      error: 'unauthorized to access resource "project"',
    });
    // OR across resources: one authorized resource is enough, and an unknown one is skipped.
    expect(r.authorize({ billing: ["read"], project: ["read"] }, "OR")).toEqual({
      success: true,
    });
    expect(r.authorize({ billing: ["read"], project: ["delete"] }, "OR")).toEqual({
      success: false,
      error: "Not authorized",
    });
    // OR inside one resource, with AND across resources.
    expect(
      r.authorize({
        project: { actions: ["delete", "write"], connector: "OR" },
        member: ["create"],
      }),
    ).toEqual({ success: true });
    expect(r.authorize({ project: { actions: ["delete", "write"], connector: "AND" } })).toEqual({
      success: false,
      error: 'unauthorized to access resource "project"',
    });
    expect(r.authorize({})).toEqual({ success: false, error: "Not authorized" });
    // Better Auth's own default roles answer the same.
    expect(defaultRoles.member.authorize({ ac: ["read"] })).toEqual({ success: true });
    expect(defaultRoles.admin.authorize({ organization: ["delete"] })).toEqual({
      success: false,
      error: 'unauthorized to access resource "organization"',
    });
    expect(ac.statements.project).toEqual(["read", "write", "delete"]);
  });

  it("maps a role table onto core's roles with member:read and invitation:read added", () => {
    const mapped = organizationsOf(
      options({ ac, roles, dynamicAccessControl: { enabled: true } }, { roleRanks }),
    ).config.organizations;
    // The six core resources and apiKey (core's apiToken) leave the app's own statements.
    expect(mapped?.statements).toEqual({ project: ["read", "write", "delete"] });
    expect(mapped?.ranks).toBeUndefined();
    expect(mapped?.roles).toEqual({
      owner: {
        rank: 4,
        permissions: {
          organization: ["update", "delete"],
          member: ["read", "create", "update", "delete"],
          invitation: ["read", "create", "cancel"],
          team: ["create", "update", "delete"],
          ac: ["create", "read", "update", "delete"],
          project: ["read", "write", "delete"],
          apiToken: ["read"],
        },
      },
      admin: {
        rank: 3,
        permissions: {
          organization: ["update"],
          invitation: ["read", "create", "cancel"],
          member: ["read", "create", "update", "delete"],
          team: ["create", "update", "delete"],
          ac: ["create", "read", "update", "delete"],
          project: ["read", "write"],
        },
      },
      // Better Auth's empty lists grant nothing, so they go.
      member: { rank: 1, permissions: { ac: ["read"], project: ["read"], member: ["read"] } },
      lead: {
        rank: 2,
        permissions: { invitation: ["read", "create"], project: ["read"], member: ["read"] },
      },
    });
    expect(mapped?.dynamicRoles).toEqual({});
    // With no roles option: Better Auth's three default roles, ranked member 1, admin 2, owner 3.
    const plain = organizationsOf(options({})).config.organizations;
    expect(plain?.statements).toEqual({});
    expect(plain?.dynamicRoles).toBeUndefined();
    expect(plain?.roles).toEqual({
      admin: {
        rank: 2,
        permissions: {
          organization: ["update"],
          invitation: ["read", "create", "cancel"],
          member: ["read", "create", "update", "delete"],
          team: ["create", "update", "delete"],
          ac: ["create", "read", "update", "delete"],
        },
      },
      owner: {
        rank: 3,
        permissions: {
          organization: ["update", "delete"],
          member: ["read", "create", "update", "delete"],
          invitation: ["read", "create", "cancel"],
          team: ["create", "update", "delete"],
          ac: ["create", "read", "update", "delete"],
        },
      },
      member: { rank: 1, permissions: { ac: ["read"], member: ["read"] } },
    });
  });

  it("refuses a role with no rank in authtempo.roleRanks", () => {
    const viewer = ac.newRole({ project: ["read"] });
    const given = options({ ac, roles: { ...roles, viewer } }, { roleRanks });
    expect(checkOptions(given).refusals).toEqual([
      "plugins[organization].roles.viewer: authtempo.roleRanks must rank viewer (spec 29 item 18)",
    ]);
    expect(() => betterAuth(given)).toThrow(BetterAuthCompatError);
    // A rank of a role that roles does not name is refused too, so no rank stays unused in silence.
    expect(
      checkOptions(options({ ac, roles }, { roleRanks: { ...roleRanks, ghost: 2 } })).refusals,
    ).toEqual([
      "authtempo.roleRanks.ghost: ranks no role of plugins[organization].roles (spec 29 item 18)",
    ]);
    expect(checkOptions(options({ ac, roles }, { roleRanks })).refusals).toEqual([]);
  });

  it("refuses authtempo.roleRanks with no roles option", () => {
    // The default roles keep member 1, admin 2, owner 3, so these ranks would change nothing.
    const given = options({}, { roleRanks: { member: 1, admin: 7, owner: 9 } });
    expect(checkOptions(given).refusals).toEqual([
      "authtempo.roleRanks: needs plugins[organization].roles; the default roles rank member 1, admin 2, owner 3 (spec 29 item 18)",
    ]);
    expect(() => betterAuth(given)).toThrow(BetterAuthCompatError);
    expect(checkOptions(options({})).refusals).toEqual([]);
  });

  it("refuses an ac resource named apiToken and an action that a core resource lacks", () => {
    const own = createAccessControl({ ...defaultStatements, apiToken: ["read"] });
    expect(
      checkOptions(
        options({ ac: own, roles: { owner: own.newRole({}) } }, { roleRanks: { owner: 1 } }),
      ).refusals,
    ).toEqual([
      "plugins[organization].ac.statements.apiToken: apiToken is core's name of Better Auth's apiKey; name the resource apiKey (spec 29 item 18)",
    ]);
    // A role that names apiToken would get core's token read in silence.
    const tokenRole = { owner: ac.newRole({ apiToken: ["read"] }) };
    expect(
      checkOptions(options({ ac, roles: tokenRole }, { roleRanks: { owner: 1 } })).refusals,
    ).toEqual([
      "plugins[organization].roles.owner.statements.apiToken: apiToken is core's name of Better Auth's apiKey; name the resource apiKey (spec 29 item 18)",
    ]);
    // An action that core's resource lacks is refused, not dropped. Better Auth's apiKey delete
    // is core's apiToken revoke (ruling 39 of plan 12k), so the refused action is another one.
    const extra = createAccessControl({
      ...defaultStatements,
      member: ["create", "ban"],
      apiKey: ["read", "delete", "rotate"],
    });
    expect(
      checkOptions(
        options({ ac: extra, roles: { owner: extra.newRole({}) } }, { roleRanks: { owner: 1 } }),
      ).refusals,
    ).toEqual([
      "plugins[organization].ac.statements.apiKey: core's apiToken takes only the actions read, create, update, revoke (spec 29 item 18)",
      "plugins[organization].ac.statements.member: core's member takes only the actions read, create, update, delete (spec 29 item 18)",
    ]);
  });

  it("refuses an ac resource or action that core's name rule refuses", () => {
    const bad = createAccessControl({
      ...defaultStatements,
      Project: ["read"],
      billing: [],
      ledger: ["read", "read"],
      report: ["Read"],
      notes: ["read"],
    });
    expect(
      checkOptions(
        options({ ac: bad, roles: { owner: bad.newRole({}) } }, { roleRanks: { owner: 1 } }),
      ).refusals,
    ).toEqual([
      "plugins[organization].ac.statements.Project: core takes a resource name of ^[a-z][a-zA-Z0-9-]{0,31}$ (spec 29 item 18)",
      "plugins[organization].ac.statements.billing: core takes a list of one or more distinct action names of ^[a-z][a-zA-Z0-9-]{0,31}$ (spec 29 item 18)",
      "plugins[organization].ac.statements.ledger: core takes a list of one or more distinct action names of ^[a-z][a-zA-Z0-9-]{0,31}$ (spec 29 item 18)",
      "plugins[organization].ac.statements.report: core takes a list of one or more distinct action names of ^[a-z][a-zA-Z0-9-]{0,31}$ (spec 29 item 18)",
    ]);
  });

  it("takes maximumRolesPerOrganization from 1 to 1000 only", () => {
    const at = (n: number) =>
      checkOptions(
        options(
          { ac, roles, dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: n } },
          { roleRanks },
        ),
      ).refusals;
    for (const n of [0, 1001, 1.5, -1])
      expect(at(n)).toEqual([
        "plugins[organization].dynamicAccessControl.maximumRolesPerOrganization: core takes an integer from 1 to 1000 (spec 29 item 18)",
      ]);
    expect(at(1)).toEqual([]);
    expect(at(1000)).toEqual([]);
  });

  it("refuses authtempo.roleRanks with no organization plugin", () => {
    const given: BetterAuthOptions = {
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      database: memory(),
      authtempo: { roleRanks },
    };
    expect(checkOptions(given).refusals).toEqual([
      "authtempo.roleRanks: needs plugins[organization] (spec 29 item 18)",
    ]);
    expect(checkOptions({ ...given, authtempo: {} }).refusals).toEqual([]);
  });

  it("names the spec item in each refusal of the access control map", () => {
    // Better Auth's types admit none of these values, so each literal is cast.
    const loose = (o: Record<string, unknown>) => o as unknown as OrganizationOptions;
    const bad = options(loose({ ac, roles: "all", dynamicAccessControl: "on" }), {
      roleRanks: 5 as unknown as Record<string, number>,
    });
    expect(checkOptions(bad).refusals).toEqual([
      "authtempo.roleRanks: expected an object (spec 29 item 18)",
      "plugins[organization].dynamicAccessControl: expected { enabled, maximumRolesPerOrganization? } (spec 29 item 18)",
      "plugins[organization].roles: expected an object (spec 29 item 18)",
    ]);
    const keys = options(
      loose({
        ac,
        roles: { admin: roles.admin },
        dynamicAccessControl: { enabled: "yes", cache: true },
      }),
      { roleRanks: { admin: 1 } },
    );
    expect(checkOptions(keys).refusals).toEqual([
      "plugins[organization].dynamicAccessControl.cache: authtempo has no such option (spec 29 item 18)",
      "plugins[organization].dynamicAccessControl.enabled: expected a boolean (spec 29 item 18)",
      "plugins[organization].roles: core needs the role owner, the creator role (spec 29 items 2 and 18)",
    ]);
  });

  it("refuses dynamicAccessControl as a function", () => {
    // Better Auth's type admits a function; this package's type does not, so the literal is cast.
    const dynamicAccessControl = {
      enabled: true,
      maximumRolesPerOrganization: () => 5,
    } as unknown as NonNullable<OrganizationOptions["dynamicAccessControl"]>;
    const fn = options({ ac, roles, dynamicAccessControl }, { roleRanks });
    expect(checkOptions(fn).refusals).toEqual([
      "plugins[organization].dynamicAccessControl.maximumRolesPerOrganization: a function is refused; pass a positive integer from 1 to 1000 (spec 29 item 18)",
    ]);
    const n = options(
      { ac, roles, dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 20 } },
      { roleRanks },
    );
    expect(checkOptions(n).refusals).toEqual([]);
    expect(organizationsOf(n).config.organizations?.dynamicRoles).toEqual({
      maxPerOrganization: 20,
    });
  });

  it("never reads a stored row named as a static role", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      const database = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, database.names);
      const { auth, person } = app(database, {
        ac,
        roles,
        dynamicAccessControl: { enabled: true },
      });
      const owner = (await person("owner@example.com")).caller as SessionCaller;
      const pat = (await person("pat@example.com")).caller as SessionCaller;
      const created = await auth.tempo.api.createOrganization({
        user: owner.user,
        slug: "acme",
        name: "Acme",
      });
      if (!created.ok) throw new Error(created.code);
      const organizationId = created.value.organization.id;
      // Rows that Better Auth wrote before the cutover: one named as the static role admin.
      await pg.sql.unsafe(
        `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt") VALUES
          ('r-admin', $1, 'admin', '{"project":["read","write","delete"]}', $2),
          ('r-closer', $1, 'closer', '{"project":["delete"]}', $2)`,
        [organizationId, at.toISOString()],
      );
      const added = await auth.tempo.api.addMember({
        user: owner.user,
        organizationId,
        userId: pat.user.id,
        role: "admin",
      });
      expect(added.ok).toBe(true);
      const wants = { organizationId, permissions: { project: ["delete"] } };
      expect(
        await auth.tempo.hasPermission(pat, { ...wants, permissions: { project: ["write"] } }),
      ).toBe(true);
      expect(await auth.tempo.hasPermission(pat, wants)).toBe(false);
      // The stored rows are read for a part that no static role names.
      const changed = await auth.tempo.api.updateMemberRole({
        user: owner.user,
        organizationId,
        userId: pat.user.id,
        role: "admin,closer",
      });
      expect(changed.ok).toBe(true);
      expect(await auth.tempo.hasPermission(pat, wants)).toBe(true);
    } finally {
      await pg.close();
    }
  });

  describe("reads a Better Auth era role row with the list reads (ruling 29 Q5)", () => {
    /** A Postgres shim app with one organization of an owner, and a client of each person. */
    async function era() {
      const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
      const database = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, database.names);
      const { auth, person } = app(database, {
        ac,
        roles,
        dynamicAccessControl: { enabled: true },
      });
      const clientOf = (token: string) =>
        createAuthClient({
          baseURL: BASE,
          basePath: "/api/auth",
          plugins: [organizationClient({ ac, roles })],
          fetchOptions: {
            customFetchImpl: async (input, init) => auth.handler(new Request(input, init)),
            headers: { authorization: `Bearer ${token}` },
          },
        });
      const owner = await person("owner@example.com");
      const created = await auth.tempo.api.createOrganization({
        user: (owner.caller as SessionCaller).user,
        slug: "acme",
        name: "Acme",
      });
      if (!created.ok) throw new Error(created.code);
      return { pg, auth, person, clientOf, owner, organizationId: created.value.organization.id };
    }

    /** The row as Better Auth's create-role writes it: JSON.stringify of the permission, no updatedAt. */
    const insertRow = (
      pg: Awaited<ReturnType<typeof freshBetterAuthSchema>>,
      organizationId: string,
      role: string,
      permission: string,
    ) =>
      pg.sql.unsafe(
        `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt") VALUES ($1, $2, $3, $4, $5)`,
        [`r-${role}`, organizationId, role, permission, at.toISOString()],
      );
    const textOf = async (pg: Awaited<ReturnType<typeof freshBetterAuthSchema>>, role: string) =>
      (
        await pg.sql.unsafe<{ permission: string }[]>(
          `SELECT "permission" FROM "organizationRole" WHERE "role" = $1`,
          [role],
        )
      )[0]?.permission;

    it("lets the holder of a Better Auth era row list the members, and not the invitations (ruling 35)", async () => {
      const { pg, auth, person, clientOf, owner, organizationId } = await era();
      try {
        // Better Auth lets every member list the members, so its row holds no member:read.
        await insertRow(pg, organizationId, "closer", '{"project":["delete"]}');
        const pat = await person("pat@example.com");
        const added = await auth.tempo.api.addMember({
          user: (owner.caller as SessionCaller).user,
          organizationId,
          userId: (pat.caller as SessionCaller).user.id,
          role: "closer",
        });
        expect(added.ok).toBe(true);
        const full = await clientOf(pat.token).organization.getFullOrganization({ organizationId });
        expect(full.error).toBeNull();
        expect(full.data?.members.map((m) => m.role).sort()).toEqual(["closer", "owner"]);
        // The read added member:read in memory only: the text stays Better Auth's.
        expect(await textOf(pg, "closer")).toBe('{"project":["delete"]}');
        // Better Auth lets every member list the invitations; the shim is stricter and fails closed.
        const invitations = await auth.tempo.api.listInvitations({
          user: (pat.caller as SessionCaller).user,
          organizationId,
        });
        expect(invitations).toMatchObject({ ok: false, code: "forbidden_rank" });
      } finally {
        await pg.close();
      }
    });

    it("lets the holder of a Better Auth era row that invites list the members and the invitations", async () => {
      const { pg, auth, person, clientOf, owner, organizationId } = await era();
      try {
        await insertRow(pg, organizationId, "inviter", '{"invitation":["create"]}');
        const pat = await person("pat@example.com");
        const added = await auth.tempo.api.addMember({
          user: (owner.caller as SessionCaller).user,
          organizationId,
          userId: (pat.caller as SessionCaller).user.id,
          role: "inviter",
        });
        expect(added.ok).toBe(true);
        const full = await clientOf(pat.token).organization.getFullOrganization({ organizationId });
        expect(full.error).toBeNull();
        expect(full.data?.members.map((m) => m.role).sort()).toEqual(["inviter", "owner"]);
        const invitations = await auth.tempo.api.listInvitations({
          user: (pat.caller as SessionCaller).user,
          organizationId,
        });
        expect(invitations).toEqual({ ok: true, value: [] });
        expect(await textOf(pg, "inviter")).toBe('{"invitation":["create"]}');
      } finally {
        await pg.close();
      }
    });

    it("keeps a stored member read after an update (ruling 37)", async () => {
      const { pg, clientOf, owner, organizationId } = await era();
      try {
        // A Better Auth app may name member:read in its own statements.
        await insertRow(
          pg,
          organizationId,
          "closer",
          '{"member":["read","update"],"project":["read"]}',
        );
        const client = clientOf(owner.token);
        const same = await client.organization.updateRole({
          roleName: "closer",
          organizationId,
          data: {},
        });
        expect(same.error).toBeNull();
        expect(await textOf(pg, "closer")).toBe('{"member":["read","update"],"project":["read"]}');
        const edited = await client.organization.updateRole({
          roleName: "closer",
          organizationId,
          data: { permission: { member: ["read", "update"], project: ["read", "write"] } },
        });
        expect(edited.error).toBeNull();
        expect(await textOf(pg, "closer")).toBe(
          '{"member":["read","update"],"project":["read","write"]}',
        );
      } finally {
        await pg.close();
      }
    });

    it("gives Better Auth's role check the same answers on the row after a write", async () => {
      const { pg, clientOf, owner, organizationId } = await era();
      try {
        const texts = [
          '{"member":["read","update"],"project":["read"]}',
          '{"project":["delete"],"apiKey":["read"],"invitation":["create"]}',
        ];
        for (const [i, text] of texts.entries())
          await insertRow(pg, organizationId, `role${i}`, text);
        const client = clientOf(owner.token);
        for (const i of texts.keys()) {
          const done = await client.organization.updateRole({
            roleName: `role${i}`,
            organizationId,
            data: {},
          });
          expect(done.error).toBeNull();
        }
        // Each request that Better Auth checks, one action at a time: every action of
        // ac.statements (with Better Auth's defaults) and of the stored text itself.
        const requestsOf = (text: string) =>
          [
            ...Object.entries(ac.statements),
            ...Object.entries(JSON.parse(text) as Statements),
          ].flatMap(([resource, actions]) => actions.map((action) => ({ [resource]: [action] })));
        for (const [i, text] of texts.entries()) {
          const after = (await textOf(pg, `role${i}`)) ?? "";
          const before = role(JSON.parse(text));
          const written = role(JSON.parse(after));
          for (const request of requestsOf(text))
            expect({ request, success: written.authorize(request).success }).toEqual({
              request,
              success: before.authorize(request).success,
            });
        }
      } finally {
        await pg.close();
      }
    });
  });

  it("maps apiKey in a stored permission onto apiToken and back", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG + BETTER_AUTH_ROLE_PG);
    try {
      await pg.sql.unsafe(
        `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o1', 'Acme', 'acme', $1)`,
        [at.toISOString()],
      );
      // As Better Auth's create-role writes a row: JSON text, no updatedAt.
      await pg.sql.unsafe(
        `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt") VALUES
          ('r1', 'o1', 'keys', '{"apiKey":["read"],"project":["read"]}', $1),
          ('r2', 'o1', 'broken', '{', $1)`,
        [at.toISOString()],
      );
      const { storage, migrate } = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrate();
      const byId = (id: string) => [{ field: "id" as const, op: "eq" as const, value: id }];
      expect(await storage.findOne("organizationRole", byId("r1"))).toEqual({
        id: "r1",
        organizationId: "o1",
        name: "keys",
        rank: 1,
        // The read adds member:read in memory (ruling 29 Q5); the text holds none.
        permissions: { apiToken: ["read"], project: ["read"], member: ["read"] },
        createdAt: at,
        updatedAt: at,
      });
      // A text that is not JSON reads as the text, so core's shape rule refuses the row.
      expect((await storage.findOne("organizationRole", byId("r2")))?.permissions).toBe("{");
      const later = new Date(at.getTime() + 60_000);
      await storage.update("organizationRole", byId("r1"), {
        permissions: { apiToken: ["read", "create"], project: ["read"] },
        updatedAt: later,
      });
      await storage.create("organizationRole", {
        id: "r3",
        organizationId: "o1",
        name: "minter",
        rank: 2,
        permissions: { apiToken: ["create"] },
        createdAt: later,
        updatedAt: later,
      });
      const raw = await pg.sql.unsafe<{ id: string; permission: string; taRank: number }[]>(
        `SELECT "id", "permission", "taRank" FROM "organizationRole" WHERE "id" IN ('r1', 'r3') ORDER BY "id"`,
      );
      expect(raw.map((r) => ({ ...r, permission: JSON.parse(r.permission) }))).toEqual([
        { id: "r1", permission: { apiKey: ["read", "create"], project: ["read"] }, taRank: 1 },
        { id: "r3", permission: { apiKey: ["create"] }, taRank: 2 },
      ]);
      expect((await storage.findOne("organizationRole", byId("r1")))?.permissions).toEqual({
        apiToken: ["read", "create"],
        project: ["read"],
        member: ["read"],
      });
    } finally {
      await pg.close();
    }
  });

  describe("migrates a database with the table and one with no table", () => {
    it("on Postgres", async () => {
      for (const withTable of [true, false]) {
        const pg = await freshBetterAuthSchema(
          withTable ? BETTER_AUTH_PG + BETTER_AUTH_ROLE_PG : BETTER_AUTH_PG,
        );
        try {
          await pg.sql.unsafe(
            `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o1', 'Acme', 'acme', $1)`,
            [at.toISOString()],
          );
          if (withTable)
            await pg.sql.unsafe(
              `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt") VALUES ('r1', 'o1', 'auditor', '{"project":["read"]}', $1)`,
              [at.toISOString()],
            );
          const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
          await migrateWithoutLock(pg.sql, s.names);
          const columns = await pg.sql.unsafe<{ c: string; n: string; d: string | null }[]>(
            `SELECT column_name AS c, is_nullable AS n, column_default AS d FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'organizationRole' ORDER BY ordinal_position`,
          );
          expect({ withTable, columns: columns.map((r) => r.c) }).toEqual({
            withTable,
            columns: [
              "id",
              "organizationId",
              "role",
              "permission",
              "createdAt",
              "updatedAt",
              "taRank",
            ],
          });
          expect(columns.at(-1)).toEqual({ c: "taRank", n: "NO", d: "1" });
          if (!withTable)
            await s.storage.create("organizationRole", {
              id: "r1",
              organizationId: "o1",
              name: "auditor",
              rank: 1,
              permissions: { project: ["read"] },
              createdAt: at,
              updatedAt: at,
            });
          expect(
            await s.storage.findOne("organizationRole", [{ field: "id", op: "eq", value: "r1" }]),
          ).toEqual({
            id: "r1",
            organizationId: "o1",
            name: "auditor",
            rank: 1,
            permissions: { project: ["read"], member: ["read"] },
            createdAt: at,
            updatedAt: at,
          });
          // The unique key on (organizationId, role) that core's role rule 1 needs.
          await expect(
            pg.sql.unsafe(
              `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt") VALUES ('r2', 'o1', 'auditor', '{}', now())`,
            ),
          ).rejects.toMatchObject({ code: "23505" });
          expect(
            await pg.sql.unsafe(`SELECT key, value FROM ta_meta ORDER BY key`).then((r) => [...r]),
          ).toEqual([
            { key: "compat_better_auth", value: "11" },
            { key: "schema_version", value: "14" },
          ]);
        } finally {
          await pg.close();
        }
      }
    });

    it("on D1, with the shipped files in node:sqlite", () => {
      const files = import.meta.glob<string>("../migrations/d1/*.sql", {
        query: "?raw",
        import: "default",
        eager: true,
      });
      const shipped = Object.keys(files)
        .sort()
        .map((k) => files[k] as string);
      expect(shipped.length).toBe(11);
      for (const withTable of [true, false]) {
        const db = new DatabaseSync(":memory:");
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(withTable ? BETTER_AUTH_SQLITE + BETTER_AUTH_ROLE_SQLITE : BETTER_AUTH_SQLITE);
        db.exec(
          `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o1', 'Acme', 'acme', '${at.toISOString()}')`,
        );
        if (withTable)
          db.exec(
            `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt") VALUES ('r1', 'o1', 'auditor', '{"project":["read"]}', '${at.toISOString()}')`,
          );
        for (const text of shipped) db.exec(text);
        const columns = (
          db.prepare(`PRAGMA table_info("organizationRole")`).all() as {
            name: string;
            notnull: number;
            dflt_value: unknown;
          }[]
        ).map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value }));
        expect({ withTable, names: columns.map((c) => c.name) }).toEqual({
          withTable,
          names: ["id", "organizationId", "role", "permission", "createdAt", "updatedAt", "taRank"],
        });
        expect(columns.at(-1)).toEqual({ name: "taRank", notnull: 1, dflt_value: "1" });
        if (!withTable)
          db.exec(
            `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt", "taRank") VALUES ('r1', 'o1', 'auditor', '{"project":["read"]}', '${at.toISOString()}', 1)`,
          );
        expect(db.prepare(`SELECT "taRank" AS r FROM "organizationRole"`).all()).toEqual([
          { r: 1 },
        ]);
        expect(() =>
          db.exec(
            `INSERT INTO "organizationRole" ("id", "organizationId", "role", "permission", "createdAt") VALUES ('r2', 'o1', 'auditor', '{}', '${at.toISOString()}')`,
          ),
        ).toThrow(/UNIQUE constraint failed/);
        expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
          { key: "compat_better_auth", value: "11" },
          { key: "schema_version", value: "14" },
        ]);
      }
    });
  });

  it("serves the role calls, hasPermission, and checkRolePermission of the client in Better Auth's shapes", async () => {
    const { auth, person } = app(memory(), { ac, roles, dynamicAccessControl: { enabled: true } });
    const { token, caller } = await person("owner@example.com");
    const client = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [organizationClient({ ac, roles })],
      fetchOptions: {
        customFetchImpl: async (input, init) => auth.handler(new Request(input, init)),
        headers: { authorization: `Bearer ${token}` },
      },
    });
    const created = await auth.tempo.api.createOrganization({
      user: (caller as SessionCaller).user,
      slug: "acme",
      name: "Acme",
    });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    await client.organization.setActive({ organizationId });
    const made = await client.organization.createRole({
      role: "auditor",
      permission: { project: ["read"], apiKey: ["read"] },
    });
    expect(made.error).toBeNull();
    expect(made.data).toEqual({
      success: true,
      roleData: {
        id: expect.any(String),
        organizationId,
        role: "auditor",
        permission: { project: ["read"], apiKey: ["read"], member: ["read"] },
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
      statements: { project: ["read"], apiKey: ["read"] },
    });
    const list = await client.organization.listRoles();
    expect(list.data?.map((r) => [r.role, r.permission])).toEqual([
      ["auditor", { project: ["read"], apiKey: ["read"], member: ["read"] }],
    ]);
    const id = list.data?.[0]?.id ?? "";
    expect((await client.organization.getRole({ query: { roleId: id } })).data?.role).toBe(
      "auditor",
    );
    const updated = await client.organization.updateRole({
      roleName: "auditor",
      data: { permission: { project: ["read", "write"] } },
    });
    expect(updated.data?.roleData.permission).toEqual({
      project: ["read", "write"],
      member: ["read"],
    });
    expect(
      (await client.organization.hasPermission({ permissions: { project: ["delete"] } })).data,
    ).toEqual({ error: null, success: true });
    expect(
      (await client.organization.hasPermission({ permissions: { billing: ["read"] } })).data,
    ).toEqual({ error: null, success: false });
    // Better Auth's own answers for the refusals of core (ruling 22).
    const taken = await client.organization.createRole({
      role: "auditor",
      permission: { project: ["read"] },
    });
    expect(taken.error).toMatchObject({ code: "ROLE_NAME_IS_ALREADY_TAKEN", status: 409 });
    expect(
      (
        await client.organization.createRole({
          role: "extra",
          permission: { project: ["read"] },
          additionalFields: { color: "red" },
        })
      ).error,
    ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    expect(
      (
        await client.organization.updateRole({
          roleName: "auditor",
          data: { roleName: "reader" },
        })
      ).error,
    ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    expect(
      (
        await client.organization.hasPermission({
          permissions: { project: ["read"] },
          allowCreatorAllPermissions: true,
        })
      ).error,
    ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    expect((await client.organization.deleteRole({ roleName: "auditor" })).data).toEqual({
      success: true,
    });
    expect((await client.organization.listRoles()).data).toEqual([]);
    // The client check reads the roles of organizationClient, as Better Auth's does.
    expect(
      client.organization.checkRolePermission({
        role: "lead,member",
        permissions: { invitation: ["create"] },
      }),
    ).toBe(true);
    expect(
      client.organization.checkRolePermission({
        role: "member",
        permissions: { project: ["write"] },
      }),
    ).toBe(false);
    // Better Auth reads permissions only, so a request in permission is no request.
    const singular = { role: "lead", permission: { invitation: ["create"] } };
    expect(client.organization.checkRolePermission(singular as never)).toBe(false);
  });
});
