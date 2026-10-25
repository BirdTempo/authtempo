import {
  type AuthConfig,
  createAuth,
  type MailMessage,
  type ResolvedSession,
  type StorageAdapter,
} from "@authtempo/core";
import { expect, it } from "vitest";
import type { CompatDatabase } from "../src/types.js";
import { adminApp } from "./admin-helpers.js";

// Ruling 13 of plan 12f2 (final-12f2-B H1 and M1). On the Better Auth
// tables a user delete cascades to the sessions, the accounts, and the
// member rows, and an organization delete to its member rows. Core's
// account delete must run every check that can refuse, and its session
// pages, before the user delete. The D1 and the Postgres files run this
// suite on their own storage.

const APP = { kind: "app", name: "support-tool" } as const;

/** One store of the suite. */
export interface CascadeStore {
  /** The storage for the scene setup, and the database of the shim. */
  database: CompatDatabase;
  /**
   * The storage of one delete invocation, and its count of queries. D1
   * gives a new storage over a counting binding; Postgres gives the same
   * storage and no count.
   */
  act(): { storage: StorageAdapter; queries(): number | null };
  /**
   * The answer of `/admin/remove-user` of a solo owner by a platform
   * operator. On D1 the least work of that act cannot fit 50 queries, so
   * it answers `delete_too_large` before any write (rulings 5 and 10).
   */
  removeSolo: "removed" | "too_large";
}

/** The rows that name one user, read through core's models. */
export async function rowsOf(storage: StorageAdapter, userId: string, organizationId: string) {
  const byUser = [{ field: "userId", op: "eq", value: userId }] as const;
  return {
    user: (await storage.findOne("user", [{ field: "id", op: "eq", value: userId }])) !== null,
    sessions: (await storage.findMany("session", [...byUser])).length,
    identities: (await storage.findMany("identity", [...byUser])).length,
    passwords: (await storage.findMany("password", [...byUser])).length,
    members: (await storage.findMany("member", [...byUser])).length,
    organization:
      (await storage.findOne("organization", [
        { field: "id", op: "eq", value: organizationId },
      ])) !== null,
  };
}

/** Core on `storage`, with a `session.afterEnd` hook that counts, and the mail in `sent`. */
export function engine(
  storage: StorageAdapter,
  sent: MailMessage[],
  extra: Partial<AuthConfig> = {},
) {
  const ends: string[] = [];
  const auth = createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
    ...extra,
    hooks: { ...extra.hooks, session: { afterEnd: (e) => void ends.push(e.session.id) } },
  });
  return { auth, ends };
}

/** A session of `email` by a magic link: the first one makes a verified user. */
async function signIn(
  auth: ReturnType<typeof engine>["auth"],
  sent: MailMessage[],
  email: string,
): Promise<ResolvedSession> {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  const s = await auth.api.getSession(r.value.token);
  if (!s) throw new Error("no session");
  return s;
}

let scenes = 0;

/** A verified user with `sessions` sessions who owns one organization alone. */
export async function soloOwner(store: CascadeStore, sessions: number) {
  scenes++;
  const sent: MailMessage[] = [];
  const { auth } = engine(store.database.storage, sent);
  const email = `owner${scenes}@example.com`;
  let me = await signIn(auth, sent, email);
  for (let i = 1; i < sessions; i++) me = await signIn(auth, sent, email);
  const made = await auth.api.createOrganization({
    user: me.user,
    slug: `solo-${scenes}`,
    name: `Solo ${scenes}`,
  });
  if (!made.ok) throw new Error(made.code);
  return { auth, sent, me, organizationId: made.value.organization.id };
}

/** The suite of ruling 13 on one store. */
export function accountDeleteCascadeSuite(open: () => Promise<CascadeStore>): void {
  it("marks the storage: a user delete there cascades", async () => {
    const store = await open();
    expect(store.database.storage.userDeleteCascades).toBe(true);
  });

  for (const kind of ["self", "operator"] as const) {
    it(`deletes a solo owner by the ${kind} delete: each session ends with the hook, and no row stays`, async () => {
      const store = await open();
      const { me, organizationId } = await soloOwner(store, 3);
      const before = await rowsOf(store.database.storage, me.user.id, organizationId);
      expect(before).toEqual({
        user: true,
        sessions: 3,
        identities: 1,
        passwords: 0,
        members: 1,
        organization: true,
      });
      const act = store.act();
      const { auth, ends } = engine(act.storage, []);
      const answer =
        kind === "self"
          ? await auth.api.user.delete({ session: me, ip: null, userAgent: null })
          : await auth.api.operator.users.delete({
              actor: APP,
              userId: me.user.id,
              reason: "Ticket 1",
              ip: null,
              userAgent: null,
            });
      expect(answer.ok, JSON.stringify(answer)).toBe(true);
      expect(ends).toHaveLength(3);
      expect(await rowsOf(store.database.storage, me.user.id, organizationId)).toEqual({
        user: false,
        sessions: 0,
        identities: 0,
        passwords: 0,
        members: 0,
        organization: false,
      });
      const queries = act.queries();
      if (queries !== null) expect(queries).toBeLessThanOrEqual(50);
    });

    it(`keeps every row when the ${kind} delete refuses after the lock`, async () => {
      // A member joins the solo organization after the organization rule
      // read it, through the product's own add. The member delete then
      // matches two rows, and the act answers conflict.
      const store = await open();
      const { auth: setup, sent, me, organizationId } = await soloOwner(store, 3);
      const other = await signIn(setup, sent, `joiner${scenes}@example.com`);
      const before = await rowsOf(store.database.storage, me.user.id, organizationId);
      const act = store.act();
      let joined = false;
      const { auth, ends } = engine(act.storage, [], {
        hooks: {
          user: {
            beforeDelete: async () => {
              if (joined) return;
              joined = true;
              const added = await setup.api.addMember({
                user: me.user,
                organizationId,
                userId: other.user.id,
                role: "member",
              });
              if (!added.ok) throw new Error(added.code);
            },
          },
        },
      });
      const answer =
        kind === "self"
          ? await auth.api.user.delete({ session: me, ip: null, userAgent: null })
          : await auth.api.operator.users.delete({
              actor: APP,
              userId: me.user.id,
              reason: "Ticket 2",
              ip: null,
              userAgent: null,
            });
      expect(joined).toBe(true);
      expect(answer).toMatchObject({ ok: false, code: "conflict" });
      expect(ends).toEqual([]);
      expect(await rowsOf(store.database.storage, me.user.id, organizationId)).toEqual(before);
    });
  }

  it("removes through /admin/remove-user a member and a solo owner, or refuses the owner before any write", async () => {
    const store = await open();
    const a = await adminApp(store.database);
    const rowOf = async (id: string) => {
      const row = await store.database.storage.findOne("user", [
        { field: "id", op: "eq", value: id },
      ]);
      if (!row) throw new Error("no user");
      return row;
    };
    const organizationOf = async (id: string, slug: string) => {
      const made = await a.auth.tempo.api.createOrganization({
        user: await rowOf(id),
        slug,
        name: slug,
      });
      if (!made.ok) throw new Error(made.code);
      return made.value.organization.id;
    };
    const gone = {
      user: false,
      sessions: 0,
      identities: 0,
      passwords: 0,
      members: 0,
    };
    // Bea is a member of Cy's organization.
    const bea = await a.user("bea@example.com");
    const cy = await a.user("cy@example.com");
    const cyCo = await organizationOf(cy.id, "cy-co");
    const added = await a.auth.tempo.api.addMember({
      user: await rowOf(cy.id),
      organizationId: cyCo,
      userId: bea.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    expect(await rowsOf(store.database.storage, bea.id, cyCo)).toMatchObject({
      user: true,
      passwords: 1,
      members: 1,
    });
    const removedBea = await a.call("/admin/remove-user", { userId: bea.id }, a.op);
    expect([removedBea.status, await removedBea.json()]).toEqual([200, { success: true }]);
    expect(await rowsOf(store.database.storage, bea.id, cyCo)).toEqual({
      ...gone,
      organization: true,
    });
    // Ann owns her organization alone.
    const ann = await a.user("ann@example.com");
    const annCo = await organizationOf(ann.id, "ann-co");
    const before = await rowsOf(store.database.storage, ann.id, annCo);
    expect(before).toMatchObject({ user: true, passwords: 1, members: 1, organization: true });
    const removed = await a.call("/admin/remove-user", { userId: ann.id }, a.op);
    if (store.removeSolo === "too_large") {
      expect([removed.status, await removed.json()]).toEqual([
        409,
        { code: "DELETE_TOO_LARGE", message: "Delete too large" },
      ]);
      expect(await rowsOf(store.database.storage, ann.id, annCo)).toEqual(before);
      return;
    }
    expect([removed.status, await removed.json()]).toEqual([200, { success: true }]);
    expect(await rowsOf(store.database.storage, ann.id, annCo)).toEqual({
      ...gone,
      organization: false,
    });
  });
}
