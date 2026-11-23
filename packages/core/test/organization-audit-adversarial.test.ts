import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, SsoConfig } from "../src/config.js";
import { acceptInvitation, inviteMember, revokeInvitation } from "../src/engine/invitations.js";
import { banUser, unbanUser } from "../src/engine/operator/ban.js";
import {
  createOrganizationToken,
  revokeOrganizationToken,
} from "../src/engine/organization-tokens.js";
import {
  addMember,
  createOrganization,
  listMembers,
  removeMember,
  updateMemberRole,
} from "../src/engine/organizations.js";
import { createRole, deleteRole, updateRole } from "../src/engine/roles.js";
import { createScimToken, revokeScimToken } from "../src/engine/scim/tokens.js";
import { revokeSession } from "../src/engine/session-list.js";
import { resolveSession } from "../src/engine/sessions.js";
import {
  createConnection,
  deleteConnection,
  updateConnection,
} from "../src/engine/sso/connections.js";
import { addDomain, deleteDomain, enforceOff, updateDomain } from "../src/engine/sso/domains.js";
import { requireSsoManager, type SsoActor } from "../src/engine/sso/guard.js";
import { activateSetup } from "../src/engine/sso/setup-activate.js";
import { saveDraftConnection } from "../src/engine/sso/setup-drafts.js";
import { createSetupLink, handBack, revokeSetupLink } from "../src/engine/sso/setup-links.js";
import { openSetupSession, requireSetupSession } from "../src/engine/sso/setup-session.js";
import { sweepExpired } from "../src/engine/sweep.js";
import type { AuthEvent } from "../src/observe/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import { ok } from "../src/result.js";
import {
  type ModelName,
  ORGANIZATION_VISIBLE_ACTIONS,
  schema,
  type UserRow,
} from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import {
  get,
  LONG_TEST_MS,
  post,
  recordAddress,
  recordCredential,
  seedPlatform,
} from "./helpers.js";
import {
  OPERATOR_EMAIL,
  OPERATOR_SECRETS,
  operatorHeader,
  secretActor,
} from "./operator-helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";
import { SCIM_APP, scim, scimAuth } from "./scim/helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt } from "./social-helpers.js";
import { SSO_APP, ssoAuth, verifiedDomain } from "./sso/helpers.js";
import { samlConnection } from "./sso/saml-helpers.js";
import { endpointsOf, issuerOf } from "./sso/sign-in-helpers.js";
import { enrolled, PASSWORD } from "./totp-helpers.js";

// Plan 13b Task 12: the adversarial proofs of the organization audit and the expiry notices.

const META = {
  ip: recordAddress("198.51.100.21"),
  userAgent: recordAddress("organization-audit-adversarial-test"),
};
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const RANKS = { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 };
const LOG_METHODS = ["error", "info", "warn", "log", "debug"] as const;
const FORBIDDEN = { status: 403, body: { error: "forbidden_rank" } };
const UNAUTHORIZED = { status: 401, body: { error: "unauthorized" } };
const NOT_OPERATOR = { status: 403, body: { error: "operator_required" } };
const INVALID = { status: 400, body: { error: "invalid_body" } };

beforeEach(() => {
  for (const m of LOG_METHODS) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Each console line that the test wrote, as text. */
function logLines(): string[] {
  return LOG_METHODS.flatMap((m) =>
    vi.mocked(console[m]).mock.calls.map((args) => JSON.stringify(args)),
  );
}

/**
 * Two organizations: `o1` of `owner@acme.example` and `o2` of `owner@beta.example`, each owner
 * with a second factor. The `ranks` form with dynamic roles, the operator tools, the
 * impersonation, SCIM, SAML, and the setup links are on. One operator secret has the scopes
 * `audit`, `sso`, and `users`. A sink keeps each event. `extra` replaces a key of the config.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const batches: AuthEvent[][] = [];
  const w = ssoAuth({
    password: { hash: FAST, uniformSignUp: false },
    scim: {},
    sso: { saml: true, setup: {} } as SsoConfig,
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: RANKS,
      dynamicRoles: {},
    },
    operator: {
      secrets: [
        {
          name: "audit",
          secretHash: await sha256Hex(recordCredential(OPERATOR_SECRETS.audit)),
          scopes: ["audit", "sso", "users"],
        },
      ],
      users: true,
      impersonation: {},
    },
    observe: { sink: { write: (b) => void batches.push([...b]) } },
    ...extra,
  });
  const owner = (await enrolled(w, "owner@acme.example")).session;
  const other = (await enrolled(w, "owner@beta.example")).session;
  const o1 = await organizationOf(w, owner.user, "acme");
  const o2 = await organizationOf(w, other.user, "beta");
  const events = async () => {
    await w.config.observe.flush();
    return batches.flat();
  };
  return { ...w, owner, other, o1, o2, events };
}
type W = Awaited<ReturnType<typeof world>>;

async function organizationOf(w: ReturnType<typeof ssoAuth>, user: UserRow, slug: string) {
  const made = await createOrganization(w.config, { user, slug, name: slug });
  if (!made.ok) throw new Error(made.code);
  return made.value.organization.id;
}

/** A member of `organizationId` at `role`, added by `by`, with a fresh session and a factor. */
async function memberOf(w: W, by: UserRow, organizationId: string, email: string, role: string) {
  const s = await enrolled(w, email);
  const added = await addMember(w.config, { user: by, organizationId, userId: s.user.id, role });
  if (!added.ok) throw new Error(added.code);
  return s.session;
}

/** The actor that the manager guard gives for a session token, as a route gets it. */
async function guarded(w: W, token: string, organizationId: string): Promise<SsoActor> {
  const resolved = await resolveSession(w.config, token);
  if (!resolved) throw new Error("the session ended");
  const r = await requireSsoManager(w.config, resolved, organizationId);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** A platform operator who owns no organization, through the flows of the product. Its session token. */
async function platformOperator(w: W): Promise<{ token: string; userId: string }> {
  const { root, platformOrg } = await seedPlatform(w);
  await signUpAndVerify(w, OPERATOR_EMAIL, PASSWORD);
  const user = await w.storage.findOne("user", [
    { field: "email", op: "eq", value: OPERATOR_EMAIL },
  ]);
  if (!user) throw new Error("no operator user");
  const added = await addMember(w.config, {
    user: root,
    organizationId: platformOrg.id,
    userId: user.id,
    role: "operator",
  });
  if (!added.ok) throw new Error(added.code);
  return { token: (await enrolled(w, OPERATOR_EMAIL)).session.token, userId: user.id };
}

/** One `sso_domain_add` row by `actor` in `organizationId`. */
async function domainOf(w: W, actor: SsoActor, organizationId: string, domain: string) {
  const added = await addDomain(w.config, actor, { organizationId, domain, ...META });
  if (!added.ok) throw new Error(added.code);
  return added.value.id;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const cookie = (token: string) => ({ cookie: `__Host-tempo_session=${token}` });

/** GET of `path` with the raw query text, by the bearer `token`. */
async function getRaw(w: W, path: string, query: string, headers: Record<string, string>) {
  const res = await w.handle(get(`/auth${path}?${query}`, headers));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** GET /organizations/audit with the query, by the bearer `token`. */
const read = (w: W, token: string, query: Record<string, string>) =>
  getRaw(w, "/organizations/audit", String(new URLSearchParams(query)), bearer(token));

interface View {
  id: string;
  at: string;
  actor: { kind: string; id: string | null; email: string | null };
  action: string;
  targetUserId: string | null;
  data: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

/** A read that must answer 200: the page. */
async function page(w: W, token: string, query: Record<string, string>) {
  const r = await read(w, token, query);
  if (r.status !== 200) throw new Error(`the read answered ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as unknown as { rows: View[]; next: string | null };
}

/** The stored audit rows of an organization, by id. */
const storedOf = (w: W, organizationId: string) =>
  w.storage.findMany(
    "operatorAudit",
    [{ field: "organizationId", op: "eq", value: organizationId }],
    {
      sort: { field: "id", dir: "asc" },
    },
  );

/** The start of an impersonation of `userId` by the operator session `token`. The new token. */
async function impersonate(w: W, operatorToken: string, userId: string): Promise<string> {
  const started = await w.handle(
    post(
      "/auth/operator/impersonate",
      { userId, reason: "Ticket 12: a support call" },
      cookie(operatorToken),
    ),
  );
  if (started.status !== 200) throw new Error(`the start answered ${started.status}`);
  const line = started.headers.getSetCookie().find((s) => s.startsWith("__Host-tempo_session="));
  return recordCredential(line?.slice("__Host-tempo_session=".length).split(";")[0] ?? "");
}

const OIDC = {
  kind: "oidc",
  label: "Acme Okta",
  issuer: issuerOf("acme"),
  clientId: "acme-client",
  clientSecret: "idp-client-secret-0123456789",
  endpoints: endpointsOf("acme"),
} as const;

/** A setup session of `o1` through the real link, the open, and the check of the cookie. */
async function setupSession(w: W, actor: SsoActor, note: string) {
  const made = await createSetupLink(
    w.config,
    actor,
    { organizationId: w.o1, steps: ["connection"], kinds: ["oidc"], note },
    META,
  );
  if (!made.ok) throw new Error(made.code);
  const opened = await openSetupSession(w.config, made.value.token, META);
  if (!opened.ok) throw new Error(opened.code);
  const cookie = opened.value.cookie.split(";")[0] ?? "";
  const checked = await requireSetupSession(
    w.config,
    new Request("https://auth.example/auth/sso/setup/status", { headers: { cookie } }),
  );
  if (!checked.ok) throw new Error(checked.code);
  return {
    ...checked.value,
    cookie,
    linkId: made.value.id,
    secrets: [recordCredential(made.value.token), recordCredential(cookie.split("=")[1] ?? "")],
  };
}

/** A whole OIDC test run of the draft of a setup session that passes. The draft id. */
async function passedTest(
  w: W,
  idTokens: Record<string, FakeIdToken>,
  s: Awaited<ReturnType<typeof setupSession>>,
) {
  const saved = await saveDraftConnection(w.config, s, OIDC);
  if (!saved.ok) throw new Error(saved.code);
  const id = saved.value.id;
  const started = await w.handle(get(`/auth/sso/${id}/start?test=1`, { cookie: s.cookie }));
  const url = new URL(started.headers.get("location") ?? "");
  const code = "adversarial-code-1";
  idTokens[code] = {
    audience: "acme-client",
    issuer: issuerOf("acme"),
    claims: {
      sub: "t-1",
      email: "tess@acme.example",
      name: "Tess",
      nonce: url.searchParams.get("nonce") ?? "",
    },
  };
  const bind = started.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
    ?.split(";")[0];
  const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
  await w.handle(get(`/auth/sso/${id}/callback?${q}`, { cookie: bind ?? "" }));
  const run = await w.storage.findOne("ssoTestRun", [
    { field: "connectionId", op: "eq", value: id },
  ]);
  if (run?.outcome !== "passed") throw new Error(`the test run is ${run?.outcome}`);
  return id;
}

/**
 * Counts each update and each delete of `operatorAudit` on `storage`, on its transaction handles
 * too. The root is changed in place, because the config and the router hold it.
 */
function countAuditWrites(storage: StorageAdapter): { update: number; delete: number } {
  const counts = { update: 0, delete: 0 };
  const writes = ["update", "delete", "deleteRows", "deleteOnlyWhile"] as const;
  const counted =
    (target: StorageAdapter, name: (typeof writes)[number]) =>
    (...args: unknown[]) => {
      if (args[0] === "operatorAudit") counts[name === "update" ? "update" : "delete"]++;
      return (target[name] as (...a: unknown[]) => unknown).apply(target, args);
    };
  const wrap = (s: StorageAdapter): StorageAdapter =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (
          (writes as readonly unknown[]).includes(prop) &&
          target[prop as (typeof writes)[number]]
        )
          return counted(target, prop as (typeof writes)[number]);
        if (prop === "transaction")
          return (fn: (tx: StorageAdapter) => Promise<unknown>) =>
            target.transaction((tx) => fn(wrap(tx)));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const raw = Object.create(storage) as StorageAdapter;
  for (const name of writes) {
    const fn = storage[name];
    if (fn) (raw as unknown as Record<string, unknown>)[name] = fn.bind(storage);
  }
  const transaction = storage.transaction.bind(storage);
  for (const name of writes)
    if (storage[name]) (storage as unknown as Record<string, unknown>)[name] = counted(raw, name);
  storage.transaction = ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
    transaction((tx) => fn(wrap(tx)))) as StorageAdapter["transaction"];
  return counts;
}

/** Each string value of each field with `hash` in its name, of every model. */
async function storedHashes(storage: StorageAdapter): Promise<string[]> {
  const hashes: string[] = [];
  for (const model of Object.keys(schema) as ModelName[]) {
    const fields = Object.keys(schema[model].fields).filter((f) => /hash/i.test(f));
    if (fields.length === 0) continue;
    for (const row of await storage.findMany(model, []))
      for (const f of fields) {
        const v = (row as unknown as Record<string, unknown>)[f];
        if (typeof v === "string" && v.length >= 16) hashes.push(v);
      }
  }
  return hashes;
}

describe("the organization audit under attack (plan 13b Task 12)", () => {
  it("cross-org sweep: the id of o2 in each query field gives no row of o2", async () => {
    const w = await world();
    await domainOf(w, SSO_APP, w.o1, "one.acme.example");
    await domainOf(w, SSO_APP, w.o2, "beta.example");
    await domainOf(w, SSO_APP, w.o1, "two.acme.example");
    const [o2Row] = await storedOf(w, w.o2);
    const o1Rows = await storedOf(w, w.o1);
    const x = o2Row?.id ?? "";
    expect(o1Rows).toHaveLength(2);
    // The organization field: the answer of a non-member.
    expect(await read(w, w.owner.token, { organizationId: w.o2 })).toEqual(FORBIDDEN);
    // The o2 row lies between the two o1 rows: the page and a cursor before it skip it.
    const all = await page(w, w.owner.token, { organizationId: w.o1 });
    expect(all.rows.map((r) => r.id)).toEqual(o1Rows.map((r) => r.id));
    const before = await page(w, w.owner.token, {
      organizationId: w.o1,
      after: o1Rows[0]?.id ?? "",
    });
    expect(before.rows.map((r) => r.id)).toEqual([o1Rows[1]?.id]);
    // `after` with the id of an o2 row is a cursor only: the o1 rows after it, no o2 row.
    const after = await page(w, w.owner.token, { organizationId: w.o1, after: x });
    expect(after.rows.map((r) => r.id)).toEqual([o1Rows[1]?.id]);
    // The id of o2 in a field of another type: a bad query.
    for (const field of ["action", "from", "to", "limit"])
      expect([field, await read(w, w.owner.token, { organizationId: w.o1, [field]: x })]).toEqual([
        field,
        INVALID,
      ]);
    // Two organizations in one query: a bad query, in both orders.
    for (const q of [
      `organizationId=${w.o1}&organizationId=${w.o2}`,
      `organizationId=${w.o2}&organizationId=${w.o1}`,
    ])
      expect(await getRaw(w, "/organizations/audit", q, bearer(w.owner.token))).toEqual(INVALID);
    // The operator route refuses the session of an owner, with each filter.
    for (const q of [`organizationId=${w.o2}`, `targetUserId=${w.other.user.id}`, `after=${x}`, ""])
      expect([q, await getRaw(w, "/operator/audit", q, bearer(w.owner.token))]).toEqual([
        q,
        NOT_OPERATOR,
      ]);
  });

  it("operator hidden: a ban, an unban, and an impersonation start and stop of a member are not in o1", async () => {
    const w = await world();
    const bo = await memberOf(w, w.owner.user, w.o1, "bo@acme.example", "member");
    const before = (await page(w, w.owner.token, { organizationId: w.o1 })).rows;
    const secret = await secretActor(w, OPERATOR_SECRETS.audit);
    const act = {
      actor: secret,
      userId: bo.user.id,
      reason: "Ticket 7: spam",
      ip: null,
      userAgent: null,
    };
    expect((await banUser(w.config, act)).ok).toBe(true);
    expect((await unbanUser(w.config, act)).ok).toBe(true);
    const operator = await platformOperator(w);
    const as = await impersonate(w, operator.token, bo.user.id);
    const stopped = await w.handle(post("/auth/operator/impersonate/stop", {}, cookie(as)));
    expect(stopped.status).toBe(200);
    expect((await page(w, w.owner.token, { organizationId: w.o1 })).rows).toEqual(before);
    // The operator reads the four rows by the user, each with no organization.
    const rows = await getRaw(
      w,
      "/operator/audit",
      `targetUserId=${bo.user.id}`,
      operatorHeader(OPERATOR_SECRETS.audit),
    );
    const listed = (rows.body.rows as { action: string; organizationId: string | null }[]).filter(
      (r) => r.organizationId === null,
    );
    expect(listed.map((r) => r.action)).toEqual([
      "ban",
      "unban",
      "impersonation_start",
      "impersonation_stop",
    ]);
  });

  it("impersonation act: an operator who acts as the owner shows as platform, with no IP and no agent", async () => {
    const w = await world();
    const made = await inviteMember(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      email: "di@acme.example",
      role: "member",
    });
    if (!made.ok) throw new Error(made.code);
    const operator = await platformOperator(w);
    const as = await impersonate(w, operator.token, w.owner.user.id);
    const agent = recordAddress("operator-console-agent");
    const ip = recordAddress("203.0.113.99");
    const res = await w.handle(
      post(
        "/auth/organizations/invitations/revoke",
        { organizationId: w.o1, invitationId: made.value.id },
        { ...cookie(as), "user-agent": agent, "cf-connecting-ip": ip },
      ),
    );
    expect(res.status).toBe(200);
    const view = (await page(w, w.owner.token, { organizationId: w.o1 })).rows.find(
      (r) => r.action === "organization_invitation_revoke",
    );
    expect(view && [view.actor, view.ip, view.userAgent]).toEqual([
      { kind: "platform", id: null, email: null },
      null,
      null,
    ]);
    // The row names the operator and keeps the IP for the operator view.
    const stored = (await storedOf(w, w.o1)).find(
      (r) => r.action === "organization_invitation_revoke",
    );
    expect(stored && [stored.actorKind, stored.actorId, stored.data?.platform, stored.ip]).toEqual([
      "user",
      operator.userId,
      true,
      ip,
    ]);
  });

  // Ruling R19 (narrows R17): the accept row of an impersonation shows `platform` as the actor. Its
  // target is the new member, the impersonated user. The member list shows that user to the owner,
  // so the target tells the owner no new fact. No other field names the user.
  it("impersonation accept: the actor is platform, and the one field that names the user is the target, a member the list shows", async () => {
    const w = await world();
    const cy = (await enrolled(w, "cy@acme.example")).session;
    const invited = await inviteMember(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      email: "cy@acme.example",
      role: "member",
    });
    if (!invited.ok) throw new Error(invited.code);
    const mail = w.mail.findLast((m) => m.to === "cy@acme.example")?.text ?? "";
    const token = recordCredential(/invitation=(inv_[A-Za-z0-9_-]+)/.exec(mail)?.[1] ?? "");
    const operator = await platformOperator(w);
    const as = await impersonate(w, operator.token, cy.user.id);
    const res = await w.handle(
      post("/auth/organizations/invitations/accept", { token }, { ...cookie(as) }),
    );
    expect(res.status).toBe(200);
    const view = (await page(w, w.owner.token, { organizationId: w.o1 })).rows.find(
      (r) => r.action === "organization_invitation_accept",
    );
    if (!view) throw new Error("no accept row");
    expect([view.actor, view.targetUserId, view.ip, view.userAgent]).toEqual([
      { kind: "platform", id: null, email: null },
      cy.user.id,
      null,
      null,
    ]);
    // No other field of the row names the user: not the data, not the actor.
    expect(JSON.stringify({ ...view, targetUserId: null })).not.toContain(cy.user.id);
    // The target is a member that the owner sees in the member list.
    const members = await listMembers(w.config, { user: w.owner.user, organizationId: w.o1 });
    if (!members.ok) throw new Error(members.code);
    expect(members.value.map((m) => m.userId)).toContain(cy.user.id);
    const stored = (await storedOf(w, w.o1)).find(
      (r) => r.action === "organization_invitation_accept",
    );
    expect(stored && [stored.actorId, stored.data?.platform, stored.targetUserId]).toEqual([
      operator.userId,
      true,
      cy.user.id,
    ]);
  });

  it(
    "leak scan and append-only: a scene of each visible action and a sweep; no address in data, no token, no hash, no audit update or delete",
    async () => {
      const idTokens: Record<string, FakeIdToken> = {};
      const idp = fakeFetch((call) =>
        Response.json({ id_token: call.form.code, token_type: "Bearer" }),
      );
      // OIDC on a fake IdP for the test run, SCIM groups as roles for the group acts, and a
      // session of 60 days: the domain loss needs 31 days and three failed rechecks.
      const w = await world({
        scim: { groups: "roles" },
        sso: { saml: true, oidc: true, setup: {}, fetch: idp.fetchFn } as SsoConfig,
        jwt: fakeJwt(idTokens),
        session: { ttlDays: 60 },
      });
      const writes = countAuditWrites(w.config.storage);
      const tokens: string[] = [w.owner.token];
      const owner = await guarded(w, w.owner.token, w.o1);
      const domainId = await verifiedDomain(w, w.o1);
      const twoId = await domainOf(w, owner, w.o1, "two.acme.example");
      const bo = await memberOf(w, w.owner.user, w.o1, "bo@acme.example", "member");
      const base = { user: w.owner.user, session: w.owner.session, organizationId: w.o1, ...META };
      expect(
        (await updateMemberRole(w.config, { ...base, userId: bo.user.id, role: "admin" })).ok,
      ).toBe(true);
      const cy = await enrolled(w, "cy@acme.example");
      const invited = await inviteMember(w.config, {
        ...base,
        email: "cy@acme.example",
        role: "member",
      });
      if (!invited.ok) throw new Error(invited.code);
      const mail = w.mail.findLast((m) => m.to === "cy@acme.example")?.text ?? "";
      const invitation = recordCredential(/invitation=(inv_[A-Za-z0-9_-]+)/.exec(mail)?.[1] ?? "");
      tokens.push(invitation);
      const accepted = await acceptInvitation(w.config, {
        user: cy.user,
        session: cy.session.session,
        token: invitation,
        ip: null,
      });
      expect(accepted.ok).toBe(true);
      const di = await inviteMember(w.config, {
        ...base,
        email: "di@acme.example",
        role: "member",
      });
      if (!di.ok) throw new Error(di.code);
      expect((await revokeInvitation(w.config, { ...base, invitationId: di.value.id })).ok).toBe(
        true,
      );
      const role = { user: w.owner.user, organizationId: w.o1, name: "lead" };
      expect(
        (await createRole(w.config, { ...role, rank: 1, permissions: { member: ["read"] } })).ok,
      ).toBe(true);
      expect((await updateRole(w.config, { ...role, rank: 2 })).ok).toBe(true);
      expect((await deleteRole(w.config, role)).ok).toBe(true);
      const token = await createOrganizationToken(w.config, {
        session: w.owner,
        organizationId: w.o1,
        name: "ci",
        permissions: { member: ["read"] },
      });
      if (!token.ok) throw new Error(token.code);
      tokens.push(recordCredential(token.value.token));
      expect(
        (await revokeOrganizationToken(w.config, { ...base, id: token.value.apiToken.id })).ok,
      ).toBe(true);
      const directory = await createScimToken(w.config, SCIM_APP, {
        organizationId: w.o1,
        name: "dir-1",
      });
      if (!directory.ok) throw new Error(directory.code);
      tokens.push(recordCredential(directory.value.token));
      const created = await scim(w, directory.value.token, "POST", "/Users", {
        schemas: [USER_URN],
        userName: "ada@acme.example",
      });
      expect(created.status).toBe(201);
      const link = await createSetupLink(w.config, SSO_APP, {
        organizationId: w.o1,
        steps: ["domain"],
        kinds: ["saml"],
        ttlHours: 168,
        note: "IT of Acme",
      });
      if (!link.ok) throw new Error(link.code);
      tokens.push(recordCredential(link.value.token));
      expect((await revokeSetupLink(w.config, SSO_APP, link.value.id)).ok).toBe(true);
      const secret = await secretActor(w, OPERATOR_SECRETS.audit);
      const act = {
        actor: secret,
        userId: bo.user.id,
        reason: "Ticket 8",
        ip: null,
        userAgent: null,
      };
      expect((await banUser(w.config, act)).ok).toBe(true);
      expect((await unbanUser(w.config, act)).ok).toBe(true);
      expect((await removeMember(w.config, { ...base, userId: bo.user.id })).ok).toBe(true);
      // The connection acts of the owner.
      const conn = await createConnection(w.config, owner, { ...OIDC, organizationId: w.o1 }, META);
      if (!conn.ok) throw new Error(conn.code);
      const connId = conn.value.id;
      expect((await updateConnection(w.config, owner, { id: connId, enabled: false })).ok).toBe(
        true,
      );
      expect((await deleteConnection(w.config, owner, { id: connId })).ok).toBe(true);
      // The domain acts: an update and a delete by the owner, and enforce off by a platform operator.
      expect(
        (await updateDomain(w.config, owner, { id: domainId, includeSubdomains: true })).ok,
      ).toBe(true);
      expect((await deleteDomain(w.config, owner, { id: twoId, ...META })).ok).toBe(true);
      const operator = await platformOperator(w);
      tokens.push(operator.token);
      const platform = await guarded(w, operator.token, w.o1);
      if (platform.kind !== "platform") throw new Error(`the guard gave ${platform.kind}`);
      const off = await enforceOff(
        w.config,
        { kind: "user", user: platform.user, session: platform.session },
        { domainId, reason: "the IdP is down", ...META },
      );
      expect(off.ok).toBe(true);
      // The SCIM acts on the user and on a group, then the revoke of the directory token.
      const ada = ((await created.json()) as { id: string }).id;
      const put = await scim(w, directory.value.token, "PUT", `/Users/${ada}`, {
        schemas: [USER_URN],
        userName: "ada@acme.example",
        displayName: "Ada L",
      });
      expect(put.status).toBe(200);
      const deactivated = await scim(w, directory.value.token, "PATCH", `/Users/${ada}`, {
        schemas: [PATCH_URN],
        Operations: [{ op: "replace", path: "active", value: false }],
      });
      expect(deactivated.status).toBe(200);
      expect((await scim(w, directory.value.token, "DELETE", `/Users/${ada}`)).status).toBe(204);
      const group = await scim(w, directory.value.token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Staff",
      });
      expect(group.status).toBe(201);
      const groupId = ((await group.json()) as { id: string }).id;
      const renamed = await scim(w, directory.value.token, "PUT", `/Groups/${groupId}`, {
        schemas: [GROUP_URN],
        displayName: "Staff 2",
      });
      expect(renamed.status).toBe(200);
      expect((await scim(w, directory.value.token, "DELETE", `/Groups/${groupId}`)).status).toBe(
        204,
      );
      expect((await revokeScimToken(w.config, SCIM_APP, { id: directory.value.id })).ok).toBe(true);
      // The setup acts: an open, a test run, and an activation; then a hand back of a second link.
      const s = await setupSession(w, owner, "Ann at Acme IT");
      tokens.push(...s.secrets);
      const draftId = await passedTest(w, idTokens, s);
      const draft = await w.storage.findOne("ssoConnection", [
        { field: "id", op: "eq", value: draftId },
      ]);
      const activated = await activateSetup(
        w.config,
        owner,
        s.linkId,
        draft?.version ?? 0,
        async () => ok(undefined),
        META,
      );
      expect(activated.ok).toBe(true);
      const back = await setupSession(w, SSO_APP, "Bea at Acme IT");
      tokens.push(...back.secrets);
      expect(await handBack(w.config, back)).toEqual(ok(undefined));
      // D2: an invitation revoke by an operator who acts as the owner.
      const eve = await inviteMember(w.config, {
        ...base,
        email: "eve@acme.example",
        role: "member",
      });
      if (!eve.ok) throw new Error(eve.code);
      const as = await impersonate(w, operator.token, w.owner.user.id);
      tokens.push(as);
      const revoked = await w.handle(
        post(
          "/auth/organizations/invitations/revoke",
          { organizationId: w.o1, invitationId: eve.value.id },
          { ...cookie(as), "user-agent": "operator-console", "cf-connecting-ip": "203.0.113.99" },
        ),
      );
      expect(revoked.status).toBe(200);
      // The domain loss: 31 days on, the records are gone, and three rechecks fail.
      w.clock.advance(31 * DAY_MS);
      for (const answers of [w.answers.a, w.answers.b])
        for (const name of Object.keys(answers)) answers[name] = [];
      for (const hours of [0, 36, 36]) {
        w.clock.advance(hours * HOUR_MS);
        await sweepExpired(w.config);
      }
      const answer = await page(w, w.owner.token, { organizationId: w.o1, limit: "100" });
      const actions = answer.rows.map((r) => r.action);
      expect(actions).toEqual([
        "sso_domain_add",
        "sso_domain_verify",
        "sso_domain_add",
        "organization_member_add",
        "organization_member_role_change",
        "organization_invitation_create",
        "organization_invitation_accept",
        "organization_invitation_create",
        "organization_invitation_revoke",
        "organization_role_create",
        "organization_role_update",
        "organization_role_delete",
        "organization_token_create",
        "organization_token_revoke",
        "scim_token_create",
        "scim_user_create",
        "sso_setup_link_create",
        "sso_setup_link_revoke",
        "organization_member_remove",
        "sso_connection_create",
        "sso_connection_update",
        "sso_connection_delete",
        "sso_domain_update",
        "sso_domain_delete",
        "sso_enforce_off",
        "scim_user_update",
        "scim_user_deactivate",
        "scim_user_delete",
        "scim_group_create",
        "scim_group_update",
        "scim_group_delete",
        "scim_token_revoke",
        "sso_setup_link_create",
        "sso_setup_link_open",
        // The save of the draft, then the test run, then the activation of the link and the draft.
        "sso_connection_create",
        "sso_test_run",
        "sso_setup_link_activate",
        "sso_connection_update",
        "sso_setup_link_create",
        "sso_setup_link_open",
        "sso_setup_link_ready",
        "organization_invitation_create",
        "organization_invitation_revoke",
        "sso_domain_lost",
      ]);
      // The guard: the scene holds each visible action, so a new action needs a row of the scene.
      expect([...new Set(actions)].sort()).toEqual([...ORGANIZATION_VISIBLE_ACTIONS].sort());
      const operatorPage = await getRaw(
        w,
        "/operator/audit",
        "limit=100",
        operatorHeader(OPERATOR_SECRETS.audit),
      );
      // The sweep deletes ended rows, so the hashes are read before it too.
      const early = await storedHashes(w.storage);
      // The sweep ends each row that can end: it must not change or delete an audit row.
      w.clock.advance(400 * DAY_MS);
      await sweepExpired(w.config);
      const stored = await w.storage.findMany("operatorAudit", []);
      const addresses = [
        "owner@acme.example",
        "owner@beta.example",
        "bo@acme.example",
        "cy@acme.example",
        "di@acme.example",
        "eve@acme.example",
        "ada@acme.example",
        "tess@acme.example",
        OPERATOR_EMAIL,
      ];
      for (const row of stored)
        for (const a of addresses)
          expect([row.action, JSON.stringify(row.data)]).not.toContainEqual(
            expect.stringContaining(a),
          );
      const texts = [
        JSON.stringify(stored),
        JSON.stringify(answer),
        JSON.stringify(operatorPage),
        JSON.stringify(await w.events()),
        ...logLines(),
      ];
      // A revoke deletes some rows, so the hash of each token is made here too.
      const made = await Promise.all(tokens.map((t) => sha256Hex(t)));
      const hashes = [...new Set([...early, ...(await storedHashes(w.storage)), ...made])];
      expect(hashes.length).toBeGreaterThanOrEqual(4);
      for (const text of texts) {
        for (const t of [...tokens, OPERATOR_SECRETS.audit]) expect(text).not.toContain(t);
        for (const h of hashes) expect(text).not.toContain(h);
      }
      for (const text of texts.slice(3)) for (const a of addresses) expect(text).not.toContain(a);
      expect(writes).toEqual({ update: 0, delete: 0 });
    },
    LONG_TEST_MS,
  );

  it("permission loss: a demoted owner and a role that loses audit:read are refused at the next read", async () => {
    const w = await world();
    const second = await memberOf(w, w.owner.user, w.o1, "second@acme.example", "owner");
    expect((await read(w, w.owner.token, { organizationId: w.o1 })).status).toBe(200);
    const demoted = await updateMemberRole(w.config, {
      user: second.user,
      organizationId: w.o1,
      userId: w.owner.user.id,
      role: "admin",
    });
    expect(demoted.ok).toBe(true);
    expect(await read(w, w.owner.token, { organizationId: w.o1 })).toEqual(FORBIDDEN);
    // A role of the owner with audit:read, then the same role without it.
    const made = await createRole(w.config, {
      user: second.user,
      organizationId: w.o1,
      name: "auditor",
      rank: 3,
      permissions: { audit: ["read"] },
    });
    expect(made.ok).toBe(true);
    const ann = await memberOf(w, second.user, w.o1, "ann@acme.example", "auditor");
    expect((await read(w, ann.token, { organizationId: w.o1 })).status).toBe(200);
    const cut = await updateRole(w.config, {
      user: second.user,
      organizationId: w.o1,
      name: "auditor",
      permissions: { member: ["read"] },
    });
    expect(cut.ok).toBe(true);
    expect(await read(w, ann.token, { organizationId: w.o1 })).toEqual(FORBIDDEN);
  });

  it("admin and custom role: an admin is refused, and cannot make a role with audit:read", async () => {
    const w = await world();
    const admin = await memberOf(w, w.owner.user, w.o1, "admin@acme.example", "admin");
    expect(await read(w, admin.token, { organizationId: w.o1 })).toEqual(FORBIDDEN);
    const made = await createRole(w.config, {
      user: admin.user,
      organizationId: w.o1,
      name: "peek",
      rank: 1,
      permissions: { audit: ["read"] },
    });
    expect(made).toMatchObject({ ok: false, code: "forbidden_rank" });
    // A member of a custom role with no audit:read is refused too.
    const plain = await createRole(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      name: "plain",
      rank: 2,
      permissions: { member: ["read"] },
    });
    expect(plain.ok).toBe(true);
    const pat = await memberOf(w, w.owner.user, w.o1, "pat@acme.example", "plain");
    expect(await read(w, pat.token, { organizationId: w.o1 })).toEqual(FORBIDDEN);
  });

  it("revoked or expired session: the read answers unauthorized", async () => {
    const w = await world();
    const ended = await revokeSession(w.config, { session: w.owner, id: w.owner.session.id });
    expect(ended).toMatchObject({ ok: true });
    expect(await read(w, w.owner.token, { organizationId: w.o1 })).toEqual(UNAUTHORIZED);
    expect((await read(w, w.other.token, { organizationId: w.o2 })).status).toBe(200);
    w.clock.advance(400 * DAY_MS);
    expect(await read(w, w.other.token, { organizationId: w.o2 })).toEqual(UNAUTHORIZED);
  });

  it("clock back: a row written after the clock goes back lists after the older row, by id", async () => {
    const w = await world();
    await domainOf(w, SSO_APP, w.o1, "one.acme.example");
    const first = w.clock.now().toISOString();
    w.clock.advance(-DAY_MS);
    await domainOf(w, SSO_APP, w.o1, "two.acme.example");
    const back = w.clock.now().toISOString();
    const all = await page(w, w.owner.token, { organizationId: w.o1 });
    expect(all.rows.map((r) => [r.data?.domain, r.at])).toEqual([
      ["one.acme.example", first],
      ["two.acme.example", back],
    ]);
    // A cursor after the first row still reaches the second one.
    const one = await page(w, w.owner.token, { organizationId: w.o1, limit: "1" });
    const two = await page(w, w.owner.token, {
      organizationId: w.o1,
      limit: "1",
      after: one.next ?? "",
    });
    expect([...one.rows, ...two.rows].map((r) => r.data?.domain)).toEqual([
      "one.acme.example",
      "two.acme.example",
    ]);
    expect(two.next).toBeNull();
  });
});

// The expiry notices.

/** The end of the certificate of each SAML row. */
const END = new Date("2027-02-15T00:00:00.000Z");

/** The world of `scimAuth` (acme, one owner) with SAML, the setup links, and an event sink. */
async function sweepWorld(overrides: Partial<AuthConfig> = {}) {
  const batches: AuthEvent[][] = [];
  const calls: { kind: string; id: string }[] = [];
  const w = await scimAuth({
    sso: { saml: true, setup: {} } as SsoConfig,
    observe: { sink: { write: (b) => void batches.push([...b]) } },
    hooks: { sso: { expiring: async (e) => void calls.push({ kind: e.kind, id: e.id }) } },
    ...overrides,
  });
  const events = async (name: string) => {
    await w.config.observe.flush();
    return batches.flat().filter((e) => e.name === name) as (AuthEvent & Record<string, unknown>)[];
  };
  return { ...w, calls, events };
}
type SW = Awaited<ReturnType<typeof sweepWorld>>;

const moveTo = (w: SW, iso: string) =>
  w.clock.advance(new Date(iso).getTime() - w.clock.now().getTime());

async function samlRow(w: SW) {
  const idp = await createTestIdp({ alg: "rsa", certificateNotAfter: END });
  return samlConnection(w, w.org, idp);
}

/** `n` member rows of acme at `role`, as `addMember` writes them, one second apart. */
async function members(w: SW, n: number, role: string, prefix: string) {
  for (let i = 0; i < n; i++) {
    const user = await w.seedUser(`${prefix}${i}@acme.example`);
    w.clock.advance(1000);
    const now = w.clock.now();
    await w.storage.create("member", {
      id: newId(now),
      createdAt: now,
      updatedAt: now,
      organizationId: w.org,
      userId: user.id,
      role,
    });
  }
}

async function mailsOf(w: SW, run: () => Promise<unknown>) {
  const before = w.mail.length;
  await run();
  return w.mail.slice(before);
}

const connection = async (w: SW, id: string) =>
  w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: id }]);

/** The days of a notice mail: 30, 7, or 1. */
const daysOf = (text: string) => Number(/(\d+) days?\b/.exec(text)?.[1] ?? Number.NaN);

/** Runs a second full sweep inside the claim of `model`: the race of two sweeps. */
function racing(w: SW, model: string): StorageAdapter {
  let inner: Promise<unknown> | null = null;
  return new Proxy(w.config.storage, {
    get(target, key) {
      if (key === "update")
        return async (...args: Parameters<StorageAdapter["update"]>) => {
          const [m, , changes] = args;
          if (m === model && "expiryStage" in changes && inner === null) {
            inner = sweepExpired(w.config);
            await inner;
          }
          return target.update(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("the expiry notices under attack (plan 13b Task 12)", () => {
  it(
    "stage once: two sweeps a day over 40 days, with a clock that goes back 8 days, send each stage once",
    async () => {
      const w = await sweepWorld();
      const saml = await samlRow(w);
      moveTo(w, "2027-01-06T00:00:00.000Z");
      const token = await createScimToken(w.config, SCIM_APP, {
        organizationId: w.org,
        name: "Okta directory",
        expiresInDays: 40,
      });
      if (!token.ok) throw new Error(token.code);
      recordCredential(token.value.token);
      const start = new Date("2027-01-06T12:00:00.000Z").getTime();
      const times: number[] = [];
      for (let d = 0; d <= 40; d++) {
        times.push(start + d * DAY_MS);
        // Day 12 is after the stage 30 claim (2027-01-16). The clock then goes back 8 days.
        if (d === 12) times.push(start + 4 * DAY_MS, start + 5 * DAY_MS);
      }
      const mails = await mailsOf(w, async () => {
        for (const t of times) {
          moveTo(w, new Date(t).toISOString());
          await sweepExpired(w.config);
          await sweepExpired(w.config);
        }
      });
      const samlMails = mails.filter((m) => m.text.includes("SAML certificate"));
      const tokenMails = mails.filter((m) => m.text.includes("Okta directory"));
      expect(samlMails.map((m) => daysOf(m.text))).toEqual([30, 7, 1]);
      expect(tokenMails.map((m) => daysOf(m.text))).toEqual([30, 7, 1]);
      expect(mails).toHaveLength(6);
      expect(w.calls.filter((c) => c.id === saml)).toHaveLength(3);
      expect(w.calls.filter((c) => c.id === token.value.id)).toHaveLength(3);
      const stages = (await w.events("sso.expiring")).map((e) => [e.rowId, e.stage]);
      expect(stages.filter(([id]) => id === saml).map(([, s]) => s)).toEqual([30, 7, 1]);
      expect(stages.filter(([id]) => id === token.value.id).map(([, s]) => s)).toEqual([30, 7, 1]);
    },
    LONG_TEST_MS,
  );

  it("owner scan at 100 members: one page holds all, so no line says the scan was cut", async () => {
    const w = await sweepWorld();
    // acme has its owner: 99 members more make 100.
    await members(w, 99, "member", "member");
    const id = await samlRow(w);
    moveTo(w, "2027-01-16T00:00:00.000Z");
    const mails = await mailsOf(w, () => sweepExpired(w.config));
    expect(mails.map((m) => m.to)).toEqual(["owner@acme.example"]);
    expect(await w.events("sso.expiring")).toMatchObject([{ rowId: id, mails: 1, ownersCut: 0 }]);
    expect(await w.events("notice.mail_failed")).toEqual([]);
  });

  it("owner scan at 101 members: the owner past the page gets no mail, and one line says so", async () => {
    const w = await sweepWorld();
    await members(w, 99, "member", "member");
    await members(w, 1, "owner", "late");
    const id = await samlRow(w);
    moveTo(w, "2027-01-16T00:00:00.000Z");
    const mails = await mailsOf(w, () => sweepExpired(w.config));
    expect(mails.map((m) => m.to)).toEqual(["owner@acme.example"]);
    expect(await w.events("sso.expiring")).toMatchObject([{ rowId: id, mails: 1, ownersCut: 0 }]);
    expect(await w.events("notice.mail_failed")).toMatchObject([
      { event: "sso_expiring", errorName: "RangeError" },
    ]);
  });

  it("disabled past the end: off at each stage and on after the end, no mail and a null notice date (R15)", async () => {
    const w = await sweepWorld();
    const id = await samlRow(w);
    expect((await updateConnection(w.config, SSO_APP, { id, enabled: false })).ok).toBe(true);
    const mails = await mailsOf(w, async () => {
      for (const iso of [
        "2027-01-16T00:00:00.000Z",
        "2027-02-08T00:00:00.000Z",
        "2027-02-14T00:00:00.000Z",
      ]) {
        moveTo(w, iso);
        expect((await sweepExpired(w.config)).ssoExpiryNotices).toBe(0);
      }
      moveTo(w, "2027-02-16T00:00:00.000Z");
      expect((await updateConnection(w.config, SSO_APP, { id, enabled: true })).ok).toBe(true);
      expect((await sweepExpired(w.config)).ssoExpiryNotices).toBe(0);
    });
    expect([mails, w.calls]).toEqual([[], []]);
    const row = await connection(w, id);
    expect([row?.expiryStage, row?.expiryNoticeAt]).toEqual([null, null]);
  });

  it("disabled until 12 hours before the end: one mail, of stage 1 (R15)", async () => {
    const w = await sweepWorld();
    const id = await samlRow(w);
    expect((await updateConnection(w.config, SSO_APP, { id, enabled: false })).ok).toBe(true);
    moveTo(w, new Date(END.getTime() - 12 * HOUR_MS).toISOString());
    expect((await updateConnection(w.config, SSO_APP, { id, enabled: true })).ok).toBe(true);
    const mails = await mailsOf(w, () => sweepExpired(w.config));
    expect(mails.map((m) => daysOf(m.text))).toEqual([1]);
    const row = await connection(w, id);
    expect([row?.expiryStage, row?.expiryNoticeAt]).toEqual([1, null]);
  });

  it("race: two sweeps at once on a SCIM token and on a setup link send each notice once", async () => {
    const w = await sweepWorld();
    moveTo(w, "2027-01-01T00:00:00.000Z");
    const token = await createScimToken(w.config, SCIM_APP, {
      organizationId: w.org,
      name: "Okta directory",
      expiresInDays: 45,
    });
    if (!token.ok) throw new Error(token.code);
    recordCredential(token.value.token);
    moveTo(w, "2027-01-16T00:00:00.000Z");
    const first = await mailsOf(w, () =>
      sweepExpired({ ...w.config, storage: racing(w, "scimToken") }),
    );
    expect([first.length, w.calls]).toEqual([1, [{ kind: "scim_token", id: token.value.id }]]);
    const link = await createSetupLink(w.config, SSO_APP, {
      organizationId: w.org,
      steps: ["domain"],
      kinds: ["saml"],
      ttlHours: 168,
      note: "IT of Acme",
    });
    if (!link.ok) throw new Error(link.code);
    recordCredential(link.value.token);
    moveTo(w, new Date(link.value.expiresAt.getTime() - DAY_MS).toISOString());
    const second = await mailsOf(w, () =>
      sweepExpired({ ...w.config, storage: racing(w, "ssoSetupLink") }),
    );
    expect(second).toHaveLength(1);
    expect(w.calls).toEqual([
      { kind: "scim_token", id: token.value.id },
      { kind: "setup_link", id: link.value.id },
    ]);
    expect(await w.events("sso.expiring")).toHaveLength(2);
  });
});
