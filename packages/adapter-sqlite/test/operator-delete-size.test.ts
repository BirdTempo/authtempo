import { DatabaseSync } from "node:sqlite";
import { createAuth, type MailMessage } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { applySqliteMigrations, createSqliteAdapter } from "../src/index.js";
import { nodeSqlite } from "../src/node.js";

// The operator delete on node:sqlite has no size check (ruling 5 of plan
// 12f2). Only a store with a per-invocation query limit (D1) answers
// delete_too_large. On D1 a platform operator fits 1 solo organization, and
// 2 refuse (adapter-d1/test/operator-delete-budget.test.ts). This adapter
// runs the D1 code over a local database, and must not claim the limit.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const REASON = { reason: "Ticket 4521", ip: null, userAgent: null };
const open: DatabaseSync[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function world() {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  const driver = nodeSqlite(db);
  await applySqliteMigrations(driver);
  const sent: MailMessage[] = [];
  const storage = createSqliteAdapter(driver);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
  });
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = [...sent].reverse().find((m) => m.to === email)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return s;
  }
  return { auth, storage, signIn };
}

describe("the operator delete on node:sqlite (ruling 5 of plan 12f2)", () => {
  it("a platform operator deletes a user with 1 solo organization and 3 that the user owns with another owner: no per-invocation query limit, so no size check", async () => {
    const w = await world();
    expect(w.storage.queryLimitPerInvocation).toBeUndefined();
    const made = await w.auth.api.operator.createAdmin({
      actor: APP,
      email: "op@example.com",
      reason: "First operator",
      ip: null,
      userAgent: null,
    });
    if (!made.ok) throw new Error(made.code);
    const op = await w.signIn("op@example.com");
    const ada = await w.signIn("ada@example.com");
    const solo = await w.auth.api.createOrganization({
      user: ada.user,
      slug: "solo-0",
      name: "Solo",
    });
    if (!solo.ok) throw new Error(solo.code);
    const ids = [solo.value.organization.id];
    // On D1 a user actor fits 1 solo organization and no organization that the user owns
    // with another owner (the move of 12f2 onto main, 2026-10-25). Here 3 pass.
    const bob = await w.signIn("bob@example.com");
    for (let i = 0; i < 3; i++) {
      const made = await w.auth.api.createOrganization({
        user: bob.user,
        slug: `shared-${i}`,
        name: "Shared",
      });
      if (!made.ok) throw new Error(made.code);
      const joined = await w.auth.api.addMember({
        user: bob.user,
        organizationId: made.value.organization.id,
        userId: ada.user.id,
        role: "owner",
      });
      if (!joined.ok) throw new Error(joined.code);
    }
    const actor = { kind: "user", user: op.user, session: op.session } as const;
    expect(
      await w.auth.api.operator.users.delete({ actor, userId: ada.user.id, ...REASON }),
    ).toEqual({ ok: true, value: { organizations: ids, auditId: expect.any(String) } });
    expect(
      await w.storage.findOne("user", [{ field: "id", op: "eq", value: ada.user.id }]),
    ).toBeNull();
    expect(
      await w.storage.findMany("organization", [{ field: "id", op: "in", value: ids }]),
    ).toEqual([]);
  });
});
