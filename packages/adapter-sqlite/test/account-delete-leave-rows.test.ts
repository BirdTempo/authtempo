import { DatabaseSync } from "node:sqlite";
import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { applySqliteMigrations, createSqliteAdapter } from "../src/index.js";
import { nodeSqlite } from "../src/node.js";

// The leave rows of a self account delete on node:sqlite (plan 13c Task 2).
// The rows go in the transaction of the delete. A step after their insert
// that fails takes them back with the member delete.

const open: DatabaseSync[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/**
 * A store that throws on the first write of a session after the first insert
 * of audit rows: a later step of the delete fails. `state` tells what ran.
 */
function failing(inner: StorageAdapter) {
  const state = { inserted: false, thrown: false };
  const wrap = (s: StorageAdapter): StorageAdapter =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "transaction")
          return (fn: (tx: StorageAdapter) => Promise<unknown>) =>
            target.transaction((tx) => fn(wrap(tx)));
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const [model] = args;
          if (model === "operatorAudit" && (prop === "create" || prop === "createMany"))
            state.inserted = true;
          else if (
            state.inserted &&
            !state.thrown &&
            model === "session" &&
            !/^(find|count)/.test(String(prop))
          ) {
            state.thrown = true;
            throw new Error("a later step failed");
          }
          return value.apply(target, args);
        };
      },
    });
  return { storage: wrap(inner), state };
}

async function world() {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  const driver = nodeSqlite(db);
  await applySqliteMigrations(driver);
  const sent: MailMessage[] = [];
  const storage = createSqliteAdapter(driver);
  const make = (s: StorageAdapter) =>
    createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: s,
      limiter: { allow: async () => true },
      mail: { send: async (m) => void sent.push(m) },
      organizations: {},
    });
  const auth = make(storage);
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = [...sent].reverse().find((m) => m.to === email)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return { ...s, token: r.value.token };
  }
  return { auth, storage, make, signIn };
}

describe("the leave rows of a self account delete on node:sqlite (plan 13c Task 2)", () => {
  it("a later step throws after the insert: the user, the member rows, the session, and no leave row stay", async () => {
    const w = await world();
    const ada = await w.signIn("ada@example.com");
    const bob = await w.signIn("bob@example.com");
    // A plain membership and a co-owned organization: 2 leave rows.
    for (const [slug, role] of [
      ["shared-0", "member"],
      ["shared-1", "owner"],
    ] as const) {
      const made = await w.auth.api.createOrganization({ user: bob.user, slug, name: slug });
      if (!made.ok) throw new Error(made.code);
      const added = await w.auth.api.addMember({
        user: bob.user,
        organizationId: made.value.organization.id,
        userId: ada.user.id,
        role,
      });
      if (!added.ok) throw new Error(added.code);
    }
    // The setup writes audit rows too (the member adds).
    const before = (await w.storage.findMany("operatorAudit", [])).map((r) => r.id);
    const { storage, state } = failing(w.storage);
    await expect(
      w.make(storage).api.user.delete({ session: ada, ip: null, userAgent: null }),
    ).rejects.toThrow("a later step failed");
    // The insert ran, and the throw came after it.
    expect(state).toEqual({ inserted: true, thrown: true });
    expect((await w.storage.findMany("operatorAudit", [])).map((r) => r.id)).toEqual(before);
    const byUser = [{ field: "userId", op: "eq", value: ada.user.id }] as const;
    expect(
      await w.storage.findOne("user", [{ field: "id", op: "eq", value: ada.user.id }]),
    ).not.toBeNull();
    expect(await w.storage.findMany("member", [...byUser])).toHaveLength(2);
    expect(await w.auth.api.getSession(ada.token)).not.toBeNull();
  });
});
