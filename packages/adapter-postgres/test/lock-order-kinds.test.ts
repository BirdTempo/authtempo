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

// The machine check of the one lock order of user-hold.ts (rulings 49, 50,
// and 51 of plan 12k). The order has ten kinds of rows. They are the
// scimGroup row, the user row, the session rows, the scimUser rows, the
// organization row, the team row, the invitation rows, the member rows, the
// scimGroupMember rows, and the team member rows (ruling 59 M1 and ruling 74
// M3 of plan 12d). A storage wrapper records
// each create, update, delete, and lock read of these kinds in each
// transaction, in order. Each test runs one flow that writes these kinds,
// most of them two kinds or more. A kind may come again, but a kind never
// comes first after a later kind. Each state comes from the flows: the
// routes, the magic link, the organization api, and the operator api.
//
// A source scan finds each site of the engine that opens a transaction.
// SITES pins each site to its flows in FLOWS, or to a reason. A new site
// with no entry fails the scan. Each flow test compares the sites that the
// flow opens with SITES.
//
// The check sees kinds, not row sets. All rows of one kind count as one
// step. So a flow that locks some rows of a kind, and later writes other
// rows of that kind, passes here. Two race tests cover the known row-set
// gaps: team-delete-gap-race.test.ts and organization-delete-gap-race.test.ts.

const API = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const PASSWORD = "correct horse battery";
/** Every request passes: the order, not the limit, is under test. */
const OPEN = { allow: async () => true };

/**
 * The kinds of user-hold.ts, in the lock order. The team row comes before
 * the member rows. The organization delete deletes the team rows first. An
 * accept that raises a member takes `lockTeam` before its member update. No
 * flow takes a member row and then a team row. The invitation rows come
 * between (ruling 50). The accept consumes its invitation after `lockTeam`
 * and before its member write. The organization delete deletes the
 * invitations after the team rows and before the member rows. A SCIM group
 * write takes its scimGroup row first. The scimGroupMember rows come after
 * the member rows: a SCIM group remove and a SCIM User delete of one person
 * took them in the two orders and formed a deadlock (ruling 59 M1 of plan
 * 12d). The scimUser rows come before the organization row: a SCIM
 * deactivate and an organization delete took them in the two orders and
 * formed a deadlock (ruling 74 M3 of plan 12d).
 */
const KINDS = [
  "SCIM group",
  "user",
  "session",
  "SCIM user",
  "organization",
  "team",
  "invitation",
  "member",
  "SCIM group member",
  "team member",
] as const;
const KIND_OF = {
  scimGroup: 0,
  user: 1,
  session: 2,
  scimUser: 3,
  organization: 4,
  team: 5,
  invitation: 6,
  member: 7,
  scimGroupMember: 8,
  teamMember: 9,
} as const;
const kindOf = (model: ModelName): number | undefined =>
  (KIND_OF as Partial<Record<ModelName, number>>)[model];

// The package has no @types/node, so type the two calls of node:fs that
// this file makes, as db.ts does for its one global.
const FS: string = "node:fs";
const { readdirSync, readFileSync } = (await import(FS)) as {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
};
/** The stack limit of V8, which the types of the package lack. */
const V8 = Error as unknown as { stackTraceLimit: number };
const CORE = decodeURIComponent(new URL("../../core/", import.meta.url).pathname);
/** A call that opens a transaction: `.transaction(`, or `operatorAct(`, the one door of the operator acts. */
const OPENS = /\.transaction\(|(?<![\w.])(?<!function )operatorAct\(/g;
/** The site of `operatorAct` itself. Each call of it is a site of its own. */
const DOOR = "operator/audit operatorAct";

/** A site that opens a transaction: its file, its top-level function, and its line. */
interface Site {
  key: string;
  file: string;
  line: number;
}

/**
 * The folders of the engine that hold flows: the operator folder of plan
 * 12f, and the SSO and SCIM folders of plan 12d. hook-locks.test.ts of the
 * site scans the same folders.
 */
const SUBFOLDERS = ["operator", "sso", "scim"] as const;

/**
 * The sites of the engine folder of core and of its SUBFOLDERS, by file and
 * top-level function. The scan has the form of hook-locks.test.ts of the
 * site. `root` is `src` for the source, or `dist` for the build that the
 * test runs. A function with two sites names the second one `#2`.
 */
function sitesIn(root: "src" | "dist"): Site[] {
  const ext = root === "src" ? ".ts" : ".js";
  const dir = `${CORE}${root}/engine/`;
  const code = (n: string): boolean => n.endsWith(ext) && !n.endsWith(".d.ts");
  const files = [
    ...readdirSync(dir).filter(code),
    ...SUBFOLDERS.flatMap((d) =>
      readdirSync(`${dir}${d}/`)
        .filter(code)
        .map((n) => `${d}/${n}`),
    ),
  ];
  const out: Site[] = [];
  for (const f of files) {
    const file = f.slice(0, -ext.length);
    let line = 1;
    for (const text of readFileSync(`${dir}${f}`, "utf8").split(
      /\n(?=(?:export )?(?:async )?function )/,
    )) {
      const name = /^(?:export )?(?:async )?function (\w+)/.exec(text)?.[1] ?? "(top)";
      let n = 0;
      for (const m of text.matchAll(OPENS)) {
        n++;
        const at = line + text.slice(0, m.index).split("\n").length - 1;
        out.push({ key: `${file} ${name}${n > 1 ? ` #${n}` : ""}`, file, line: at });
      }
      line += text.split("\n").length;
    }
  }
  return out;
}

const SITE_CACHE: Partial<Record<"src" | "dist", Site[]>> = {};
const sites = (root: "src" | "dist"): Site[] => (SITE_CACHE[root] ??= sitesIn(root));

/**
 * The site of the engine that opens a transaction at this moment, from the
 * stack: the first frame at a site. The scan skips the site in
 * `operatorAct`: the call of `operatorAct` further down the stack is the
 * site. The frames name the build or, through its source map, the source.
 */
function siteHere(): string {
  const limit = V8.stackTraceLimit;
  V8.stackTraceLimit = 100;
  const stack = new Error().stack ?? "";
  V8.stackTraceLimit = limit;
  for (const m of stack.matchAll(/\/core\/(src|dist)\/engine\/([\w/-]+)\.[jt]s:(\d+):\d+/g)) {
    const site = sites(m[1] as "src" | "dist").find(
      (s) => s.file === m[2] && s.line === Number(m[3]),
    );
    if (site && site.key !== DOOR) return site.key;
  }
  return "no site of the engine";
}

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
  // The fake DNS and the fake IdP of the SSO sign-in (plan 12d Task 5). The
  // token endpoint answers the code as the ID token, and the jwt seam knows
  // the tokens of `idTokens`.
  const txt: Record<string, string[]> = {};
  const idTokens: Record<string, Record<string, unknown>> = {};
  const dns = (name: string) => ({ name, txt: async (asked: string) => txt[asked] ?? [] });
  let current: string | null = null;
  const runs: { flow: string; steps: Step[] }[] = [];
  /** The engine site of each transaction that a flow opens, nested ones too. */
  const opened: { flow: string; site: string }[] = [];
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
    // The rows of a group or team write go in by createMany (ruling 57 of plan 12d).
    createMany: ((model: ModelName, rows: never) => {
      note(steps, model, "create");
      return tx.createMany(model, rows);
    }) as typeof tx.createMany,
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
    transaction: ((fn: (inner: StorageAdapter) => Promise<unknown>) => {
      if (current !== null) opened.push({ flow: current, site: siteHere() });
      return tx.transaction((inner) => fn(wrap(inner, steps)));
    }) as typeof tx.transaction,
  });
  const storage: StorageAdapter = {
    ...adapter,
    transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) => {
      // At the call, while the stack still holds the site of the engine.
      if (current !== null) opened.push({ flow: current, site: siteHere() });
      return adapter.transaction((tx) => {
        const steps: Step[] = [];
        if (current !== null) runs.push({ flow: current, steps });
        return fn(wrap(tx, steps));
      });
    }) as typeof adapter.transaction,
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
    sso: {
      oidc: true,
      dns: [dns("a"), dns("b")],
      fetch: async (_url, init) => {
        const code = new URLSearchParams(typeof init?.body === "string" ? init.body : "").get(
          "code",
        );
        return Response.json({ id_token: code, token_type: "Bearer" });
      },
    },
    // Plan 12d Task 10: the SCIM Users of Acme. Task 11: each Group has a team and a role.
    scim: { groups: "both" },
    // Plan 12i Task 6: the anonymous sign-in and its delete.
    anonymous: { isolateLimiter: "allow" },
    jwt: {
      verifyIdToken: async (input) => {
        const claims = idTokens[input.token];
        if (!claims) throw new Error("fake jwt: verify failed");
        return claims;
      },
      signES256: async () => "es256",
    },
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
   * flows see. So its kind never comes first after a later kind. A kind
   * that came before may come again: its rows are held from the first time.
   *
   * A create takes the lock of its new row only, and no other flow sees
   * that row before the commit. The one wait it can meet is a parallel
   * insert of the same unique key. So the order skips a create, and a
   * second rule holds instead. A create of a member or team member row
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
  /** The engine sites that the transactions of `name` opened, sorted, each once. */
  function sitesOf(name: string): string[] {
    return [...new Set(opened.filter((o) => o.flow === name).map((o) => o.site))].sort();
  }
  /** The steps of each transaction of `name`, for a failure message. */
  function stepsOf(name: string): string[][] {
    return runs.filter((r) => r.flow === name).map((r) => r.steps.map((x) => x.text));
  }
  return {
    auth,
    storage,
    txt,
    idTokens,
    signIn,
    sessionOf,
    operator,
    flow,
    kindsOf,
    outOfOrder,
    sitesOf,
    stepsOf,
    lastMail,
    lastToken,
    post,
  };
}

type World = ReturnType<typeof world>;
type Signed = Awaited<ReturnType<World["signIn"]>>;

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** Uma's user id. */
async function umaId(_w: World): Promise<string> {
  const rows = await db.sql<{ id: string }[]>`
    SELECT id FROM ta_user WHERE email = 'uma@example.org'`;
  return rows[0]?.id ?? "";
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
 *   are in the team Core, and their sessions act in it. A pending
 *   invitation of Vic names Core.
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
  // A pending invitation that names Core: the team delete and the organization delete write it.
  must(
    await w.auth.api.inviteMember({
      user: ada.user,
      organizationId: acme,
      email: "vic@example.com",
      role: "member",
      teamIds: [core],
    }),
  );

  const oliCo = must(
    await w.auth.api.createOrganization({ user: oli.user, slug: "oli-co", name: "Oli Co" }),
  ).organization.id;
  const den = must(await w.auth.api.listTeams({ user: oli.user, organizationId: oliCo }))[0]?.id;
  if (den === undefined) throw new Error("no default team");
  const oliSecond = await w.signIn("oli@example.com");
  await activate(w, oliSecond, oliCo, den);

  // Plan 12d Task 5: Acme proves example.org and adds an OIDC connection. Uma
  // signs up at that domain by password and does not verify the address.
  const sso = w.auth.api.sso;
  if (!sso) throw new Error("no sso api");
  const domain = must(
    await sso.domains.add({ actor: APP, organizationId: acme, domain: "example.org" }),
  );
  if (domain.record === null) throw new Error("no domain record");
  w.txt[domain.record.name] = [domain.record.value];
  must(await sso.domains.verify({ actor: APP, id: domain.id }));
  const connection = must(
    await sso.connections.create({
      actor: APP,
      organizationId: acme,
      kind: "oidc",
      label: "Acme IdP",
      issuer: "https://login.acme-idp.example",
      clientId: "acme-client",
      clientSecret: "acme-secret-0123456789",
      endpoints: {
        authorizeUrl: "https://login.acme-idp.example/authorize",
        tokenUrl: "https://login.acme-idp.example/token",
        jwksUrl: "https://login.acme-idp.example/keys",
      },
    }),
  ).id;
  must(
    await passwordApi(w).signUp({
      email: "uma@example.org",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    }),
  );

  const scim = w.auth.api.scim;
  if (!scim) throw new Error("no scim api");
  // The role map of plan 12d Task 11: a member of the group Directory gets admin.
  must(await scim.setRoleMap({ actor: APP, organizationId: acme, map: { Directory: "admin" } }));
  const scimToken = must(
    await scim.tokens.create({ actor: APP, organizationId: acme, name: "directory" }),
  ).token;
  // Plan 12i Task 6: an anonymous session for the anonymous delete.
  const anonymousApi = w.auth.api.anonymous;
  if (!anonymousApi) throw new Error("no anonymous api");
  const anonymousIn = must(await anonymousApi.signIn({ current: null, ip: null, userAgent: null }));
  const anonymous = await w.auth.api.getSession(anonymousIn.token);
  if (!anonymous) throw new Error("no anonymous session");

  return {
    anonymous,
    scimToken,
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
    connection,
    impersonation: started.token,
  };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** The anonymous api of the world (plan 12i Task 6). */
function anonymousOf(w: World) {
  const api = w.auth.api.anonymous;
  if (!api) throw new Error("no anonymous api");
  return api;
}

const reason = { reason: "Ticket 2", ip: null, userAgent: null } as const;

/** The kinds of a SCIM group flow of plan 12d Task 11, with the create of its group. */
const GROUP_KINDS = [
  "SCIM group",
  "user",
  "session",
  "SCIM user",
  "organization",
  "team",
  "member",
  "SCIM group member",
  "team member",
];

/** The kinds that each flow touches on the scene, so a flow that stops its writes fails here. */
const TOUCHED: Record<string, string[]> = {
  "an anonymous sign-in": ["user", "session"],
  "an anonymous delete": ["user", "session"],
  "an anonymous upgrade by an email claim": ["user", "session"],
  "a member removal": ["user", "session", "member", "team member"],
  "a leave": ["user", "session", "member", "team member"],
  "a member removal with revokeTokens": [
    "user",
    "session",
    "organization",
    "member",
    "team member",
  ],
  "an owner removal": ["user", "session", "organization", "member", "team member"],
  "an operator removal with an impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team member",
  ],
  "an operator removal with no impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team member",
  ],
  "a role change": ["member"],
  "an owner demotion": ["organization", "member"],
  "a role change that drops the platform role": ["user", "session", "organization", "member"],
  "a member add": ["user", "member"],
  "an organization create with its default team": [
    "user",
    "organization",
    "team",
    "member",
    "team member",
  ],
  // Ruling 74 of plan 12d: the lock of the scimGroup rows first, and of the scimUser rows
  // before the organization row.
  "an organization delete": [
    "SCIM group",
    "session",
    "SCIM user",
    "organization",
    "team",
    "invitation",
    "member",
    "team member",
  ],
  "a team create": ["organization", "team"],
  "a team delete": ["session", "team", "invitation", "team member"],
  "a team member add": ["user", "team", "team member"],
  "a team member removal": ["session", "team", "team member"],
  "a team leave": ["session", "team", "team member"],
  "a set of the active team": ["session", "team"],
  "a set of the active organization": ["session", "organization"],
  "an invitation accept with a team": ["user", "team", "invitation", "member", "team member"],
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
    "team member",
  ],
  "a platform role revoke with no impersonation": [
    "user",
    "session",
    "organization",
    "member",
    "team member",
  ],
  "an admin create": ["user", "member"],
  // Plan 12f2 Task 2: the new user row with its identity, then the audit row.
  "an operator create": ["user"],
  // Plan 12f2 Task 3: the create, then the confirm holds the user row, claims it, and opens a session.
  "an invitation confirm": ["user", "session"],
  // Ruling 78 of plan 12d: the sweep takes the team rows of a solo organization.
  "an account delete with a solo and a shared organization": [
    "user",
    "session",
    "SCIM user",
    "organization",
    "invitation",
    "member",
    "team member",
  ],
  "an account delete of an operator with an impersonation": [
    "user",
    "session",
    "SCIM user",
    "organization",
    "invitation",
    "member",
    "team member",
  ],
  // Plan 12d ruling 30: the create of a second solo organization, then the set-based delete.
  // The team kind comes from the create: its default team (ruling 78 of plan 12d).
  "an account delete with two solo organizations": [
    "user",
    "session",
    "SCIM user",
    "organization",
    "team",
    "invitation",
    "member",
    "team member",
  ],
  // Plan 12f2 Task 4. On main the solo organization goes set-based, and its teams go at
  // the sweep (ruling 78 of plan 12d).
  "an operator delete with a solo and a shared organization": [
    "user",
    "session",
    "SCIM user",
    "organization",
    "invitation",
    "member",
    "team member",
  ],
  "an impersonation start": ["user", "session"],
  "an impersonation stop": ["session"],
  "an end of the sessions of a user": ["user", "session"],
  "an end of all sessions": ["session"],
  "a sign-in": ["user", "session"],
  "an invitation accept that raises a member": ["user", "team", "invitation", "member"],
  "a password set": ["user", "session"],
  "a password change": ["user", "session"],
  "a password reset": ["user", "session"],
  "an email claim by a magic link": ["user", "session"],
  "an email claim by the sign-up link": ["user", "session"],
  "a second factor enable": ["user", "session"],
  "an email change": ["user", "session"],
  // Plan 12d Task 5: the claim of Uma, then her member row of Acme, then her session.
  "an SSO sign-in that claims a user": ["user", "session", "member"],
  // Plan 12d Task 10: the SCIM create claims Uma and adds her member row.
  "a SCIM create that claims a user": ["user", "session", "SCIM user", "member"],
  "a SCIM update": ["user", "session", "SCIM user", "member"],
  // The team member add of the setup takes the team row.
  "a SCIM deactivate": [
    "user",
    "session",
    "SCIM user",
    "organization",
    "team",
    "member",
    "team member",
  ],
  "a SCIM reactivate": ["user", "session", "SCIM user", "organization", "member", "team member"],
  // The member row lock, then the scimGroupMember rows, then the member delete (ruling 59 M1).
  "a SCIM delete": [
    "user",
    "session",
    "SCIM user",
    "organization",
    "member",
    "SCIM group member",
    "team member",
  ],
  // Plan 12d Task 11: each group flow first creates the group of Uma in the flow, so the
  // kinds of the create (the claim, the team create, the role) show in each of them.
  "a SCIM group create": GROUP_KINDS,
  "a SCIM group member removal": GROUP_KINDS,
  "a SCIM group member add": GROUP_KINDS,
  "a SCIM group rename": GROUP_KINDS,
  "a SCIM group delete": GROUP_KINDS,
};

/** One SCIM request of Acme's directory, and its answer as a Result. */
async function scimCall(w: World, s: Scene, method: string, path: string, body?: unknown) {
  const res = await w.auth.handle(
    new Request(`${API}/auth/scim/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${s.scimToken}`,
        ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return res.ok
    ? {
        ok: true as const,
        value:
          text === "" ? null : (JSON.parse(text) as { id: string; members?: { value: string }[] }),
      }
    : { ok: false as const, code: `${res.status} ${text}` };
}

/** Uma's SCIM User, made by Acme's directory: the claim of her unverified sign-up. */
async function scimUma(w: World, s: Scene) {
  return scimCall(w, s, "POST", "/Users", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "uma@example.org",
  });
}

/**
 * The Group `Directory` of Acme with Uma in it (plan 12d Task 11): its id.
 * The role map of the scene gives Uma admin, and she joins the team of the
 * group.
 */
async function scimDirectory(w: World, s: Scene): Promise<string> {
  const uma = must(await scimUma(w, s))?.id ?? "";
  return (
    must(
      await scimCall(w, s, "POST", "/Groups", {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Directory",
        members: [{ value: uma }],
      }),
    )?.id ?? ""
  );
}

/** A PatchOp body of one operation. */
const scimPatch = (op: Record<string, unknown>) => ({
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  Operations: [op],
});

/** Each flow of plans 12f and 12k that writes a kind of user-hold.ts, most of them two kinds or more. */
const FLOWS: Record<string, (w: World, s: Scene) => Promise<unknown>> = {
  // Plan 12i Task 6: the anonymous sign-in writes the user row, then the session row.
  "an anonymous sign-in": (w) =>
    anonymousOf(w).signIn({ current: null, ip: null, userAgent: null }),
  // The anonymous delete locks the user row, then ends the sessions.
  "an anonymous delete": (w, s) => anonymousOf(w).delete({ session: s.anonymous }),
  // Plan 12i Task 7: the claim of an unverified user writes its user row. Then the
  // upgrade claims the anonymous sessions, right before the session write. After the
  // commit, the anonymous sessions end, and the anonymous user goes.
  "an anonymous upgrade by an email claim": async (w, s) => {
    must(
      await passwordApi(w).signUp({
        email: "una@example.com",
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    );
    await w.auth.api.requestMagicLink({
      email: "una@example.com",
      ip: null,
      anonymous: s.anonymous,
    });
    return w.auth.api.verifyMagicLink({
      token: w.lastToken("una@example.com"),
      ip: null,
      userAgent: null,
      anonymous: s.anonymous,
    });
  },
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
  "a set of the active organization": (w, s) =>
    w.auth.api.setActiveOrganization({ session: s.oli, organizationId: s.oliCo }),
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
  "an operator create": (w) =>
    w.auth.api.operator.users.create({
      actor: APP,
      email: "made@example.com",
      emailVerified: true,
      firstSignIn: "none",
      ...reason,
    }),
  "an invitation confirm": async (w) => {
    must(
      await w.auth.api.operator.users.create({ actor: APP, email: "ivy@example.com", ...reason }),
    );
    const res = await w.post("/user/invite/confirm", { token: w.lastToken("ivy@example.com") }, "");
    const body = (await res.json()) as { error?: string };
    return res.ok ? { ok: true as const, value: body } : { ok: false as const, code: body.error };
  },
  "an account delete with a solo and a shared organization": (w, s) =>
    w.auth.api.user.delete({ session: s.oli, ip: null, userAgent: null }),
  "an account delete of an operator with an impersonation": (w, s) =>
    w.auth.api.user.delete({ session: s.bob, ip: null, userAgent: null }),
  // Oli holds one solo organization in the scene. A second one makes the delete set-based
  // over two ids (ruling 30 of plan 12d), with its organization lock in id order.
  "an account delete with two solo organizations": async (w, s) => {
    const made = await w.auth.api.createOrganization({
      user: s.oli.user,
      slug: "oli-two",
      name: "Oli Two",
    });
    if (!made.ok) throw new Error(made.code);
    return w.auth.api.user.delete({ session: s.oli, ip: null, userAgent: null });
  },
  "an operator delete with a solo and a shared organization": (w, s) =>
    w.auth.api.operator.users.delete({ actor: APP, userId: s.oli.user.id, ...reason }),
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
  "an SSO sign-in that claims a user": async (w, s) => {
    const started = await w.auth.handle(new Request(`${API}/auth/sso/${s.connection}/start`));
    const url = new URL(started.headers.get("location") ?? "");
    const bind = started.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
      ?.split(";")[0];
    w.idTokens["code-uma"] = {
      sub: "uma-1",
      email: "uma@example.org",
      nonce: url.searchParams.get("nonce") ?? "",
    };
    const q = new URLSearchParams({ code: "code-uma", state: url.searchParams.get("state") ?? "" });
    const res = await w.auth.handle(
      new Request(`${API}/auth/sso/${s.connection}/callback?${q}`, {
        headers: { cookie: bind ?? "" },
      }),
    );
    const error = new URL(res.headers.get("location") ?? "", API).searchParams.get("auth_error");
    return error === null ? { ok: true, value: res.status } : { ok: false, code: error };
  },
  "a SCIM create that claims a user": (w, s) => scimUma(w, s),
  "a SCIM update": async (w, s) => {
    const id = must(await scimUma(w, s))?.id ?? "";
    return scimCall(
      w,
      s,
      "PATCH",
      `/Users/${id}`,
      scimPatch({ op: "replace", path: "displayName", value: "Uma" }),
    );
  },
  "a SCIM deactivate": async (w, s) => {
    const id = must(await scimUma(w, s))?.id ?? "";
    // Uma joins the team Core, so the deactivate deletes her team member row.
    must(
      await w.auth.api.addTeamMember({ user: s.ada.user, teamId: s.core, userId: await umaId(w) }),
    );
    return scimCall(
      w,
      s,
      "PATCH",
      `/Users/${id}`,
      scimPatch({ op: "replace", path: "active", value: false }),
    );
  },
  "a SCIM reactivate": async (w, s) => {
    const id = must(await scimUma(w, s))?.id ?? "";
    must(
      await scimCall(
        w,
        s,
        "PATCH",
        `/Users/${id}`,
        scimPatch({ op: "replace", path: "active", value: false }),
      ),
    );
    return scimCall(
      w,
      s,
      "PATCH",
      `/Users/${id}`,
      scimPatch({ op: "replace", path: "active", value: true }),
    );
  },
  "a SCIM delete": async (w, s) => {
    const id = must(await scimUma(w, s))?.id ?? "";
    return scimCall(w, s, "DELETE", `/Users/${id}`);
  },
  // Plan 12d Task 11: the group writes take the group row, hold the users whose role or
  // team they change, then the organization or the team row, then the member rows of the
  // role recompute, then the scimGroupMember rows, then the team member rows.
  "a SCIM group create": (w, s) => scimDirectory(w, s).then((id) => ({ ok: id !== "" })),
  "a SCIM group member removal": async (w, s) => {
    const id = await scimDirectory(w, s);
    const uma = must(await scimCall(w, s, "GET", `/Groups/${id}`))?.members?.[0]?.value;
    return scimCall(
      w,
      s,
      "PATCH",
      `/Groups/${id}`,
      scimPatch({ op: "remove", path: `members[value eq "${uma}"]` }),
    );
  },
  "a SCIM group member add": async (w, s) => {
    const id = await scimDirectory(w, s);
    const uma = must(await scimCall(w, s, "GET", `/Groups/${id}`))?.members?.[0]?.value;
    must(
      await scimCall(
        w,
        s,
        "PATCH",
        `/Groups/${id}`,
        scimPatch({ op: "remove", path: `members[value eq "${uma}"]` }),
      ),
    );
    return scimCall(
      w,
      s,
      "PATCH",
      `/Groups/${id}`,
      scimPatch({ op: "add", path: "members", value: [{ value: uma }] }),
    );
  },
  "a SCIM group rename": async (w, s) => {
    const id = await scimDirectory(w, s);
    return scimCall(
      w,
      s,
      "PATCH",
      `/Groups/${id}`,
      scimPatch({ op: "replace", path: "displayName", value: "Former" }),
    );
  },
  "a SCIM group delete": async (w, s) => {
    const id = await scimDirectory(w, s);
    return scimCall(w, s, "DELETE", `/Groups/${id}`);
  },
  "an invitation accept that raises a member": async (w, s) => {
    must(
      await w.auth.api.inviteMember({
        user: s.ada.user,
        organizationId: s.acme,
        email: "pat@example.com",
        role: "admin",
        teamIds: [s.core],
      }),
    );
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(w.lastMail("pat@example.com"))?.[1];
    if (token === undefined) throw new Error("no invitation");
    return w.auth.api.acceptInvitation({ user: s.pat.user, token, ip: null });
  },
  "a password set": (w, s) =>
    passwordApi(w).change({ session: s.pat, newPassword: PASSWORD, ip: null, userAgent: null }),
  "a password change": (w, s) =>
    passwordApi(w).change({
      session: s.ada,
      currentPassword: PASSWORD,
      newPassword: "another horse battery",
      ip: null,
      userAgent: null,
    }),
  "a password reset": async (w) => {
    must(await passwordApi(w).requestReset({ email: "pat@example.com", ip: null }));
    return passwordApi(w).reset({
      token: w.lastToken("pat@example.com"),
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
  },
  "an email claim by a magic link": async (w) => {
    must(
      await passwordApi(w).signUp({
        email: "una@example.com",
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    );
    return { ok: true, value: await w.signIn("una@example.com") };
  },
  "an email claim by the sign-up link": async (w) => {
    must(
      await passwordApi(w).signUp({
        email: "una@example.com",
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    );
    return passwordApi(w).verifyEmail({
      token: w.lastToken("una@example.com"),
      ip: null,
      userAgent: null,
    });
  },
  "a second factor enable": async (w, s) => {
    const cookie = `__Host-tempo_session=${s.pat.token}`;
    expect((await w.post("/password/change", { newPassword: PASSWORD }, cookie)).status).toBe(200);
    const setup = await w.post("/totp/setup", { password: PASSWORD }, cookie);
    const { secret } = (await setup.json()) as { secret: string };
    const code = await totpCode(base32Decode(secret), new Date());
    const enabled = await w.post("/totp/enable", { code }, cookie);
    return enabled.status === 200 ? { ok: true } : { ok: false, code: `${enabled.status}` };
  },
  "an email change": async (w, s) => {
    must(await w.auth.api.user.changeEmail({ session: s.pat, newEmail: "pat2@example.com" }));
    return w.auth.api.user.confirmEmailChange({
      token: w.lastToken("pat2@example.com"),
      ip: null,
      userAgent: null,
    });
  },
};

/** The password api, which `createAuth` gives with `password` set. */
function passwordApi(w: World) {
  const api = w.auth.api.password;
  if (!api) throw new Error("no password api");
  return api;
}

/**
 * Each site of the engine that opens a transaction, by file and top-level
 * function. Its entry names the flows above that run it, or the reason it
 * needs no flow.
 * A site with a flow writes two kinds or more. Each test of a flow checks
 * that the flow opens these sites and no others. A reason says which kinds
 * the site writes. "One kind" and "no kind" sites cannot take two kinds
 * out of order. A sign-in site holds the user in `openSession` and then
 * creates the session, as "a sign-in" does. Its only other write is a
 * delete of its own new session, or a step on its own new user row.
 */
const SITES: Record<string, readonly string[] | string> = {
  "account-delete requestAccountDelete": "one kind: the user hold, then verification rows",
  "account-delete runDelete": [
    "an account delete with a solo and a shared organization",
    "an account delete of an operator with an impersonation",
    "an account delete with two solo organizations",
  ],
  "email-change applyChange": ["an email change"],
  "handoff continueHandoff": "one kind: an update of the browser session, then a verification row",
  "handoff redeemHandoff": "a sign-in by a handoff code",
  "identities guardedRemove": "one kind: the compare-and-set of the user row, then identity rows",
  "invitations inviteMember": [
    "an invitation accept with a team",
    "an invitation accept that raises a member",
  ],
  "invitations acceptInvitation": [
    "an invitation accept with a team",
    "an invitation accept that raises a member",
  ],
  "invitations setActiveOrganization": ["a set of the active organization"],
  "oauth-client-store deleteClient": "no kind: oauth rows only",
  "oauth-clients refreshCimdRow": "no kind: oauth rows only",
  "oauth-grants revokeGrant": "no kind: oauth rows only",
  "organization-tokens createOrganizationToken": ["an organization token create"],
  "organizations ownerWrite": [
    "an owner removal",
    "an operator removal with an impersonation",
    "an operator removal with no impersonation",
    "an owner demotion",
    "a role change that drops the platform role",
  ],
  "organizations createOrganization": [
    "an organization create with its default team",
    "an account delete with two solo organizations",
  ],
  "organizations updateOrganization": "one kind: the organization row",
  "organizations deleteOrganization": ["an organization delete"],
  "organizations addMember": ["a member add"],
  "organizations updateMemberRole": ["a role change"],
  "organizations removeMember": [
    "a member removal",
    "a leave",
    "a member removal with revokeTokens",
  ],
  "passkeys verifyPasskeyAuthentication": "a sign-in by a passkey",
  // Plan 12i Task 8: the passkey row, then the new user row and the session, as a sign-in does.
  "passkeys verifyPasskeySignUp": "a sign-up by a passkey: the passkey row, a new user, a sign-in",
  "password insertSignUp": [
    "an email claim by a magic link",
    "an email claim by the sign-up link",
    "an anonymous upgrade by an email claim",
  ],
  "password insertUniform": "one kind: the create of a new user and its password row, no session",
  "password passwordSignIn": "a sign-in by a password",
  // Plan 12i Task 20: the confirm of the link and of the code, one transaction.
  "password confirmSignUp": ["an email claim by the sign-up link"],
  "password applyReset": ["a password reset"],
  "password changePassword": ["a password set", "a password change", "a second factor enable"],
  "profile updateProfile": "one kind: the compare-and-set of the user row",
  // Plan 12i Task 2: the set of a username, the compare-and-set of updateProfile.
  "username setUsername": "one kind: the compare-and-set of the user row",
  // Plan 12i Task 6: the anonymous sign-in, and the one delete of anonymous users.
  "anonymous signInAnonymous": ["an anonymous sign-in"],
  "anonymous deleteAnonymousRows": [
    "an anonymous delete",
    "an anonymous upgrade by an email claim",
  ],
  // Plan 12i Task 7: the end of the anonymous sessions after an upgrade, before the delete.
  "anonymous upgradeSteps": ["an anonymous upgrade by an email claim"],
  // Plan 12i Task 5: the phone sign-in reads the user, then spends the code. Then it
  // creates the user and the session or the challenge, as the email code sign-in does.
  "phone resolvePhoneUser":
    "the user read, the spend of the code, then the new user row and the session or the challenge",
  // Plan 12i Task 5: the set of a phone, the compare-and-set of updateProfile, then the spend.
  "phone writePhone": "one kind: the compare-and-set of the user row, then the spend of the code",
  "roles createRole": ["a role create"],
  "roles deleteRole": "no kind: reads of member and invitation rows, then the role row",
  "second-factor-methods enableMethod":
    "the user hold, then addMethod: the steps of enableTotp in a second factor enable",
  "second-factor-methods disableMethod": "one kind: the user hold, then the factor rows",
  "second-factor disableSecondFactor": "one kind: the user hold, then the factor rows",
  "session-list revokeSession": "one kind: a session row",
  "session-list revokeOtherSessions": "one kind: session rows",
  "social completeLink": "one kind: an update of the session, then a new identity row",
  // Plan 12d Task 5: the SSO sign-in resolves through it, and adds a member row.
  "social resolveSocialUser": ["an SSO sign-in that claims a user"],
  "sweep sweepLinks": "no kind: oauth logout rows only",
  "sweep sweepExpired": "one kind: ended session rows",
  // Ruling 78 of plan 12d: the rows of the solo organizations of an account delete. The test
  // "the sweep of the rest of a solo organization" below checks its kinds.
  "organization-rest sweepOrganizationRest":
    "the sweep of the rest of a solo organization: its test",
  "teams createTeam": ["a team create"],
  "teams updateTeam": "one kind: the team row",
  "teams deleteTeam": ["a team delete"],
  "teams addTeamMember": ["a team member add", "a SCIM deactivate"],
  // Plan 12f2 Task 3: the spend, the user hold, the claim, and the session.
  "user-invite confirmUserInvite": ["an invitation confirm"],
  "teams removeTeamMember": ["a team member removal", "a team leave"],
  "teams setActiveTeam": ["a set of the active team"],
  "tokens createApiToken": "one kind: the user hold, then token rows",
  "totp enableTotp": ["a second factor enable"],
  "totp disableTotpWithCode": "no kind: the factor rows only",
  "totp twoFactorGate": "no kind: the password row and the challenge row",
  // The body of verifyTwoFactor, which emits the challenge event around it (plan 12h Task 5).
  "totp answerChallenge": "a sign-in after the second factor challenge",
  "users createOrFindInTransaction": [
    "a sign-in",
    "an email claim by a magic link",
    "an anonymous upgrade by an email claim",
    "a SCIM create that claims a user",
    "a SCIM update",
    "a SCIM deactivate",
    "a SCIM reactivate",
    "a SCIM delete",
    "a SCIM group create",
    "a SCIM group member removal",
    "a SCIM group member add",
    "a SCIM group rename",
    "a SCIM group delete",
  ],
  "operator/access-end endPendingRows": "one kind: the session rows of a pending end",
  [DOOR]: "the door of the operator acts: each call of operatorAct is a site of its own",
  "operator/ban banUser": ["a ban", "a ban of an operator with an impersonation"],
  "operator/ban unbanUser": "one kind: the user row",
  "operator/impersonation startImpersonation": ["an impersonation start"],
  "operator/impersonation stopImpersonation": ["an impersonation stop"],
  "operator/sessions endUserSessions": ["an end of the sessions of a user"],
  "operator/sessions endAllSessions": ["an end of all sessions"],
  "operator/second-factor disableFactorWithProof": "one kind: the user hold, then the factor rows",
  "operator/platform-role grantPlatformRole": ["a platform role grant"],
  "operator/platform-role revokePlatformRole": [
    "a platform role revoke with an impersonation",
    "a platform role revoke with no impersonation",
  ],
  "operator/platform-role createAdmin": ["an admin create"],
  // The domain proof of plan 12d. Its rows are of no kind of user-hold.ts.
  "sso/domains addDomain": "one kind: the lock of the organization row, then domain rows",
  "sso/domains verifyDomainWith": "no kind: the claim of the domain row, then its audit row",
  // Ruling 34 of plan 12d: the connection row comes before the domain rows in the three
  // sites of a domain and a connection. Ruling 35 adds the organization delete: its
  // deleteOrganizationsRows deletes the connection rows before the domain rows. The two
  // models are no kind here, so this check cannot see that order.
  // sso-connection-domain-race.test.ts races the four.
  "sso/domains updateDomain":
    "no kind: a read of the domain, the lock of the connection row, then the domain row",
  "sso/domains deleteDomain": "no kind: the domain row, then its audit row",
  "sso/domains enforceOff": "no kind: the domain row through operatorAct",
  "sso/domains loseDomain": "no kind: the loss of the claim of the domain row, then its audit row",
  // The connections of plan 12d Task 3. Their rows are of no kind of user-hold.ts either.
  "sso/connections createConnection":
    "one kind: the lock of the organization row, then reads of role rows and connections, then the connection row",
  "sso/connections updateConnection":
    "no kind: reads of role rows, the connection row, reads of domains, then its audit row",
  "sso/connections deleteConnection":
    "no kind: the connection row, then the domain rows routed to it, then its audit row",
  // The SCIM tokens of plan 12d Task 9b. Their rows are of no kind of user-hold.ts.
  "scim/tokens createScimToken":
    "one kind: the lock of the organization row, then reads of token rows, then the token row and its audit row",
  "scim/tokens revokeScimToken": "no kind: the token row, then its audit row",
  // The SCIM Users of plan 12d Task 10: the user hold, the sessions, the scimUser row,
  // the organization lock, the member and team member rows, then the audit row.
  "scim/users writeChange": [
    "a SCIM update",
    "a SCIM deactivate",
    "a SCIM reactivate",
    "a SCIM delete",
  ],
  // The SCIM Groups of plan 12d Task 11: the group row, the user hold, the sessions of
  // the persons who leave the team, the organization or team row, the member rows of
  // the role recompute, the scimGroupMember rows, the team member rows, then the audit row.
  "scim/groups writeGroup": [
    "a SCIM group create",
    "a SCIM group member removal",
    "a SCIM group member add",
    "a SCIM group rename",
    "a SCIM group delete",
  ],
  "operator/accounts createUser": ["an operator create", "an invitation confirm"],
  "operator/accounts updateUser": "one kind: the compare-and-set of the user row",
  "operator/accounts deleteUser": ["an operator delete with a solo and a shared organization"],
};

/** The sites that SITES pins to the flow `name`, sorted. */
const pinnedTo = (name: string): string[] =>
  Object.entries(SITES)
    .filter(([, pin]) => typeof pin !== "string" && pin.includes(name))
    .map(([key]) => key)
    .sort();

describe("the transaction sites of the engine (ruling 51 of plan 12k)", () => {
  it("each has a flow of FLOWS or a reason, and no entry is stale", () => {
    const found = sites("src").map((s) => s.key);
    // Plan 12d Task 2b adds the six sites of sso/domains.ts, and Task 3 the
    // three of sso/connections.ts. Task 9b adds the two of scim/tokens.ts.
    // Task 10 adds the one of scim/users.ts, and Task 11 the one of scim/groups.ts.
    // Ruling 78 adds the one of organization-rest.ts. Plan 12i Task 2 adds the
    // one of username.ts, and Task 5 the two of phone.ts. Task 6 adds the two of
    // anonymous.ts, and Task 7 the one of the anonymous upgrade. Task 8 adds the
    // one of the passkey-first sign-up. Plan 12f2 Task 4 adds the two of
    // operator/accounts.ts, and Task 2 the third (the operator create). Task 3
    // adds the one of user-invite.ts (the confirm).
    expect(found.length).toBe(88);
    expect([...found].sort()).toEqual(Object.keys(SITES).sort());
    for (const [key, pin] of Object.entries(SITES))
      if (typeof pin !== "string") {
        expect(pin.length, key).toBeGreaterThan(0);
        for (const name of pin) expect(Object.keys(FLOWS), key).toContain(name);
      }
  });
});

describe("the lock order of user-hold.ts in each flow (ruling 49 of plan 12k)", () => {
  for (const [name, call] of Object.entries(FLOWS))
    it(`${name} takes the kinds in the order of user-hold.ts`, async () => {
      const w = world();
      const s = await scene(w);
      const answer = await w.flow(name, () => call(w, s));
      expect(answer).toMatchObject({ ok: true });
      // The flow opens the sites that SITES pins to it, and no others.
      expect(w.sitesOf(name)).toEqual(pinnedTo(name));
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
    expect(w.kindsOf(name)).toEqual([
      "session",
      "organization",
      "team",
      "invitation",
      "team member",
    ]);
    expect(w.sitesOf(name)).toEqual(["teams deleteTeam"]);
    expect(w.outOfOrder(name), JSON.stringify(w.stepsOf(name))).toEqual([]);
  }, 60_000);

  it("the sweep of the rest of a solo organization takes the kinds in the order of user-hold.ts", async () => {
    const w = world();
    const s = await scene(w);
    // Oli's account delete leaves the rest of the solo organization to the sweep (ruling 78
    // of plan 12d).
    const gone = await w.auth.api.user.delete({ session: s.oli, ip: null, userAgent: null });
    expect(gone).toMatchObject({ ok: true });
    const name = "the sweep of the rest of a solo organization";
    const swept = await w.flow(name, () => w.auth.api.sweepExpired());
    expect(swept).toMatchObject({ organizationRows: 1 });
    expect(w.sitesOf(name)).toEqual([
      "organization-rest sweepOrganizationRest",
      "sweep sweepExpired",
    ]);
    expect(w.kindsOf(name)).toEqual([
      "SCIM group",
      "session",
      "SCIM user",
      "team",
      "invitation",
      "member",
      "team member",
    ]);
    expect(w.outOfOrder(name), JSON.stringify(w.stepsOf(name))).toEqual([]);
  }, 60_000);

  // A write that adds the platform role part to an existing member row holds
  // the user row first, as the operator delete does (ruling 6 of plan 12f2).
  // Tia joins the platform organization with no part before the flow.
  const GAINS: [string, string, (w: World, s: Scene, tia: string) => Promise<unknown>][] = [
    [
      "a platform role grant to a member of the platform organization",
      "operator/platform-role grantPlatformRole",
      (w, _s, tia) =>
        w.auth.api.operator.platformRole.grant({ actor: APP, userId: tia, ...reason }),
    ],
    [
      "a role change that adds the platform role",
      "organizations updateMemberRole",
      (w, s, tia) =>
        w.auth.api.updateMemberRole({
          user: s.ada.user,
          organizationId: s.platform,
          userId: tia,
          role: "member,operator",
        }),
    ],
  ];
  for (const [name, site, call] of GAINS)
    it(`${name} takes the user row first, in the order of user-hold.ts`, async () => {
      const w = world();
      const s = await scene(w);
      must(
        await w.auth.api.addMember({
          user: s.ada.user,
          organizationId: s.platform,
          userId: s.tia.user.id,
          role: "member",
        }),
      );
      expect(await w.flow(name, () => call(w, s, s.tia.user.id))).toMatchObject({ ok: true });
      expect(w.sitesOf(name)).toEqual([site]);
      expect(w.kindsOf(name)).toEqual(["user", "member"]);
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
    expect(w.kindsOf(name)).toEqual(["user", "session", "organization", "member", "team member"]);
    expect(w.outOfOrder(name)).toEqual([
      "transaction 1: update user after delete member",
      "transaction 1: lock session after delete member",
    ]);
  });
});
