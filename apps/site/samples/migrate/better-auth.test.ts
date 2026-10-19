import {
  BetterAuthCompatError,
  betterAuth,
  type CompatDatabase,
} from "@authtempo/compat-better-auth";
import {
  createMemoryAdapter,
  createMemoryLimiter,
  type StorageAdapter,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { API, SECRET } from "../support/harness.ts";
import { betterAuthServer } from "./better-auth.ts";

/** A test database: core's memory adapter under the compatibility kind. The app passes its Better Auth tables. */
function memoryDatabase(storage: StorageAdapter = createMemoryAdapter()): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage,
    limiter: createMemoryLimiter(systemClock),
  };
}

// Made on 2026-10-10 by hashPassword of @better-auth/utils 0.4.2, the code of
// Better Auth 1.7.2 (the vector of packages/compat-better-auth/test/hash.test.ts).
const BETTER_AUTH_HASH =
  "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3";

describe("move from Better Auth", () => {
  it("serves core's routes under /api/auth and mails the verify link of a sign-up", async () => {
    const mails: { to: string; url: string }[] = [];
    const auth = betterAuthServer({
      database: memoryDatabase(),
      secret: SECRET,
      sendMail: async (to, _subject, url) => {
        mails.push({ to, url });
      },
    });
    const none = await auth.handler(new Request(`${API}/api/auth/session`));
    expect({ status: none.status, body: await none.json() }).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });

    const up = await auth.api.signUpEmail({
      body: { email: "pat@example.com", password: "correct horse battery", name: "Pat" },
    });
    expect(up.token.startsWith("ts_")).toBe(true);
    expect(mails.map((m) => m.to)).toEqual(["pat@example.com"]);
    expect(mails[0]?.url.startsWith(`${API}/api/auth/password/verify?token=pv_`)).toBe(true);
  });

  it("fails at start on an option that core cannot keep, and names it", () => {
    let error: unknown = null;
    try {
      betterAuth({ baseURL: API, secret: SECRET, database: memoryDatabase(), hooks: {} });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BetterAuthCompatError);
    expect((error as BetterAuthCompatError).refusals.map((r) => r.split(":")[0])).toEqual([
      "hooks",
    ]);
  });

  it("keeps an old password row after the alias, and rehashes it at the first right sign-in", async () => {
    // The rows of a Better Auth user with a credential account, as the
    // compatibility storage reads them from the app's tables after the alias.
    const storage = createMemoryAdapter();
    const at = new Date("2026-09-01T00:00:00.000Z");
    await storage.create("user", {
      id: "pat",
      email: "pat@example.com",
      emailVerified: true,
      name: "Pat",
      image: null,
      createdAt: at,
      updatedAt: at,
    });
    await storage.create("password", {
      id: "pat-credential",
      userId: "pat",
      hash: BETTER_AUTH_HASH,
      createdAt: at,
      updatedAt: at,
    });
    const auth = betterAuthServer({
      database: memoryDatabase(storage),
      secret: SECRET,
      sendMail: async () => {},
    });
    const hash = async () =>
      (await storage.findOne("password", [{ field: "userId", op: "eq", value: "pat" }]))?.hash;

    await expect(
      auth.api.signInEmail({
        body: { email: "pat@example.com", password: "correct horse batterz" },
      }),
    ).rejects.toMatchObject({ statusCode: 401, body: { code: "INVALID_EMAIL_OR_PASSWORD" } });
    expect(await hash()).toBe(BETTER_AUTH_HASH);

    const signIn = () =>
      auth.api.signInEmail({
        body: { email: "pat@example.com", password: "correct horse battery" },
      });
    expect((await signIn()).user.id).toBe("pat");
    expect((await hash())?.startsWith("pbkdf2-sha256$")).toBe(true);
    expect((await signIn()).user.id).toBe("pat");
  });
});
