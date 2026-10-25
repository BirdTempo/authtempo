import { describe, expect, it } from "vitest";
import {
  type Auth,
  type AuthConfig,
  createAuth,
  createMemoryAdapter,
  type MailMessage,
  type StorageAdapter,
} from "../src/index.js";

// The account delete on a store with no per-invocation query limit (ruling
// 10 of plan 12f2, L3 and M1). Memory claims no limit, as SQLite,
// Postgres, and MySQL do. So the page of the own sessions ends up to
// END_ALL_LIMIT (500) sessions in the act, for the self delete and for the
// operator delete. More wait on one pending-end row, and the sweep ends
// them. The size check of the self delete runs only with the claim.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;

function world(extra: Partial<AuthConfig> = {}) {
  const storage: StorageAdapter = createMemoryAdapter();
  const sent: MailMessage[] = [];
  const ended: { id: string; reason: string }[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    // Every sign-in passes: the act, not the limit of the sign-in, is under test.
    limiter: { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
    hooks: {
      session: { afterEnd: ({ session, reason }) => void ended.push({ id: session.id, reason }) },
    },
    ...extra,
  });
  return { auth, sent, ended, storage };
}

/** `count` magic link sign-ins of `email`: the token of each session. */
async function signIns(auth: Auth, sent: MailMessage[], email: string, count: number) {
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    tokens.push(r.value.token);
  }
  return tokens;
}

describe("the account delete with no per-invocation query limit (ruling 10 of plan 12f2)", () => {
  for (const kind of ["self", "operator"] as const)
    it(`ends 500 own sessions in the act of the ${kind} delete, and the sweep ends 5 more`, async () => {
      const { auth, sent, ended, storage } = world();
      expect(storage.queryLimitPerInvocation).toBeUndefined();
      const tokens = await signIns(auth, sent, "ada@example.com", 505);
      const me = await auth.api.getSession(tokens.at(-1) ?? "");
      if (!me) throw new Error("no session");
      const userId = me.user.id;
      const solo = await auth.api.createOrganization({ user: me.user, slug: "solo", name: "Solo" });
      if (!solo.ok) throw new Error(solo.code);
      const sessionsOf = () =>
        storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);
      expect((await sessionsOf()).length).toBe(505);
      ended.length = 0;
      const answer =
        kind === "self"
          ? await auth.api.user.delete({ session: me, ip: null, userAgent: null })
          : await auth.api.operator.users.delete({
              actor: APP,
              userId,
              reason: "Ticket 1",
              ip: null,
              userAgent: null,
            });
      expect(answer.ok).toBe(true);
      expect(ended.length).toBe(500);
      expect((await sessionsOf()).length).toBe(5);
      const pending = await storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "session-end" },
        { field: "identifier", op: "eq", value: userId },
      ]);
      expect(pending.map((p) => p.data?.reason)).toEqual(["account_deleted"]);
      // The doors refuse the sessions that stay: the user row is gone.
      for (const token of tokens) expect(await auth.api.getSession(token)).toBeNull();
      await auth.api.sweepExpired();
      expect(await sessionsOf()).toEqual([]);
      expect(ended.length).toBe(505);
      expect(new Set(ended.map((e) => e.id)).size).toBe(505);
      expect(new Set(ended.map((e) => e.reason))).toEqual(new Set(["account_deleted"]));
      expect(
        await storage.findOne("organization", [
          { field: "id", op: "eq", value: solo.value.organization.id },
        ]),
      ).toBeNull();
    }, 120_000);

  /**
   * A user who owns 1 solo organization and 6 with another owner. On D1
   * the act would pass 50 queries (review-12f2-rebase M1). Memory with no
   * claim deletes it. The same store with the claim refuses it before any
   * delete.
   */
  for (const claim of [false, true])
    it(`${claim ? "refuses" : "deletes"} a co-owner of 6 organizations ${claim ? "with" : "with no"} claim of a query limit`, async () => {
      const { auth, sent, storage } = world();
      const [token] = await signIns(auth, sent, "ada@example.com", 1);
      const [other] = await signIns(auth, sent, "bob@example.com", 1);
      const me = await auth.api.getSession(token ?? "");
      const bob = await auth.api.getSession(other ?? "");
      if (!me || !bob) throw new Error("no session");
      const solo = await auth.api.createOrganization({ user: me.user, slug: "solo", name: "Solo" });
      if (!solo.ok) throw new Error(solo.code);
      for (let i = 0; i < 6; i++) {
        const made = await auth.api.createOrganization({
          user: bob.user,
          slug: `shared-${i}`,
          name: "Shared",
        });
        if (!made.ok) throw new Error(made.code);
        const added = await auth.api.addMember({
          user: bob.user,
          organizationId: made.value.organization.id,
          userId: me.user.id,
          role: "owner",
        });
        if (!added.ok) throw new Error(added.code);
      }
      if (claim) storage.queryLimitPerInvocation = true;
      const answer = await auth.api.user.delete({ session: me, ip: null, userAgent: null });
      const user = await storage.findOne("user", [{ field: "id", op: "eq", value: me.user.id }]);
      const members = await storage.findMany("member", [
        { field: "userId", op: "eq", value: me.user.id },
      ]);
      if (claim) {
        expect(answer).toMatchObject({ ok: false, code: "delete_too_large", status: 409 });
        expect([user?.id, members.length]).toEqual([me.user.id, 7]);
        expect(await auth.api.getSession(token ?? "")).not.toBeNull();
      } else {
        expect(answer.ok).toBe(true);
        expect([user, members.length]).toEqual([null, 0]);
      }
    });

  /**
   * The size check with a parallel invocation on the same adapter (ruling
   * 10 M1 of plan 12f2). Another request sends 30 statements while the act
   * reads the member rows, and the meter counts them too. So the worst
   * count of the act's own statements decides, not the meter: the lock,
   * the spend of the link, the read of the proof session, the hold, and
   * the organization rule. The count takes the hold at its worst, 3 calls
   * (MySQL), and D1 sends 1. So the direct delete of an owner of 1 solo
   * organization takes 1 shared organization here, 1 fewer than with no
   * parallel invocation. The confirm takes 1 in both cases. A refusal
   * writes nothing, so a stricter count is safe.
   */
  const EDGE = { direct: 1, confirm: 1 } as const;
  for (const scene of ["direct", "confirm"] as const)
    for (const shared of [EDGE[scene], EDGE[scene] + 1])
      it(`${shared > EDGE[scene] ? "refuses" : "deletes"} a co-owner of ${shared} organizations with a parallel invocation: ${scene}`, async () => {
        const { auth, sent, storage } = world(
          scene === "confirm" ? { account: { deleteConfirm: { ttlMinutes: 60 } } } : {},
        );
        const [token] = await signIns(auth, sent, "ada@example.com", 1);
        const [other] = await signIns(auth, sent, "bob@example.com", 1);
        const me = await auth.api.getSession(token ?? "");
        const bob = await auth.api.getSession(other ?? "");
        if (!me || !bob) throw new Error("no session");
        const solo = await auth.api.createOrganization({
          user: me.user,
          slug: "solo",
          name: "Solo",
        });
        if (!solo.ok) throw new Error(solo.code);
        for (let i = 0; i < shared; i++) {
          const made = await auth.api.createOrganization({
            user: bob.user,
            slug: `shared-${i}`,
            name: "Shared",
          });
          if (!made.ok) throw new Error(made.code);
          const added = await auth.api.addMember({
            user: bob.user,
            organizationId: made.value.organization.id,
            userId: me.user.id,
            role: "owner",
          });
          if (!added.ok) throw new Error(added.code);
        }
        const input = { session: me, ip: null, userAgent: null };
        let link = "";
        if (scene === "confirm") {
          expect(await auth.api.user.delete(input)).toEqual({ ok: true, value: { sent: true } });
          const text = sent.filter((m) => m.to === "ada@example.com").at(-1)?.text ?? "";
          link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
        }
        storage.queryLimitPerInvocation = true;
        const transaction = storage.transaction.bind(storage);
        const byId = [{ field: "id", op: "eq", value: me.user.id }] as const;
        storage.transaction = (fn) =>
          transaction((tx) =>
            fn({
              ...tx,
              findMany: async (model, where, options) => {
                if (model === "member")
                  for (let i = 0; i < 30; i++) await storage.findOne("user", [...byId]);
                return tx.findMany(model, where, options);
              },
            }),
          );
        const answer =
          scene === "direct"
            ? await auth.api.user.delete(input)
            : await auth.api.user.confirmDelete({ ...input, token: link });
        storage.transaction = transaction;
        const user = await storage.findOne("user", [...byId]);
        if (shared > EDGE[scene]) {
          expect(answer).toMatchObject({ ok: false, code: "delete_too_large", status: 409 });
          expect(user?.id).toBe(me.user.id);
          expect(await auth.api.getSession(token ?? "")).not.toBeNull();
        } else {
          expect(answer).toEqual({ ok: true, value: { ok: true } });
          expect(user).toBeNull();
        }
      });
});
