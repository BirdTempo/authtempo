import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import {
  confirmAccountDelete,
  deleteAccount,
  requestAccountDelete,
} from "../src/engine/account-delete.js";
import { deleteUser } from "../src/engine/operator/accounts.js";
import { ORGANIZATION_AUDIT_REASON } from "../src/engine/operator/audit.js";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { OperatorAuditRow, UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { get, recordAddress, recordCredential } from "./helpers.js";
import { type OperatorAuth, operatorFixture, secretActor } from "./operator-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// Plan 13c Task 2 (owner rulings R30 and 2026-11-24): a self account delete writes one
// `organization_member_remove` row in each organization that the user leaves, in the
// transaction of the delete. The row holds no IP and no user agent. The operator delete
// writes none (13b decision 4), and the platform organization gets none (R30).

const APP = { kind: "app", name: "support-tool" } as const;
const MAIL = "mo@example.com";
const IP = recordAddress("203.0.113.9");
const AGENT = recordAddress("agent-of-mo/1.0");
const SUBJECT = "Confirm the delete of your api.example.com account";
const REMOVE = "organization_member_remove";
const ERASURE = recordCredential("operator-erasure-0123456789abcdef-01234");

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** An organization that `owner` makes, with the slug `slug`. Answers its id. */
async function organizationOf(auth: OperatorAuth, owner: UserRow, slug: string): Promise<string> {
  const made = await createOrganization(auth.config, { user: owner, slug, name: slug });
  if (!made.ok) throw new Error(made.code);
  return made.value.organization.id;
}

/** Adds `userId` to `organizationId` with `role`, by `by`. */
async function join(
  auth: OperatorAuth,
  by: UserRow,
  organizationId: string,
  userId: string,
  role: string,
) {
  const added = await addMember(auth.config, { user: by, organizationId, userId, role });
  if (!added.ok) throw new Error(added.code);
}

/** All audit rows, in id order. */
const allRows = (storage: StorageAdapter): Promise<OperatorAuditRow[]> =>
  storage.findMany("operatorAudit", [], { sort: { field: "id", dir: "asc" } });

/**
 * The organizations o1 of a and o2 of b, and the user Mo with no membership. `config` replaces
 * a top key of the auth.
 */
async function world(config: Partial<AuthConfig> = {}) {
  const f = await operatorFixture({ role: null, config });
  const a = await verifiedSession(f.auth, "a@example.com");
  const b = await verifiedSession(f.auth, "b@example.com");
  const o1 = await organizationOf(f.auth, a.user, "o-one");
  const o2 = await organizationOf(f.auth, b.user, "o-two");
  const mo = await verifiedSession(f.auth, MAIL);
  return { ...f, a, b, o1, o2, mo };
}
type W = Awaited<ReturnType<typeof world>>;

/** The audit rows that `act` adds. */
async function rowsAfter(w: W, act: () => Promise<unknown>): Promise<OperatorAuditRow[]> {
  const seen = new Set((await allRows(w.auth.storage)).map((r) => r.id));
  await act();
  return (await allRows(w.auth.storage)).filter((r) => !seen.has(r.id));
}

/** The leave row that each test expects, for the organization and the role. */
const leaveRow = (w: W, organizationId: string, role: string) => ({
  action: REMOVE,
  actorKind: "user",
  actorId: w.mo.user.id,
  targetUserId: w.mo.user.id,
  reason: ORGANIZATION_AUDIT_REASON.organization_member_remove,
  data: { role, self: true, accountDelete: true },
  ip: null,
  userAgent: null,
  organizationId,
});

/**
 * A store that calls `onInsert` for each insert of audit rows, inside a transaction and
 * outside it. A throw of `onInsert` is the throw of the insert.
 */
function auditInserts(inner: StorageAdapter, onInsert: (rows: number) => void): StorageAdapter {
  const wrap = (s: StorageAdapter): StorageAdapter =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "createMany" || prop === "create")
          return (model: string, rows: unknown) => {
            if (model === "operatorAudit") onInsert(Array.isArray(rows) ? rows.length : 1);
            return (target[prop] as (m: string, r: unknown) => unknown).call(target, model, rows);
          };
        if (prop === "transaction")
          return (fn: (tx: StorageAdapter) => Promise<unknown>) =>
            target.transaction((tx) => fn(wrap(tx)));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrap(inner);
}

describe("the leave rows of a self account delete (plan 13c Task 2)", () => {
  it("T2-1 one row for each left organization: member of o1, admin of o2, solo o3", async () => {
    const w = await world();
    await join(w.auth, w.a.user, w.o1, w.mo.user.id, "member");
    await join(w.auth, w.b.user, w.o2, w.mo.user.id, "admin");
    const o3 = await organizationOf(w.auth, w.mo.user, "o-three");
    const rows = await rowsAfter(w, async () => {
      const done = await deleteAccount(w.auth.config, { session: w.mo, ip: null, userAgent: null });
      expect(done.ok).toBe(true);
    });
    const leaves = rows.filter((r) => r.action === REMOVE);
    expect(leaves).toHaveLength(2);
    expect(leaves.find((r) => r.organizationId === w.o1)).toMatchObject(
      leaveRow(w, w.o1, "member"),
    );
    expect(leaves.find((r) => r.organizationId === w.o2)).toMatchObject(leaveRow(w, w.o2, "admin"));
    // The solo organization goes with the account and gets no row.
    expect(rows.filter((r) => r.organizationId === o3)).toEqual([]);
  });

  it("T2-2 plain member and co-owner: role member for o1 and owner for o2", async () => {
    const w = await world();
    await join(w.auth, w.a.user, w.o1, w.mo.user.id, "member");
    await join(w.auth, w.b.user, w.o2, w.mo.user.id, "owner");
    const rows = await rowsAfter(w, async () => {
      const done = await deleteAccount(w.auth.config, { session: w.mo, ip: null, userAgent: null });
      expect(done.ok).toBe(true);
    });
    const leaves = rows.filter((r) => r.action === REMOVE);
    expect(leaves.map((r) => [r.organizationId, r.data?.role]).sort()).toEqual(
      [
        [w.o1, "member"],
        [w.o2, "owner"],
      ].sort(),
    );
  });

  it("T2-3 no IP, no user agent: the direct delete and the mailed confirm", async () => {
    for (const confirm of [false, true]) {
      const w = await world(confirm ? { account: { deleteConfirm: { ttlMinutes: 60 } } } : {});
      await join(w.auth, w.a.user, w.o1, w.mo.user.id, "member");
      await join(w.auth, w.b.user, w.o2, w.mo.user.id, "owner");
      const input = { session: w.mo, ip: IP, userAgent: AGENT };
      const rows = await rowsAfter(w, async () => {
        if (confirm) {
          expect((await requestAccountDelete(w.auth.config, input)).ok).toBe(true);
          const m = [...w.auth.mail].reverse().find((x) => x.to === MAIL && x.subject === SUBJECT);
          const token = decodeURIComponent(
            /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1] ?? "",
          );
          expect((await confirmAccountDelete(w.auth.config, { ...input, token })).ok).toBe(true);
        } else expect((await deleteAccount(w.auth.config, input)).ok).toBe(true);
      });
      const leaves = rows.filter((r) => r.action === REMOVE);
      expect(leaves, `confirm ${confirm}`).toHaveLength(2);
      for (const row of leaves) {
        expect(row.ip).toBeNull();
        expect(row.userAgent).toBeNull();
        const text = JSON.stringify(row);
        for (const value of [MAIL, IP, AGENT]) expect(text).not.toContain(value);
      }
    }
  });

  it("T2-4 platform organization: Mo is a member of it and of o1, and only o1 gets a row", async () => {
    const w = await world();
    await join(w.auth, w.root, w.platformOrg.id, w.mo.user.id, "member");
    await join(w.auth, w.a.user, w.o1, w.mo.user.id, "member");
    const rows = await rowsAfter(w, async () => {
      const done = await deleteAccount(w.auth.config, { session: w.mo, ip: null, userAgent: null });
      expect(done.ok).toBe(true);
    });
    expect(rows.filter((r) => r.action === REMOVE).map((r) => r.organizationId)).toEqual([w.o1]);
  });

  it("T2-5 operator delete: an app and a secret delete Mo, and no organization row comes", async () => {
    for (const by of ["app", "secret"] as const) {
      // The delete needs the scope `delete`, which no secret of the fixture holds.
      const w = await world({
        operator: {
          secrets: [
            { name: "erasure", secretHash: await sha256Hex(ERASURE), scopes: ["users", "delete"] },
          ],
          users: true,
        },
      });
      await join(w.auth, w.a.user, w.o1, w.mo.user.id, "member");
      const actor = by === "app" ? APP : await secretActor(w.auth, ERASURE);
      const rows = await rowsAfter(w, async () => {
        const done = await deleteUser(w.auth.config, {
          actor,
          userId: w.mo.user.id,
          reason: "Ticket 1",
          ip: null,
          userAgent: null,
        });
        expect(done.ok, by).toBe(true);
      });
      expect(
        rows.map((r) => [r.action, r.organizationId]),
        by,
      ).toEqual([["user_delete", null]]);
    }
  });

  it("T2-6 nothing left: Mo has only solo organizations, and no audit insert runs", async () => {
    const w = await world();
    await organizationOf(w.auth, w.mo.user, "o-three");
    await organizationOf(w.auth, w.mo.user, "o-four");
    let inserts = 0;
    const config = {
      ...w.auth.config,
      storage: auditInserts(w.auth.config.storage, () => void inserts++),
    };
    const rows = await rowsAfter(w, async () => {
      const done = await deleteAccount(config, { session: w.mo, ip: null, userAgent: null });
      expect(done.ok).toBe(true);
    });
    expect(rows).toEqual([]);
    expect(inserts).toBe(0);
  });

  it("T2-7 the insert throws: the user, both member rows, the sessions, and no row stay", async () => {
    const w = await world();
    await join(w.auth, w.a.user, w.o1, w.mo.user.id, "member");
    await join(w.auth, w.b.user, w.o2, w.mo.user.id, "owner");
    const byUser = [{ field: "userId", op: "eq", value: w.mo.user.id }] as const;
    const sessions = await w.auth.storage.findMany("session", [...byUser]);
    expect(sessions.length).toBeGreaterThan(0);
    const config = {
      ...w.auth.config,
      storage: auditInserts(w.auth.config.storage, () => {
        throw new Error("the audit insert failed");
      }),
    };
    const rows = await rowsAfter(w, async () => {
      await expect(
        deleteAccount(config, { session: w.mo, ip: null, userAgent: null }),
      ).rejects.toThrow("the audit insert failed");
    });
    expect(rows).toEqual([]);
    expect(
      await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: w.mo.user.id }]),
    ).not.toBeNull();
    expect(await w.auth.storage.findMany("member", [...byUser])).toHaveLength(2);
    expect((await w.auth.storage.findMany("session", [...byUser])).map((s) => s.id)).toEqual(
      sessions.map((s) => s.id),
    );
  });

  it("T2-8 GET /organizations/audit: the owner of o1 reads one leave row of a member", async () => {
    const w = await world();
    await join(w.auth, w.a.user, w.o1, w.mo.user.id, "member");
    await join(w.auth, w.b.user, w.o2, w.mo.user.id, "admin");
    const done = await deleteAccount(w.auth.config, { session: w.mo, ip: IP, userAgent: AGENT });
    expect(done.ok).toBe(true);
    const handle = createRouter(w.auth.config, coreRoutes(w.auth.config));
    const query = new URLSearchParams({ organizationId: w.o1, action: REMOVE });
    const res = await handle(
      get(`/auth/organizations/audit?${query}`, { authorization: `Bearer ${w.a.token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { action: string; actor: { kind: string; id: string | null }; ip: string | null }[];
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      action: REMOVE,
      actor: { kind: "member", id: w.mo.user.id },
      ip: null,
      userAgent: null,
    });
  });
});
