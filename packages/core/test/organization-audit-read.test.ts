import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, OrganizationsConfig } from "../src/config.js";
import { deleteUser } from "../src/engine/operator/accounts.js";
import {
  listOrganizationAudit,
  organizationAuditDraft,
  writeAuditIn,
} from "../src/engine/operator/audit.js";
import { banUser } from "../src/engine/operator/ban.js";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import { createScimToken } from "../src/engine/scim/tokens.js";
import { resolveSession } from "../src/engine/sessions.js";
import { addDomain, deleteDomain, enforceOff, updateDomain } from "../src/engine/sso/domains.js";
import { requireSsoManager, type SsoActor } from "../src/engine/sso/guard.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
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
import { SCIM_APP, scim } from "./scim/helpers.js";
import { SSO_APP, ssoAuth, verifiedDomain } from "./sso/helpers.js";
import { enrolled, PASSWORD } from "./totp-helpers.js";

// Plan 13b Task 6: GET /organizations/audit, and the organization filter of GET /operator/audit.

const META = {
  ip: recordAddress("198.51.100.9"),
  userAgent: recordAddress("organization-audit-read-test"),
};
const DAY_MS = 86_400_000;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const ALL_MEMBER = ["read", "create", "update", "delete"];

/** The `roles` form: the owner and `auditor` hold `audit:read`; `member` does not. */
const ROLES: OrganizationsConfig = {
  roles: {
    owner: {
      rank: 3,
      permissions: {
        organization: ["update", "delete"],
        member: ALL_MEMBER,
        invitation: ["read", "create", "cancel"],
        apiToken: ["read", "create", "update", "revoke"],
        audit: ["read"],
      },
    },
    auditor: { rank: 1, permissions: { member: ["read"], audit: ["read"] } },
    member: { rank: 1, permissions: { member: ["read"] } },
  },
};

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/**
 * Two organizations: `o1` of `owner@acme.example` and `o2` of `owner@beta.example`. Each owner
 * has a second factor and a fresh session. The operator tools and one secret with the scopes
 * `audit`, `sso`, and `users` are on. `organizations` replaces the `ranks` form of `ssoAuth`;
 * the impersonation is on only in the `ranks` form.
 */
async function world(organizations?: OrganizationsConfig) {
  const extra: Partial<AuthConfig> = {
    password: { hash: FAST, uniformSignUp: false },
    scim: {},
    operator: {
      secrets: [
        {
          name: "audit",
          secretHash: await sha256Hex(recordCredential(OPERATOR_SECRETS.audit)),
          // `users` too: the roles form has no platform role, and the user tools need an actor.
          scopes: ["audit", "sso", "users"],
        },
      ],
      users: true,
      // The impersonation needs the platform role of the `ranks` form.
      ...(organizations === undefined ? { impersonation: {} } : {}),
    },
    ...(organizations === undefined ? {} : { organizations }),
  };
  const w = ssoAuth(extra);
  const owner = (await enrolled(w, "owner@acme.example")).session;
  const other = (await enrolled(w, "owner@beta.example")).session;
  const o1 = await organizationOf(w, owner.user, "acme");
  const o2 = await organizationOf(w, other.user, "beta");
  return { ...w, owner, other, o1, o2 };
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
  return s;
}

/** The actor that the manager guard gives for a session token, as a route gets it. */
async function guarded(w: W, token: string, organizationId: string): Promise<SsoActor> {
  const resolved = await resolveSession(w.config, token);
  if (!resolved) throw new Error("the session ended");
  const r = await requireSsoManager(w.config, resolved, organizationId);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/**
 * A platform operator who owns no organization, through the flows of the product (the pattern
 * of organization-audit-column.test.ts). The answer holds the guard's actor for `o1` and the
 * session token.
 */
async function platformOperator(w: W) {
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
  const token = (await enrolled(w, OPERATOR_EMAIL)).session.token;
  const actor = await guarded(w, token, w.o1);
  if (actor.kind !== "platform") throw new Error(`the guard gave ${actor.kind}`);
  return { actor, token };
}

/** One `sso_domain_add` row: the actor adds `domain` to `organizationId`. Answers the domain id. */
async function domainOf(
  w: W,
  actor: SsoActor,
  organizationId: string,
  domain: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<string> {
  const added = await addDomain(w.config, actor, { organizationId, domain, ...meta });
  if (!added.ok) throw new Error(added.code);
  return added.value.id;
}

/** One `sso_domain_update` row by the app. */
async function touch(w: W, id: string): Promise<void> {
  const r = await updateDomain(w.config, SSO_APP, { id, includeSubdomains: true });
  if (!r.ok) throw new Error(r.code);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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
interface Page {
  rows: View[];
  next: string | null;
}

/** GET /organizations/audit with the query, by the bearer `token`. */
async function read(w: W, token: string, query: Record<string, string>) {
  const res = await w.handle(
    get(`/auth/organizations/audit?${new URLSearchParams(query)}`, bearer(token)),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A read that must answer 200: the page. */
async function page(w: W, token: string, query: Record<string, string>): Promise<Page> {
  const r = await read(w, token, query);
  if (r.status !== 200) throw new Error(`the read answered ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as unknown as Page;
}

/** The ids of the stored audit rows of an organization, by id. */
async function storedIds(w: W, organizationId: string): Promise<string[]> {
  const rows = await w.storage.findMany(
    "operatorAudit",
    [{ field: "organizationId", op: "eq", value: organizationId }],
    { sort: { field: "id", dir: "asc" } },
  );
  return rows.map((r) => r.id);
}

/** The one row of the answer with this action. */
function rowOf(p: Page, action: string): View {
  const rows = p.rows.filter((r) => r.action === action);
  if (rows.length !== 1) throw new Error(`${rows.length} rows of ${action}`);
  return rows[0] as View;
}

const FORBIDDEN = { status: 403, body: { error: "forbidden_rank" } };

describe("GET /organizations/audit (plan 13b Task 6)", () => {
  it("owner reads: 3 rows of o1 by id ascending, and next null", async () => {
    const w = await world();
    const id = await domainOf(w, SSO_APP, w.o1, "acme.example");
    await touch(w, id);
    await touch(w, id);
    const p = await page(w, w.owner.token, { organizationId: w.o1 });
    expect(p.rows.map((r) => r.action)).toEqual([
      "sso_domain_add",
      "sso_domain_update",
      "sso_domain_update",
    ]);
    const ids = p.rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(await storedIds(w, w.o1));
    expect(p.next).toBeNull();
  });

  it(
    "page: 120 rows read as 50, 50, and 20, with next null on the last page",
    async () => {
      const w = await world();
      const id = await domainOf(w, SSO_APP, w.o1, "acme.example");
      for (let i = 0; i < 119; i++) await touch(w, id);
      const first = await page(w, w.owner.token, { organizationId: w.o1, limit: "50" });
      expect(first.rows).toHaveLength(50);
      expect(first.next).toBe(first.rows.at(-1)?.id);
      const second = await page(w, w.owner.token, {
        organizationId: w.o1,
        limit: "50",
        after: first.next ?? "",
      });
      expect(second.rows).toHaveLength(50);
      expect(second.next).toBe(second.rows.at(-1)?.id);
      const last = await page(w, w.owner.token, {
        organizationId: w.o1,
        limit: "50",
        after: second.next ?? "",
      });
      expect(last.rows).toHaveLength(20);
      expect(last.next).toBeNull();
      const ids = [...first.rows, ...second.rows, ...last.rows].map((r) => r.id);
      expect(ids).toEqual(await storedIds(w, w.o1));
      expect(ids).toHaveLength(120);
    },
    LONG_TEST_MS,
  );

  it("filters: rows of 3 actions over 3 days; action, from (inclusive), and to (exclusive)", async () => {
    const w = await world();
    const days: string[] = [];
    for (const n of [1, 2, 3]) {
      w.clock.advance(DAY_MS);
      days.push(w.clock.now().toISOString());
      const id = await domainOf(w, SSO_APP, w.o1, `day${n}.example`);
      await touch(w, id);
      const gone = await deleteDomain(w.config, SSO_APP, { id });
      if (!gone.ok) throw new Error(gone.code);
    }
    const [day1, day2, day3] = days as [string, string, string];
    const all = await page(w, w.owner.token, { organizationId: w.o1 });
    expect(all.rows).toHaveLength(9);
    const updates = await page(w, w.owner.token, {
      organizationId: w.o1,
      action: "sso_domain_update",
    });
    expect(updates.rows.map((r) => [r.action, r.at])).toEqual([
      ["sso_domain_update", day1],
      ["sso_domain_update", day2],
      ["sso_domain_update", day3],
    ]);
    // `from` is the time of the day 2 rows and `to` the time of the day 3 rows.
    const window = await page(w, w.owner.token, { organizationId: w.o1, from: day2, to: day3 });
    expect(window.rows.map((r) => [r.action, r.at])).toEqual([
      ["sso_domain_add", day2],
      ["sso_domain_update", day2],
      ["sso_domain_delete", day2],
    ]);
    const both = await page(w, w.owner.token, {
      organizationId: w.o1,
      action: "sso_domain_delete",
      from: day1,
      to: day3,
    });
    expect(both.rows.map((r) => [r.action, r.at])).toEqual([
      ["sso_domain_delete", day1],
      ["sso_domain_delete", day2],
    ]);
  });

  it("other org: a member of o1 reads o2 and gets the answer of a non-member; no row of o2", async () => {
    const w = await world();
    await domainOf(w, SSO_APP, w.o1, "acme.example");
    await domainOf(w, SSO_APP, w.o2, "beta.example");
    const invitations = await w.handle(
      get(`/auth/organizations/invitations?organizationId=${w.o2}`, bearer(w.owner.token)),
    );
    const nonMember = { status: invitations.status, body: await invitations.json() };
    expect(nonMember).toEqual(FORBIDDEN);
    expect(await read(w, w.owner.token, { organizationId: w.o2 })).toEqual(nonMember);
    // The read of o1 holds no row of o2.
    const own = await page(w, w.owner.token, { organizationId: w.o1 });
    expect(own.rows.map((r) => r.data?.organizationId)).toEqual([w.o1]);
    expect(own.rows.map((r) => r.id)).toEqual(await storedIds(w, w.o1));
  });

  it("admin: an admin of o1 gets the refusal of a missing permission", async () => {
    const w = await world();
    await domainOf(w, SSO_APP, w.o1, "acme.example");
    const admin = await memberOf(w, w.owner.user, w.o1, "admin@acme.example", "admin");
    expect(await read(w, admin.session.token, { organizationId: w.o1 })).toEqual(FORBIDDEN);
  });

  it("roles form: a custom role with audit:read reads the rows", async () => {
    const w = await world(ROLES);
    await domainOf(w, SSO_APP, w.o1, "acme.example");
    const auditor = await memberOf(w, w.owner.user, w.o1, "auditor@acme.example", "auditor");
    const p = await page(w, auditor.session.token, { organizationId: w.o1 });
    expect(p.rows.map((r) => r.id)).toEqual(await storedIds(w, w.o1));
    expect(rowOf(p, "sso_domain_add").actor).toEqual({ kind: "app", id: "sso-test", email: null });
    // A role without audit:read is refused.
    const plain = await memberOf(w, w.owner.user, w.o1, "plain@acme.example", "member");
    expect(await read(w, plain.session.token, { organizationId: w.o1 })).toEqual(FORBIDDEN);
  });

  it("token caller: an organization token with audit:read is refused (session only)", async () => {
    const w = await world(ROLES);
    await domainOf(w, SSO_APP, w.o1, "acme.example");
    const res = await w.handle(
      post(
        "/auth/organizations/tokens",
        { organizationId: w.o1, name: "audit-reader", permissions: { audit: ["read"] } },
        bearer(w.owner.token),
      ),
    );
    expect(res.status).toBe(200);
    const made = (await res.json()) as { token: string; apiToken: { permissions: unknown } };
    recordCredential(made.token);
    expect(made.apiToken.permissions).toEqual({ audit: ["read"] });
    expect(await read(w, made.token, { organizationId: w.o1 })).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("member view: an owner act shows member, the address, the IP, and the user agent", async () => {
    const w = await world();
    const owner = await guarded(w, w.owner.token, w.o1);
    expect(owner.kind).toBe("owner");
    await domainOf(w, owner, w.o1, "acme.example", META);
    const row = rowOf(await page(w, w.owner.token, { organizationId: w.o1 }), "sso_domain_add");
    expect(row.actor).toEqual({ kind: "member", id: w.owner.user.id, email: "owner@acme.example" });
    expect([row.ip, row.userAgent]).toEqual([META.ip, META.userAgent]);
  });

  it("platform view: a platform operator act shows platform, with no IP and no user agent", async () => {
    const w = await world();
    const { actor } = await platformOperator(w);
    await domainOf(w, actor, w.o1, "acme.example", META);
    const [stored] = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "sso_domain_add" },
    ]);
    // The row keeps the IP; the view hides it.
    expect(stored?.ip).toBe(META.ip);
    const row = rowOf(await page(w, w.owner.token, { organizationId: w.o1 }), "sso_domain_add");
    expect(row.actor).toEqual({ kind: "platform", id: null, email: null });
    expect([row.ip, row.userAgent]).toEqual([null, null]);
  });

  it("secret view: an act of an operator secret shows platform, with no IP", async () => {
    const w = await world();
    const domainId = await verifiedDomain(w, w.o1);
    const secret = await secretActor(w, OPERATOR_SECRETS.audit);
    const off = await enforceOff(w.config, secret, {
      domainId,
      reason: "the IdP is down",
      ...META,
    });
    expect(off.ok).toBe(true);
    const row = rowOf(await page(w, w.owner.token, { organizationId: w.o1 }), "sso_enforce_off");
    expect(row.actor).toEqual({ kind: "platform", id: null, email: null });
    expect([row.ip, row.userAgent]).toEqual([null, null]);
  });

  it("scim view: a directory act shows scim with the token name, and no IP", async () => {
    const w = await world();
    await verifiedDomain(w, w.o1);
    const made = await createScimToken(w.config, SCIM_APP, { organizationId: w.o1, name: "dir-1" });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const res = await scim(w, made.value.token, "POST", "/Users", {
      schemas: [USER_URN],
      userName: "ada@acme.example",
    });
    expect(res.status).toBe(201);
    const row = rowOf(await page(w, w.owner.token, { organizationId: w.o1 }), "scim_user_create");
    expect(row.actor).toEqual({ kind: "scim", id: "dir-1", email: null });
    expect([row.ip, row.userAgent]).toEqual([null, null]);
  });

  it("app view: an act of the app shows app with the app name, and no IP", async () => {
    const w = await world();
    await domainOf(w, SSO_APP, w.o1, "acme.example", META);
    const row = rowOf(await page(w, w.owner.token, { organizationId: w.o1 }), "sso_domain_add");
    expect(row.actor).toEqual({ kind: "app", id: "sso-test", email: null });
    expect([row.ip, row.userAgent]).toEqual([null, null]);
  });

  it("gone user: the actor deleted the account; actor.email is null and the row stays", async () => {
    const w = await world();
    const second = await memberOf(w, w.owner.user, w.o1, "second@acme.example", "owner");
    const actor = await guarded(w, second.session.token, w.o1);
    expect(actor.kind).toBe("owner");
    await domainOf(w, actor, w.o1, "acme.example", META);
    const gone = await deleteUser(w.config, {
      actor: { kind: "app", name: "support-tool" },
      userId: second.user.id,
      reason: "the user asked for the delete",
      ip: null,
      userAgent: null,
    });
    expect(gone.ok).toBe(true);
    expect(
      await w.storage.findOne("user", [{ field: "id", op: "eq", value: second.user.id }]),
    ).toBe(null);
    const row = rowOf(await page(w, w.owner.token, { organizationId: w.o1 }), "sso_domain_add");
    expect(row.actor).toEqual({ kind: "member", id: second.user.id, email: null });
  });

  it("no rows before 18: an o1 row with a null column is not in the answer", async () => {
    const w = await world();
    // A row as the writer of version 17 wrote it: the organization in `data` only.
    const old = organizationAuditDraft(SSO_APP, w.o1, {
      action: "sso_domain_add",
      targetUserId: null,
      data: { organizationId: w.o1, domain: "old.example" },
      ip: null,
      userAgent: null,
    });
    if (!old.ok) throw new Error(old.code);
    await writeAuditIn(w.storage, { ...old.value, organizationId: null }, w.clock.now());
    await domainOf(w, SSO_APP, w.o1, "acme.example");
    const p = await page(w, w.owner.token, { organizationId: w.o1 });
    expect(p.rows.map((r) => r.data?.domain)).toEqual(["acme.example"]);
  });

  it("impersonation: an impersonation session of the owner gets the answer of the owner", async () => {
    const w = await world();
    await domainOf(w, SSO_APP, w.o1, "acme.example");
    const operator = await platformOperator(w);
    const started = await w.handle(
      post(
        "/auth/operator/impersonate",
        { userId: w.owner.user.id, reason: "Ticket 9: a support call" },
        { cookie: `__Host-tempo_session=${operator.token}` },
      ),
    );
    expect(started.status).toBe(200);
    const line = started.headers.getSetCookie().find((s) => s.startsWith("__Host-tempo_session="));
    const token = recordCredential(line?.slice("__Host-tempo_session=".length).split(";")[0] ?? "");
    expect((await resolveSession(w.config, token))?.session.actorId).toBe(operator.actor.user.id);
    const own = await read(w, w.owner.token, { organizationId: w.o1 });
    expect(own.status).toBe(200);
    expect(await read(w, token, { organizationId: w.o1 })).toEqual(own);
  });

  it("a bad query answers invalid_body, through the route and in process", async () => {
    const w = await world();
    for (const query of [
      {},
      { organizationId: w.o1, limit: "0" },
      { organizationId: w.o1, limit: "101" },
      { organizationId: w.o1, action: "ban" },
      { organizationId: w.o1, from: "2026-01-02T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      { organizationId: w.o1, extra: "x" },
    ])
      expect([query, await read(w, w.owner.token, query)]).toEqual([
        query,
        { status: 400, body: { error: "invalid_body" } },
      ]);
    for (const input of [
      { limit: 0 },
      { limit: 1.5 },
      { action: "ban" },
      { from: new Date("2026-01-02T00:00:00Z"), to: new Date("2026-01-01T00:00:00Z") },
      { from: new Date(Number.NaN) },
    ])
      expect(
        await listOrganizationAudit(w.config, {
          session: w.owner,
          organizationId: w.o1,
          ...input,
        }),
      ).toEqual(expect.objectContaining({ ok: false, code: "invalid_body" }));
  });
});

describe("GET /operator/audit?organizationId= (plan 13b Task 6)", () => {
  it("operator filter: the operator reads the rows of o1 with every field", async () => {
    const w = await world();
    const owner = await guarded(w, w.owner.token, w.o1);
    await domainOf(w, owner, w.o1, "acme.example", META);
    await domainOf(w, SSO_APP, w.o2, "beta.example");
    const bob = await w.seedUser("bob@example.com");
    const banned = await banUser(w.config, {
      actor: SSO_APP,
      userId: bob.id,
      reason: "the user broke the rules",
      ip: null,
      userAgent: null,
    });
    expect(banned.ok).toBe(true);
    const res = await w.handle(
      get(`/auth/operator/audit?organizationId=${w.o1}`, operatorHeader(OPERATOR_SECRETS.audit)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Record<string, unknown>[]; next: string | null };
    const stored = await w.storage.findMany(
      "operatorAudit",
      [{ field: "organizationId", op: "eq", value: w.o1 }],
      { sort: { field: "id", dir: "asc" } },
    );
    expect(stored).toHaveLength(1);
    expect(body).toEqual({ rows: JSON.parse(JSON.stringify(stored)), next: null });
    expect(body.rows[0]).toMatchObject({
      actorKind: "user",
      actorId: w.owner.user.id,
      organizationId: w.o1,
      ip: META.ip,
      userAgent: META.userAgent,
    });
  });
});
