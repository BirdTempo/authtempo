import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { betterAuthPasswordHash } from "../src/hash.js";
import { emailOTP, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { CompatDatabase } from "../src/types.js";

// The shim's own POST paths run core's Origin and Fetch Metadata rules first
// (plan 12a fix wave, final review F1): the account paths, the email OTP
// paths, and the two-factor paths answer in the shim, not in core's router.

const BASE = "https://api.example.com";
const EVIL = "https://evil.example";
const EMAIL = "pat@example.com";
const PASSWORD = "correct horse battery";

async function app() {
  const links: string[] = [];
  const codes: { otp: string }[] = [];
  const callbacks: string[] = [];
  const storage = createMemoryAdapter();
  const database: CompatDatabase = {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage,
    limiter: createMemoryLimiter(systemClock),
  };
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database,
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async ({ token }) => void links.push(token),
      beforeEmailVerification: async (user) => void callbacks.push(`before ${user.email}`),
    },
    user: { changeEmail: { enabled: true } },
    plugins: [
      twoFactor({ accountLockout: { enabled: false } }),
      emailOTP({
        sendVerificationOTP: async (d) => void codes.push(d),
        changeEmail: { enabled: true },
      }),
    ],
    authtempo: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  const post = (path: string, body: unknown, cookie: string, headers: Record<string, string>) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, ...headers },
        body: JSON.stringify(body),
      }),
    );
  const same = { origin: BASE, "sec-fetch-site": "same-origin" };
  await post("/password/sign-up", { email: EMAIL, password: PASSWORD }, "", same);
  await post("/password/verify", { token: links.at(-1) }, "", same);
  const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD }, "", same);
  const set = signIn.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  const cookie = (set ?? "").split(";")[0] ?? "";
  /** Every row of the store, as text: a refused request must leave it as it was. */
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(
        (["user", "identity", "password", "session", "verification", "totp"] as const).map((m) =>
          storage.findMany(m, []),
        ),
      ),
    );
  // The sign-up's own verify ran the before callback; the tests count from here.
  callbacks.length = 0;
  // The password row's id is Better Auth's credential account id: the shim answers its unlink itself.
  const [credential] = await storage.findMany("password", []);
  return { post, cookie, codes, callbacks, snapshot, same, credential: credential?.id ?? "" };
}

/** A shim path of each family, with a body that the shim answers itself. */
function cases(accountId: string): [string, string, unknown][] {
  return [
    ["account", "/unlink-account", { accountId }],
    ["email OTP", "/email-otp/change-email", { newEmail: "new@example.com", otp: "000000" }],
    ["two-factor", "/two-factor/enable", { password: PASSWORD }],
  ];
}

describe("the shim's own POST paths and core's cross-site rules (final review F1)", () => {
  it("answers 403 INVALID_ORIGIN to a foreign Origin and to a cross-site Fetch Metadata post, and changes no row", async () => {
    const a = await app();
    await a.post(
      "/email-otp/request-email-change",
      { newEmail: "new@example.com" },
      a.cookie,
      a.same,
    );
    const before = await a.snapshot();
    const refusals = [
      { origin: EVIL },
      { origin: EVIL, "sec-fetch-site": "cross-site" },
      // No Origin: the Fetch Metadata rule alone refuses it.
      { "sec-fetch-site": "cross-site" },
    ];
    const got: unknown[] = [];
    const want: unknown[] = [];
    for (const [family, path, body] of cases(a.credential)) {
      for (const headers of refusals) {
        const res = await a.post(path, body, a.cookie, headers);
        got.push({ family, headers, status: res.status, body: await res.json() });
        want.push({
          family,
          headers,
          status: 403,
          body: { code: "INVALID_ORIGIN", message: "Invalid origin" },
        });
      }
    }
    expect(got).toEqual(want);
    expect(await a.snapshot()).toBe(before);
    expect(a.callbacks).toEqual([]);
  });

  it("answers INVALID_ORIGIN on a path that core serves and on an unknown path, before the route", async () => {
    const a = await app();
    const before = await a.snapshot();
    const answers: unknown[] = [];
    for (const path of ["/password/sign-in", "/sign-out", "/no-such-path"]) {
      const res = await a.post(path, { email: EMAIL, password: PASSWORD }, a.cookie, {
        origin: EVIL,
      });
      answers.push({ path, status: res.status, body: await res.json() });
    }
    const refused = { code: "INVALID_ORIGIN", message: "Invalid origin" };
    expect(answers).toEqual([
      { path: "/password/sign-in", status: 403, body: refused },
      { path: "/sign-out", status: 403, body: refused },
      { path: "/no-such-path", status: 403, body: refused },
    ]);
    expect(await a.snapshot()).toBe(before);
  });

  it("passes a same-origin post to each family", async () => {
    const a = await app();
    await a.post(
      "/email-otp/request-email-change",
      { newEmail: "new@example.com" },
      a.cookie,
      a.same,
    );
    const before = await a.snapshot();
    const answers: Record<string, number> = {};
    for (const [family, path, body] of cases(a.credential)) {
      const res = await a.post(path, body, a.cookie, a.same);
      answers[family] = res.status;
    }
    // The shim's own answers: the credential unlink, a wrong code, and the enable.
    expect(answers).toEqual({ account: 501, "email OTP": 400, "two-factor": 200 });
    expect(a.callbacks).toEqual([`before ${EMAIL}`]);
    expect(await a.snapshot()).not.toBe(before);
  });
});
