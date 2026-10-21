import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type ModelName,
  type ResolvedSession,
  type StorageAdapter,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The machine check of the one lock order of user-hold.ts (ruling 49 of
// plan 12k). The order has five kinds of rows: the user row, the session
// rows, the organization row, the member rows, and the team rows with the
// team member rows. A storage wrapper records each create, update, delete,
// and lock read of these kinds in each transaction, in order. Each test runs
// one flow of plan 12f or 12k that writes these kinds, most of them two kinds
// or more. A kind may come again, but a kind never comes first after a later
// kind. A new flow out of order fails here, with no race probe. Each state
// comes from the flows: the routes, the magic link, the organization api,
// and the operator api.

const API = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const PASSWORD = "correct horse battery";
/** Every request passes: the order, not the limit, is under test. */
const OPEN = { allow: async () => true };

/** The kinds of user-hold.ts, in the lock order. */
const KINDS = ["user", "session", "organization", "member", "team"] as const;
const KIND_OF = {
  user: 0,
  session: 1,
  organization: 2,
  member: 3,
  team: 4,
  teamMember: 4,
} as const;
const kindOf = (model: ModelName): number | undefined =>
  (KIND_OF as Partial<Record<ModelName, number>>)[model];

/** One recorded statement of a transaction: its kind and its text, such as `delete member`. */
interface Step {
  kind: number;
  text: string;
}

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * The engine on Postgres with teams, dynamic roles, the operator tools, and
 * impersonation on. Each transaction that starts inside `flow` records its
 * steps under the name of the flow.
 */
function world(teams: { keepLastTeam?: boolean } = {}) {
  const sent: MailMessage[] = [];
  let current: string | null = null;
  const runs: { flow: string; steps: Step[] }[] = [];
  const note = (steps: Step[], model: ModelName, verb: string) => {
    const kind = kindOf(model);
    if (kind !== undefined) steps.push({ kind, text: `${verb} ${model}` });
  };
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter, steps: Step[]): StorageAdapter => ({
    ...tx,
    create: ((model: ModelName, data: never) => {
      note(steps, model, "create");
      return tx.create(model, data);
    }) as typeof tx.create,
    update: ((model: ModelName, where: never, data: never) => {
      note(steps, model, "update");
      return tx.update(model, where, data);
    }) as typeof tx.update,
    delete: ((model: ModelName, where: never) => {
      note(steps, model, "delete");
      return tx.delete(model, where);
    }) as typeof tx.delete,
    lockInOrder: (async (model, where) => {
      note(steps, model, "lock");
      await tx.lockInOrder?.(model, where);
    }) as NonNullable<StorageAdapter["lockInOrder"]>,
    transaction: ((fn: (inner: StorageAdapter) => Promise<unknown>) =>
      tx.transaction((inner) => fn(wrap(inner, steps)))) as typeof tx.transaction,
  });
  const storage: StorageAdapter = {
    ...adapter,
    transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
      adapter.transaction((tx) => {
        const steps: Step[] = [];
        if (current !== null) runs.push({ flow: current, steps });
        return fn(wrap(tx, steps));
      })) as typeof adapter.transaction,
  };
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    // A low iteration count: the test is about the order of the locks, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: {
      teams: { defaultTeam: true, ...teams },
      dynamicRoles: { maxPerOrganization: 5 },
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true, impersonation: {} },
  });
  const post = (path: string, body: unknown, cookie: string) =>
    auth.handle(
      new Request(`${API}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    );
  const lastMail = (to: string) => sent.filter((x) => x.to === to).at(-1)?.text ?? "";
  const lastToken = (to: string) => {
    const m = /token=([A-Za-z0-9_%-]+)/.exec(lastMail(to));
    if (!m?.[1]) throw new Error(`no token in the last mail to ${to}`);
    return decodeURIComponent(m[1]);
  };
  /**
   * A sign-in by a magic link: the user on the first one. A user with the
   * second factor on passes the challenge with `backupCode`.
   */
  async function signIn(email: string, backupCode?: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const r = await auth.api.verifyMagicLink({
      token: lastToken(email),
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    let token: string;
    if ("token" in r.value) token = r.value.token;
    else {
      const totp = auth.api.totp;
      if (!totp || backupCode === undefined) throw new Error("the link answered a challenge");
      const v = await totp.verify({
        challenge: r.value.twoFactor.challenge,
        backupCode,
        ip: null,
      });
      if (!v.ok) throw new Error(v.code);
      token = v.value.token;
    }
    return { ...(await sessionOf(token)), token };
  }
  async function sessionOf(token: string): Promise<ResolvedSession> {
    const s = await auth.api.getSession(token);
    if (!s) throw new Error("no session");
    return s;
  }
  /**
   * A platform operator: a verified user with a password and the second
   * factor through the routes, then the platform role through `createAdmin`.
   */
  async function operator(email: string) {
    const s = await signIn(email);
    const cookie = `__Host-tempo_session=${s.token}`;
    expect((await post("/password/change", { newPassword: PASSWORD }, cookie)).status).toBe(200);
    const setup = await post("/totp/setup", { password: PASSWORD }, cookie);
    const keys = (await setup.json()) as { secret: string; backupCodes: string[] };
    const code = await totpCode(base32Decode(keys.secret), new Date());
    expect((await post("/totp/enable", { code }, cookie)).status).toBe(200);
    const admin = await auth.api.operator.createAdmin({
      actor: APP,
      email,
      reason: "Support rota",
      ip: null,
      userAgent: null,
    });
    if (!admin.ok) throw new Error(admin.code);
    // The operator guard refuses a session from before the grant (ruling 50 of plan 12f).
    await new Promise((r) => setTimeout(r, 5));
    const after = await signIn(email, keys.backupCodes[0]);
    await auth.api.signOut(s.token);
    return after;
  }
  /** Runs `call` as the flow `name`: each transaction it starts records its steps. */
  async function flow<T>(name: string, call: () => Promise<T>): Promise<T> {
    current = name;
    try {
      return await call();
    } finally {
      current = null;
    }
  }
  /** The kinds that the transactions of `name` touched. */
  function kindsOf(name: string): string[] {
    const seen = new Set(runs.filter((r) => r.flow === name).flatMap((r) => r.steps));
    return KINDS.filter((_, i) => [...seen].some((s) => s.kind === i));
  }
  /**
   * Each step of a transaction of `name` that comes out of order. An
   * update, a delete, or a lock read takes the locks of rows that other
   * flows see, so its kind never comes first after a later kind. A kind
   * that came before may come again: its rows are held from the first time.
   *
   * A create takes the lock of its new row only, and no other flow sees
   * that row before the commit. The one wait it can meet is a parallel
   * insert of the same unique key. So the order skips a create, and a
   * second rule holds instead: a create of a member or team member row
   * comes after a step on the user row in its transaction. Two inserts of
   * one member then run one at a time.
   */
  function outOfOrder(name: string): string[] {
    const found: string[] = [];
    for (const [i, run] of runs.filter((r) => r.flow === name).entries()) {
      const seen = new Set<number>();
      let last: Step | null = null;
      for (const step of run.steps) {
        if (step.text.startsWith("create ")) {
          if (/^create (member|teamMember)$/.test(step.text) && !seen.has(KIND_OF.user))
            found.push(`transaction ${i + 1}: ${step.text} before any step on the user row`);
          if (step.kind === KIND_OF.user) seen.add(step.kind);
          continue;
        }
        if (last !== null && step.kind < last.kind && !seen.has(step.kind))
          found.push(`transaction ${i + 1}: ${step.text} after ${last.text}`);
        seen.add(step.kind);
        if (last === null || step.kind > last.kind) last = step;
      }
    }
    return found;
  }
  /** The steps of each transaction of `name`, for a failure message. */
  function stepsOf(name: string): string[][] {
    return runs.filter((r) => r.flow === name).map((r) => r.steps.map((x) => x.text));
  }
  return {
    auth,
    storage,
    signIn,
    sessionOf,
    operator,
    flow,
    kindsOf,
    outOfOrder,
    stepsOf,
    lastMail,
  };
}

type World = ReturnType<typeof world>;
type Signed = Awaited<ReturnType<World["signIn"]>>;

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** The platform organization's id. */
async function platformId(): Promise<string> {
  const rows = await db.sql<{ id: string }[]>`
    SELECT id FROM ta_organization WHERE slug = 'platform-co'`;
  return rows[0]?.id ?? "";
}

/** Sets the active organization and team of the session of `s`. Answers the session after. */
async function activate(w: World, s: Signed, organizationId: string, teamId: string) {
  must(await w.auth.api.setActiveOrganization({ session: s, organizationId }));
  must(await w.auth.api.setActiveTeam({ session: await w.sessionOf(s.token), teamId }));
  return { ...(await w.sessionOf(s.token)), token: s.token };
}

/**
 * The scene of each test.
 * - Ada, Bob, and Cal are platform operators. Bob impersonates Tia; Cal
 *   has no impersonation. Bob and Cal are in the team Support of the
 *   platform organization, and their sessions act in it.
 * - Ada owns Acme with Oli, a second owner. Pat is a member. Pat and Oli
 *   are in the team Core, and their sessions act in it.
 * - Oli alone holds Oli Co. Its default team holds Oli, and a second
 *   session of Oli acts in it.
 */
async function scene(w: World) {
  const ada = await w.operator("ada@example.com");
  const platform = await platformId();
  const bob = await w.operator("bob@example.com");
  const cal = await w.operator("cal@example.com");
  const tia = await w.signIn("tia@example.com");
  const started = must(
    await w.auth.api.operator.impersonate({
      operator: bob,
      userId: tia.user.id,
      reason: "Ticket 1",
      ip: null,
      userAgent: null,
    }),
  );
  const support = must(
    await w.auth.api.createTeam({ user: ada.user, organizationId: platform, name: "Support" }),
  ).id;
  for (const op of [bob, cal])
    must(await w.auth.api.addTeamMember({ user: ada.user, teamId: support, userId: op.user.id }));
  const bobActive = await activate(w, bob, platform, support);
  const calActive = await activate(w, cal, platform, support);

  const pat = await w.signIn("pat@example.com");
  const oli = await w.signIn("oli@example.com");
  const acme = must(
    await w.auth.api.createOrganization({ user: ada.user, slug: "acme", name: "Acme" }),
  ).organization.id;
  must(
    await w.auth.api.addMember({
      user: ada.user,
      organizationId: acme,
      userId: pat.user.id,
      role: "member",
    }),
  );
  must(
    await w.auth.api.addMember({
      user: ada.user,
      organizationId: acme,
      userId: oli.user.id,
      role: "owner",
    }),
  );
  const core = must(
    await w.auth.api.createTeam({ user: ada.user, organizationId: acme, name: "Core" }),
  ).id;
  for (const s of [pat, oli])
    must(await w.auth.api.addTeamMember({ user: ada.user, teamId: core, userId: s.user.id }));
  const patActive = await activate(w, pat, acme, core);
  const oliActive = await activate(w, oli, acme, core);

  const oliCo = must(
    await w.auth.api.createOrganization({ user: oli.user, slug: "oli-co", name: "Oli Co" }),
  ).organization.id;
  const den = must(await w.auth.api.listTeams({ user: oli.user, organizationId: oliCo }))[0]?.id;
  if (den === undefined) throw new Error("no default team");
  const oliSecond = await w.signIn("oli@example.com");
  await activate(w, oliSecond, oliCo, den);

  return {
    ada,
    bob: bobActive,
    cal: calActive,
    tia,
    pat: patActive,
    oli: oliActive,
    platform,
    support,
    acme,
    core,
    oliCo,
    impersonation: started.token,
  };
}

type Scene = Awaited<ReturnType<typeof scene>>;

const reason = { reason: "Ticket 2", ip: null, userAgent: null } as const;

/** The kinds that each flow touches on the scene, so a flow that stops its writes fails here. */
const TOUCHED: Record<string, string[]> = {
  "a member removal": ["user", "session", "member", "team"],
  "a leave": ["user", "session", "member", "team"],
  "a member removal with revokeTokens": ["user", "session", "organization", "member", "team"],
  "an owner removal": ["user", "session", "organization", "member", "team"],
  "an operator removal with an impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team",
  ],
  "an operator removal with no impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team",
  ],
  "a role change": ["member"],
  "an owner demotion": ["organization", "member"],
  "a role change that drops the platform role": ["user", "organization", "member"],
  "a member add": ["user", "member"],
  "an organization create with its default team": ["user", "organization", "member", "team"],
  "an organization delete": ["session", "organization", "member", "team"],
  "a team create": ["organization", "team"],
  "a team delete": ["session", "team"],
  "a team member add": ["user", "team"],
  "a team member removal": ["session", "team"],
  "a team leave": ["session", "team"],
  "a set of the active team": ["session", "team"],
  "an invitation accept with a team": ["user", "member", "team"],
  "an organization token create": ["organization"],
  "a role create": ["organization"],
  "a ban": ["user", "session"],
  "a ban of an operator with an impersonation": ["user", "session"],
  "a platform role grant": ["user", "member"],
  "a platform role revoke with an impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team",
  ],
  "a platform role revoke with no impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team",
  ],
  "an admin create": ["user", "member"],
  "an account delete with a solo and a shared organization": [
    "user",
    "session",
    "organization",
    "member",
    "team",
  ],
  "an account delete of an operator with an impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team",
  ],
  "an impersonation start": ["user", "session"],
  "an impersonation stop": ["session"],
  "an end of the sessions of a user": ["user", "session"],
  "an end of all sessions": ["session"],
  "a sign-in": ["user", "session"],
};

/** Each flow of plans 12f and 12k that writes a kind of user-hold.ts, most of them two kinds or more. */
const FLOWS: Record<string, (w: World, s: Scene) => Promise<unknown>> = {
  "a member removal": (w, s) =>
    w.auth.api.removeMember({ user: s.ada.user, organizationId: s.acme, userId: s.pat.user.id }),
  "a leave": (w, s) =>
    w.auth.api.removeMember({ user: s.pat.user, organizationId: s.acme, userId: s.pat.user.id }),
  "a member removal with revokeTokens": (w, s) =>
    w.auth.api.removeMember({
      user: s.ada.user,
      organizationId: s.acme,
      userId: s.pat.user.id,
      revokeTokens: true,
    }),
  "an owner removal": (w, s) =>
    w.auth.api.removeMember({ user: s.ada.user, organizationId: s.acme, userId: s.oli.user.id }),
  "an operator removal with an impersonation": (w, s) =>
    w.auth.api.removeMember({
      user: s.ada.user,
      organizationId: s.platform,
      userId: s.bob.user.id,
    }),
  "an operator removal with no impersonation": (w, s) =>
    w.auth.api.removeMember({
      user: s.ada.user,
      organizationId: s.platform,
      userId: s.cal.user.id,
    }),
  "a role change": (w, s) =>
    w.auth.api.updateMemberRole({
      user: s.ada.user,
      organizationId: s.acme,
      userId: s.pat.user.id,
      role: "admin",
    }),
  "an owner demotion": (w, s) =>
    w.auth.api.updateMemberRole({
      user: s.ada.user,
      organizationId: s.acme,
      userId: s.oli.user.id,
      role: "member",
    }),
  "a role change that drops the platform role": (w, s) =>
    w.auth.api.updateMemberRole({
      user: s.ada.user,
      organizationId: s.platform,
      userId: s.cal.user.id,
      role: "member",
    }),
  "a member add": (w, s) =>
    w.auth.api.addMember({
      user: s.ada.user,
      organizationId: s.acme,
      userId: s.tia.user.id,
      role: "member",
    }),
  "an organization create with its default team": (w, s) =>
    w.auth.api.createOrganization({ user: s.pat.user, slug: "pat-co", name: "Pat Co" }),
  "an organization delete": (w, s) =>
    w.auth.api.deleteOrganization({ user: s.ada.user, organizationId: s.acme }),
  "a team create": (w, s) =>
    w.auth.api.createTeam({ user: s.ada.user, organizationId: s.acme, name: "Web" }),
  "a team delete": (w, s) => w.auth.api.deleteTeam({ user: s.ada.user, teamId: s.core }),
  "a team member add": (w, s) =>
    w.auth.api.addTeamMember({ user: s.ada.user, teamId: s.core, userId: s.ada.user.id }),
  "a team member removal": (w, s) =>
    w.auth.api.removeTeamMember({ user: s.ada.user, teamId: s.core, userId: s.pat.user.id }),
  "a team leave": (w, s) =>
    w.auth.api.removeTeamMember({ user: s.pat.user, teamId: s.core, userId: s.pat.user.id }),
  "a set of the active team": (w, s) =>
    w.auth.api.setActiveTeam({ session: s.pat, teamId: s.core }),
  "an invitation accept with a team": async (w, s) => {
    must(
      await w.auth.api.inviteMember({
        user: s.ada.user,
        organizationId: s.acme,
        email: "tia@example.com",
        role: "member",
        teamIds: [s.core],
      }),
    );
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(w.lastMail("tia@example.com"))?.[1];
    if (token === undefined) throw new Error("no invitation");
    return w.auth.api.acceptInvitation({ user: s.tia.user, token, ip: null });
  },
  "an organization token create": (w, s) =>
    w.auth.api.organizationTokens.create({
      user: s.ada.user,
      organizationId: s.acme,
      name: "ci",
      permissions: {},
    }),
  "a role create": (w, s) =>
    w.auth.api.createRole({
      user: s.ada.user,
      organizationId: s.acme,
      name: "web",
      permissions: { member: ["read"] },
    }),
  "a ban": (w, s) =>
    w.auth.api.operator.users.ban({ actor: APP, userId: s.pat.user.id, ...reason }),
  "a ban of an operator with an impersonation": (w, s) =>
    w.auth.api.operator.users.ban({ actor: APP, userId: s.bob.user.id, ...reason }),
  "a platform role grant": (w, s) =>
    w.auth.api.operator.platformRole.grant({ actor: APP, userId: s.pat.user.id, ...reason }),
  "a platform role revoke with an impersonation": (w, s) =>
    w.auth.api.operator.platformRole.revoke({ actor: APP, userId: s.bob.user.id, ...reason }),
  "a platform role revoke with no impersonation": (w, s) =>
    w.auth.api.operator.platformRole.revoke({ actor: APP, userId: s.cal.user.id, ...reason }),
  "an admin create": (w) =>
    w.auth.api.operator.createAdmin({ actor: APP, email: "new@example.com", ...reason }),
  "an account delete with a solo and a shared organization": (w, s) =>
    w.auth.api.user.delete({ session: s.oli, ip: null, userAgent: null }),
  "an account delete of an operator with an impersonation": (w, s) =>
    w.auth.api.user.delete({ session: s.bob, ip: null, userAgent: null }),
  "an impersonation start": (w, s) =>
    w.auth.api.operator.impersonate({ operator: s.ada, userId: s.pat.user.id, ...reason }),
  "an impersonation stop": async (w, s) =>
    w.auth.api.operator.stopImpersonating({
      session: await w.sessionOf(s.impersonation),
      ip: null,
      userAgent: null,
    }),
  "an end of the sessions of a user": (w, s) =>
    w.auth.api.operator.sessions.endUser({ actor: APP, userId: s.pat.user.id, ...reason }),
  "an end of all sessions": (w) => w.auth.api.operator.sessions.endAll({ actor: APP, ...reason }),
  "a sign-in": async (w) => ({ ok: true, value: await w.signIn("pat@example.com") }),
};

describe("the lock order of user-hold.ts in each flow (ruling 49 of plan 12k)", () => {
  for (const [name, call] of Object.entries(FLOWS))
    it(`${name} takes the kinds in the order user, session, organization, member, team`, async () => {
      const w = world();
      const s = await scene(w);
      const answer = await w.flow(name, () => call(w, s));
      expect(answer).toMatchObject({ ok: true });
      // The flow ran its writes, so the check below is not empty.
      expect(w.kindsOf(name)).toEqual(TOUCHED[name]);
      expect(w.outOfOrder(name), JSON.stringify(w.stepsOf(name))).toEqual([]);
    }, 60_000);

  it("a team delete with keepLastTeam takes the kinds in the order of user-hold.ts", async () => {
    const w = world({ keepLastTeam: true });
    const s = await scene(w);
    const name = "a team delete with keepLastTeam";
    expect(
      await w.flow(name, () => w.auth.api.deleteTeam({ user: s.ada.user, teamId: s.core })),
    ).toMatchObject({ ok: true });
    expect(w.kindsOf(name)).toEqual(["session", "organization", "team"]);
    expect(w.outOfOrder(name), JSON.stringify(w.stepsOf(name))).toEqual([]);
  }, 60_000);

  it("names each step out of order, and lets a kind come again", async () => {
    const w = world();
    const name = "a probe out of order";
    const none = { field: "id", op: "eq", value: "none" } as const;
    await w.flow(name, () =>
      w.storage.transaction(async (tx) => {
        await tx.update("organization", [none], { name: "x" });
        await tx.delete("member", [none]);
        await tx.update("organization", [none], { name: "y" });
        await tx.update("user", [none], { name: null });
        await tx.lockInOrder?.("session", [none]);
        await tx.delete("teamMember", [none]);
      }),
    );
    expect(w.kindsOf(name)).toEqual(["user", "session", "organization", "member", "team"]);
    expect(w.outOfOrder(name)).toEqual([
      "transaction 1: update user after delete member",
      "transaction 1: lock session after delete member",
    ]);
  });
});
