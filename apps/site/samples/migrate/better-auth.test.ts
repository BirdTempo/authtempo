import {
  BetterAuthCompatError,
  betterAuth,
  type CompatDatabase,
} from "@authtempo/compat-better-auth";
import { createMemoryAdapter, createMemoryLimiter, systemClock } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { API, SECRET } from "../support/harness.ts";
import { betterAuthServer } from "./better-auth.ts";

/** A test database: core's memory adapter under the compatibility kind. The app passes its Better Auth tables. */
function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

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
});
