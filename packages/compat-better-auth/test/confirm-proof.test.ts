import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, emailOTP } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";
import { proofCookieOf } from "./proof-helpers.js";

// The sign-up proof through the Better Auth shim (plan 12q Task 1, ruling 11).
// A confirm keeps the sign-up's password only with core's proof cookie
// `__Host-tempo_signup`. The verify-email path passes the request's cookie to
// core, and its answer says `passwordKept`. `api.signUpEmail` answers the
// proof, because a server call has no cookie jar. `api.signInEmail` and
// `api.sendVerificationEmail` read the cookie from `headers`.

const BASE = "https://api.example.com";
const PASSWORD = "correct horse battery";
const PROOF_RE = /^sp_[A-Za-z0-9_-]{43}$/;

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

const hash = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });

/** The shim with the sign-up code of the email code plugin; `codes` collects each code. */
function codeApp() {
  const codes: { email: string; otp: string }[] = [];
  const options: BetterAuthOptions = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memoryDatabase(),
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    plugins: [
      emailOTP({
        overrideDefaultEmailVerification: true,
        sendVerificationOTP: async (d) => void codes.push({ email: d.email, otp: d.otp }),
      }),
      bearer(),
    ],
    authtempo: { passwordHash: hash },
  };
  const auth = betterAuth(options);
  const verifyEmail = (email: string, cookie: string | null) =>
    auth.handler(
      new Request(`${BASE}/api/auth/email-otp/verify-email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ email, otp: codes.findLast((c) => c.email === email)?.otp }),
      }),
    );
  return { auth, verifyEmail };
}

/** The shim with the verify link; `links` collects each mailed token. */
function linkApp(extra: Partial<BetterAuthOptions> = {}) {
  const links: { email: string; token: string }[] = [];
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memoryDatabase(),
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) => void links.push({ email: d.user.email, token: d.token }),
    },
    authtempo: { passwordHash: hash },
    ...extra,
  });
  const confirm = async (email: string, cookie: string) => {
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({ token: links.findLast((l) => l.email === email)?.token ?? "" }),
      }),
    );
    return (await res.json()) as { verified?: boolean; passwordKept?: boolean };
  };
  return { auth, links, confirm };
}

describe("the sign-up proof through the shim (plan 12q Task 1)", () => {
  it("keeps the password at verify-email with the proof cookie, and claims it with none", async () => {
    const { auth, verifyEmail } = codeApp();
    const ada = await auth.api.signUpEmail({
      body: { email: "ada@example.com", password: PASSWORD, name: "Ada" },
    });
    expect(ada.signUpProof).toMatch(PROOF_RE);
    const kept = await verifyEmail("ada@example.com", proofCookieOf(ada));
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ status: true, passwordKept: true });
    expect(
      (await auth.api.signInEmail({ body: { email: "ada@example.com", password: PASSWORD } }))
        .token,
    ).toMatch(/^ts_/);

    await auth.api.signUpEmail({
      body: { email: "bob@example.com", password: PASSWORD, name: "Bob" },
    });
    const claimed = await verifyEmail("bob@example.com", null);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ status: true, passwordKept: false });
    await expect(
      auth.api.signInEmail({ body: { email: "bob@example.com", password: PASSWORD } }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("answers a proof of the same form for a taken address under requireEmailVerification", async () => {
    const { auth } = linkApp({
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async () => {},
      },
    });
    const body = { email: "ada@example.com", password: PASSWORD, name: "Ada" };
    const fresh = await auth.api.signUpEmail({ body });
    const taken = await auth.api.signUpEmail({ body });
    expect([fresh.token, taken.token]).toEqual([null, null]);
    expect(fresh.signUpProof).toMatch(PROOF_RE);
    expect(taken.signUpProof).toMatch(PROOF_RE);
    expect(taken.signUpProof).not.toBe(fresh.signUpProof);
  });

  it("keeps the proof hash at sendVerificationEmail only with the cookie in the headers", async () => {
    const { auth, links, confirm } = linkApp();
    const ada = await auth.api.signUpEmail({
      body: { email: "ada@example.com", password: PASSWORD, name: "Ada" },
    });
    const cookie = proofCookieOf(ada);
    await auth.api.sendVerificationEmail({
      body: { email: "ada@example.com" },
      headers: new Headers({ cookie }),
    });
    // The resend sends after the answer: on Node the inner call runs detached.
    await vi.waitFor(() =>
      expect(links.filter((l) => l.email === "ada@example.com")).toHaveLength(2),
    );
    expect(await confirm("ada@example.com", cookie)).toEqual({
      verified: true,
      passwordKept: true,
    });

    const bob = await auth.api.signUpEmail({
      body: { email: "bob@example.com", password: PASSWORD, name: "Bob" },
    });
    await auth.api.sendVerificationEmail({ body: { email: "bob@example.com" } });
    await vi.waitFor(() =>
      expect(links.filter((l) => l.email === "bob@example.com")).toHaveLength(2),
    );
    // The new link has no proof hash, so even the browser of the sign-up claims.
    expect(await confirm("bob@example.com", proofCookieOf(bob))).toEqual({
      verified: true,
      passwordKept: false,
    });
  });
});
