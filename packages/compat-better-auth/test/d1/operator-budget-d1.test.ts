import { applyD1Migrations, env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// The call budget of the operator session calls on the D1 storage of the
// Better Auth tables (ruling 37 of plan 12f, review M1). D1 Free allows 50
// queries per invocation (D1 limits page updated 21 April 2026, read
// 2026-10-21). The ready check of this storage reads the two versions and
// the indexes of the account table. This test counts each statement that
// reaches the binding, each statement of a batch as one.

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const APP = { kind: "app", name: "support-tool" } as const;
const PASSWORD = "a long passphrase 1";
/** The engine on a new compat storage over `db`, with a `session.afterEnd` hook: one invocation. */
function engine(db: D1Database) {
  const { storage } = betterAuthSchemaStorage({ dialect: "d1", db });
  const auth = createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    // A low iteration count: the test is about the count of statements, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
    hooks: { session: { afterEnd: () => {} } },
  });
  return { auth, storage };
}

/** 60 sessions of one user, made by a sign-up and 59 password sign-ins. Answers the user id. */
async function sixtySessions(email: string): Promise<string> {
  const setup = engine(env.DB);
  const pw = setup.auth.api.password;
  if (!pw) throw new Error("no password api");
  const up = await pw.signUp({ email, password: PASSWORD, ip: null, userAgent: null });
  if (!up.ok) throw new Error(up.code);
  for (let i = 0; i < 59; i++) {
    const r = await pw.signIn({ email, password: PASSWORD, ip: null, userAgent: null });
    if (!r.ok) throw new Error(r.code);
  }
  const user = await setup.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("no user");
  return user.id;
}

describe("the operator session calls on the compat D1 storage (ruling 37 of plan 12f)", () => {
  it("claims the per-invocation query limit of D1, so the operator delete checks its size (ruling 5 of plan 12f2)", () => {
    expect(engine(env.DB).storage.queryLimitPerInvocation).toBe(true);
  });

  it("an endAll of the app with a hook on a new storage sends 50 queries or fewer, the ready check too", async () => {
    await sixtySessions("ada@example.com");
    const { db, count } = counting(env.DB);
    const invocation = engine(db);
    const done = await invocation.auth.api.operator.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    // The ready check, the read, the link read, 42 deletes, and the audit row: 49. The page
    // keeps 1 call for the lock read, which D1 has no need to send (ruling 36).
    expect([done.value.ended, done.value.more, count.queries]).toEqual([42, true, 49]);
    // The counter of the storage holds the ready check too, so it agrees with the binding.
    expect(invocation.storage.statementsSent?.()).toBe(49);
    // The ready check sends 4: the two versions, the index list, and one index.
    expect(await invocation.storage.readyStatements?.()).toBe(4);
  });

  it("an endUser of the app with a hook on a new storage sends 50 queries or fewer", async () => {
    const userId = await sixtySessions("bob@example.com");
    const { db, count } = counting(env.DB);
    const invocation = engine(db);
    const done = await invocation.auth.api.operator.sessions.endUser({
      actor: APP,
      userId,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.more).toBe(true);
    expect(count.queries).toBeLessThanOrEqual(50);
    expect(invocation.storage.statementsSent?.()).toBe(count.queries);
  });
});
