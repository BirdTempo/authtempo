import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { TEST_SECRET } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createAuthClient } from "../src/client/index.js";
import { APIError } from "../src/errors.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { betterAuth } from "../src/server/better-auth.js";
import { mapOptions } from "../src/server/map-options.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";

const BASE = "https://api.example.com";
const S2 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });
const send = async () => {};

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

/** The password options that construct: core needs both mail callbacks whenever passwords are on. */
function passwordOptions(extra: Record<string, unknown> = {}): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: TEST_SECRET,
    database: memoryDatabase(),
    emailAndPassword: { enabled: true, sendResetPassword: send, ...extra },
    emailVerification: { sendVerificationEmail: send },
    authtempo: { passwordHash: fast },
  };
}

const refusalsOf = (options: Record<string, unknown>) => {
  try {
    betterAuth({ baseURL: BASE, database: memoryDatabase(), ...options } as never);
  } catch (e) {
    return String((e as Error).message);
  }
  return "no refusal";
};

describe("the shim and plan 12b", () => {
  it("maps secrets one entry for one entry", () => {
    const m = mapOptions({
      baseURL: BASE,
      secret: TEST_SECRET,
      secrets: [
        { version: 2, value: S2 },
        { version: 1, value: TEST_SECRET },
      ],
      database: memoryDatabase(),
    });
    expect(m.config.secrets).toEqual([
      { version: 2, value: S2 },
      { version: 1, value: TEST_SECRET },
    ]);
    // Better Auth takes secrets with no secret, and so does core.
    expect(refusalsOf({ secrets: [{ version: 2, value: S2 }] })).toBe("no refusal");
    expect(
      mapOptions({
        baseURL: BASE,
        secrets: [{ version: 2, value: S2 }],
        database: memoryDatabase(),
      }).config,
    ).not.toHaveProperty("secret");
  });

  it("refuses version 0 and a version 1 that is not secret, with the path", () => {
    expect(refusalsOf({ secret: TEST_SECRET, secrets: [{ version: 0, value: S2 }] })).toContain(
      "- secrets[0].version: core reads a row from before schema version 9 as version 1; renumber from 1",
    );
    expect(refusalsOf({ secret: TEST_SECRET, secrets: [{ version: 1, value: S2 }] })).toContain(
      "- secrets[0].value: version 1 must be the value of secret",
    );
    expect(refusalsOf({})).toContain("- secret: required");
    // Core checks every other rule of an entry; the error names it.
    expect(refusalsOf({ secrets: [null] })).toContain("- config: secrets[0] must be an object");
  });

  it("names the session cookie __Host-tempo_session and moves the old cookie", async () => {
    const auth = betterAuth(passwordOptions());
    const up = await auth.handler(
      new Request(`${BASE}/api/auth/password/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({
          email: "a@example.com",
          password: "correct horse battery",
          name: "A",
        }),
      }),
    );
    const set = up.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
    expect(set).toMatch(/^__Host-tempo_session=ts_[^;]+; Path=\/;/);
    const token = /^__Host-tempo_session=([^;]+)/.exec(set ?? "")?.[1] ?? "";
    const old = await auth.handler(
      new Request(`${BASE}/api/auth/session`, { headers: { cookie: `tempo_session=${token}` } }),
    );
    expect(old.status).toBe(200);
    expect(old.headers.getSetCookie()).toContain(
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    expect(
      old.headers.getSetCookie().some((c) => c.startsWith(`__Host-tempo_session=${token};`)),
    ).toBe(true);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: `tempo_session=${token}` }),
    });
    expect(session?.user.email).toBe("a@example.com");
    // Better Auth's session.token comes from the shim's own read of the cookie.
    expect(session?.session.token).toBe(token);
  });

  it("keeps Better Auth's sign-up answer: a session for a new address", async () => {
    expect(mapOptions(passwordOptions()).config.password?.uniformSignUp).toBe(false);
    const auth = betterAuth(passwordOptions());
    const r = await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "A" },
      headers: new Headers(),
    });
    expect(r.token).toMatch(/^ts_/);
  });

  it("refuses autoSignIn false alone, and accepts it with requireEmailVerification (Task 15)", () => {
    const alone = refusalsOf({
      secret: TEST_SECRET,
      emailAndPassword: { enabled: true, sendResetPassword: send, autoSignIn: false },
      emailVerification: { sendVerificationEmail: send },
    });
    expect(alone).toContain(
      "- emailAndPassword.autoSignIn: core opens a session at sign-up unless requireEmailVerification is true; with it, an unverified sign-in is refused, as Better Auth does",
    );
    // Better Auth 1.7.2 treats the pair as requireEmailVerification alone
    // (dist/api/routes/sign-up.mjs lines 163 and 164), which the map keeps.
    const pair = {
      ...passwordOptions({ autoSignIn: false, requireEmailVerification: true }),
    };
    expect(refusalsOf(pair as never)).toBe("no refusal");
    expect(mapOptions(pair).config.password?.requireVerified).toBe(true);
    expect(refusalsOf({ secret: TEST_SECRET, emailAndPassword: { autoSignIn: "no" } })).toContain(
      "- emailAndPassword.autoSignIn: expected a boolean",
    );
  });

  it("answers { token: null, user } for autoSignIn false with requireEmailVerification", async () => {
    const auth = betterAuth(passwordOptions({ autoSignIn: false, requireEmailVerification: true }));
    const r = await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "A" },
      headers: new Headers(),
    });
    expect(r.token).toBeNull();
    expect(r.user.email).toBe("a@example.com");
  });

  it("maps disableSignUp on every method to signUp false, and refuses a mix", () => {
    expect(mapOptions(passwordOptions({ disableSignUp: true })).config.signUp).toBe(false);
    // No vote for false: the shim leaves the key out, and core's default is "open".
    expect(mapOptions(passwordOptions()).config.signUp).toBeUndefined();
    expect(
      mapOptions({ baseURL: BASE, secret: TEST_SECRET, database: memoryDatabase() }).config.signUp,
    ).toBeUndefined();
    // Better Auth 1.7.2's per-provider disableSignUp votes too: every method and provider closed.
    const closed = {
      ...passwordOptions({ disableSignUp: true }),
      socialProviders: {
        google: { clientId: "g", clientSecret: "s", disableSignUp: true },
        apple: { clientId: "a", teamId: "T", keyId: "K", privateKey: "P", disableSignUp: true },
      },
    };
    expect(refusalsOf(closed as never)).toBe("no refusal");
    expect(mapOptions(closed).config.signUp).toBe(false);
    // A provider without the key is open, so the set is a mix.
    expect(
      refusalsOf({
        secret: TEST_SECRET,
        emailAndPassword: { enabled: true, sendResetPassword: send, disableSignUp: true },
        emailVerification: { sendVerificationEmail: send },
        socialProviders: {
          google: { clientId: "g", clientSecret: "s", disableSignUp: true },
          github: { clientId: "h", clientSecret: "s" },
        },
      }),
    ).toContain(
      "- disableSignUp: core's signUp rule covers every method; set disableSignUp on every method or on none (true: emailAndPassword, socialProviders.google; not true: socialProviders.github)",
    );
    expect(
      refusalsOf({
        secret: TEST_SECRET,
        socialProviders: {
          google: { clientId: "g", clientSecret: "s", disableImplicitSignUp: true },
        },
      }),
    ).toContain(
      "- socialProviders.google.disableImplicitSignUp: core's signUp rule covers every method; see disableSignUp",
    );
  });

  it("answers Better Auth's EMAIL_PASSWORD_SIGN_UP_DISABLED (400) at a closed sign-up", async () => {
    const auth = betterAuth(passwordOptions({ disableSignUp: true }));
    const e = await auth.api
      .signUpEmail({
        body: { email: "a@example.com", password: "correct horse battery", name: "A" },
        headers: new Headers(),
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(APIError);
    expect((e as APIError).statusCode).toBe(400);
    expect((e as APIError).body.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    // The shim's client names the same code. The status stays core's, as for every client code.
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: async (input, init) => auth.handler(new Request(input, init)),
      },
    });
    const r = await c.signUp.email({
      email: "b@example.com",
      password: "correct horse battery",
      name: "B",
    });
    expect(r.error).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED", status: 403 });
  });
});
