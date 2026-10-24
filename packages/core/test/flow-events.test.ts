import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { confirmEmailChange, requestEmailChange } from "../src/engine/email-change.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { SESSION_VIA, type SessionVia } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  deletePasskey,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { reauthenticate } from "../src/engine/reauth.js";
import { disableMethod, enableEmailMethod } from "../src/engine/second-factor-methods.js";
import { revokeSession } from "../src/engine/session-list.js";
import { destroySession, resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import {
  disableTotp,
  disableTotpWithCode,
  regenerateBackupCodes,
  regenerateBackupCodesWithCode,
  verifyTwoFactor,
} from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { AuthEvent } from "../src/observe/port.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { post, tokenFromMail } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, GOOGLE, tokenEndpoint } from "./social-helpers.js";
import { acmeWithSso, ssoSignIn, ssoSignInWorld } from "./sso/sign-in-helpers.js";
import {
  type Auth,
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
  wrongFor,
} from "./totp-helpers.js";

// Plan 12h Task 5 (spec 31 item 6): the sign-in, sign-up, sign-out, session, and factor events.

const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
const NEW_PASSWORD = "a new password for ada";

/**
 * The engine view with the password, the second factor, the magic link, the
 * email code, social, passkeys, the handoff, and a recording sink. The
 * engine flows are the ones that the routes and `api.*` call. `events()`
 * flushes and answers every event so far.
 */
function world(observe: Partial<AuthConfig["observe"]> = {}, extra: Partial<AuthConfig> = {}) {
  const batches: AuthEvent[][] = [];
  const tokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = tokenEndpoint("idtok-default");
  const auth = totpAuth({
    social: { google: GOOGLE, fetch: fetchFn },
    jwt: fakeJwt(tokens),
    passkey: RP,
    handoff: { schemes: ["consumera://"] },
    observe: { sink: { write: (b) => void batches.push([...b]) }, ...observe },
    ...extra,
  });
  return { auth, tokens, events: () => flushed(auth, batches) };
}

type World = ReturnType<typeof world>;

async function flushed(auth: Pick<Auth, "config">, batches: AuthEvent[][]): Promise<AuthEvent[]> {
  await auth.config.observe.flush();
  return batches.flat();
}

/** The events of `name` that `act` emits. */
async function emitted(
  w: { events: () => Promise<AuthEvent[]> },
  name: string,
  act: () => Promise<unknown>,
): Promise<AuthEvent[]> {
  const before = (await w.events()).length;
  await act();
  return (await w.events()).slice(before).filter((e) => e.name === name);
}

/** The flow fields of an event: no stamp of the observer. */
function fieldsOf(e: AuthEvent | undefined): Record<string, unknown> {
  const { at: _at, traceId: _t, spanId: _s, level: _l, ...rest } = e ?? {};
  return rest;
}

async function userOf(auth: Auth, email = EMAIL): Promise<UserRow> {
  const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("no user");
  return user;
}

type Answer = { ok: true; value: unknown } | { ok: false; code: string };

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

const passwordSignInOf = (w: World, password = PASSWORD) =>
  passwordSignIn(w.auth.config, { email: EMAIL, password, ip: null, userAgent: null });

async function magicLink(w: World, email = EMAIL) {
  must(await requestMagicLink(w.auth.config, { email, ip: null }));
  const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
  return verifyMagicLink(w.auth.config, { token, ip: null, userAgent: null });
}

async function emailCode(w: World, email = EMAIL) {
  must(await requestEmailOtp(w.auth.config, { email, ip: null }));
  const code = /\b(\d{6})\b/.exec(w.auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
  return verifyEmailOtp(w.auth.config, { email, code, ip: null, userAgent: null });
}

async function social(w: World, email = EMAIL) {
  const started = must(
    await startSocial(w.auth.config, { provider: "google", next: "/", ip: null }),
  );
  const url = new URL(started.location);
  w.tokens["idtok-default"] = {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: {
      sub: `g-${email}`,
      email,
      email_verified: true,
      nonce: url.searchParams.get("nonce") ?? "",
    },
  };
  return completeSocial(w.auth.config, {
    provider: "google",
    state: url.searchParams.get("state") ?? "",
    code: "code-1",
    error: null,
    bindToken: started.bindToken,
    ip: null,
    userAgent: null,
  });
}

/** A verified user with one passkey, and the authenticator that holds it. */
async function withPasskey(w: World) {
  must(await magicLink(w));
  const user = await userOf(w.auth);
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
  const reg = must(await passkeyRegistrationOptions(w.auth.config, { user }));
  const response = await soft.register(reg.challenge, new TextEncoder().encode(user.id));
  return {
    user,
    soft,
    register: () => verifyPasskeyRegistration(w.auth.config, { user, response }),
  };
}

/**
 * The `findMany` calls of the model `session` on `storage` and on each
 * transaction handle that it gives, from now on.
 */
function sessionReads(storage: StorageAdapter): unknown[][] {
  const reads: unknown[][] = [];
  const watched = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(t, key) {
        const value: unknown = Reflect.get(t, key);
        if (typeof value !== "function") return value;
        if (key !== "findMany") return value.bind(t);
        return (...args: unknown[]) => {
          if (args[0] === "session") reads.push(args);
          return Reflect.apply(value, t, args);
        };
      },
    });
  const findMany = storage.findMany.bind(storage);
  vi.spyOn(storage, "findMany").mockImplementation((...args) => {
    if (args[0] === "session") reads.push(args);
    return findMany(...args);
  });
  const transaction = storage.transaction.bind(storage);
  vi.spyOn(storage, "transaction").mockImplementation((work) =>
    transaction((tx) => work(watched(tx))),
  );
  return reads;
}

/** The app secret of `makeAuth` in test/helpers.ts. */
const SECRET = "0123456789abcdef0123456789abcdef";

/**
 * HMAC-SHA256 of the address, cut to 32 hex. HKDF-SHA256 derives its key
 * from the secret, with an empty salt and the email info of spec 31 item 8.
 * Written here with Web Crypto, apart from the code it checks.
 */
async function keyedEmailHash(secret: string, address: string): Promise<string> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode("authtempo observe email v1"),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(address));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** The session token of a flow answer that must open a session. */
function tokenOf(r: { ok: true; value: unknown } | { ok: false; code: string }): string {
  const v = must(r) as { token?: unknown };
  if (typeof v.token !== "string") throw new Error("the sign-in opened no session");
  return v.token;
}

/**
 * One sign-in for each value of `SessionVia`. The setup signs the user up
 * and in as the flow needs, and the answer is the act whose events count. A
 * Record, so a new value of the union fails the compile until it has a row.
 */
const SIGN_INS: Record<
  SessionVia,
  (w: World) => Promise<{ act: () => Promise<unknown>; events: () => Promise<AuthEvent[]> }>
> = {
  password: async (w) => {
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    return { act: () => passwordSignInOf(w), events: w.events };
  },
  magic_link: async (w) => ({ act: () => magicLink(w), events: w.events }),
  social: async (w) => ({ act: () => social(w), events: w.events }),
  passkey: async (w) => {
    const p = await withPasskey(w);
    must(await p.register());
    return {
      act: async () => {
        const options = must(await passkeyAuthenticationOptions(w.auth.config, { ip: null }));
        return verifyPasskeyAuthentication(w.auth.config, {
          response: await p.soft.authenticate(options.challenge),
          ip: null,
          userAgent: null,
        });
      },
      events: w.events,
    };
  },
  handoff: async (w) => {
    // The browser signs in, then the app redeems the handoff code.
    const browser = await resolveSession(w.auth.config, tokenOf(await magicLink(w)));
    if (!browser) throw new Error("no browser session");
    const verifier = randomBase64Url(32);
    const h = must(
      await startHandoff(w.auth.config, {
        challenge: await sha256Base64Url(verifier),
        redirect: "consumera://auth",
        ip: null,
      }),
    );
    const c = must(
      await continueHandoff(w.auth.config, {
        handoffId: h.handoffId,
        userId: browser.user.id,
        sessionId: browser.session.id,
      }),
    );
    const code = new URL(c.location).searchParams.get("code") ?? "";
    return {
      act: () => redeemHandoff(w.auth.config, { code, verifier, ip: null, userAgent: null }),
      events: w.events,
    };
  },
  email_otp: async (w) => ({ act: () => emailCode(w), events: w.events }),
  // An SSO sign-in through the OIDC start and callback routes (plan 12d).
  sso: async () => {
    const batches: AuthEvent[][] = [];
    const s = ssoSignInWorld({ observe: { sink: { write: (b) => void batches.push([...b]) } } });
    const { connectionId } = await acmeWithSso(s);
    return {
      act: async () => {
        const r = await ssoSignIn(s, connectionId, "acme", {
          sub: "ada-1",
          email: "ada@acme.example",
          email_verified: true,
        });
        expect(r.token).not.toBeNull();
      },
      events: () => flushed(s, batches),
    };
  },
  // An operator of the platform starts it through its route (plan 12f).
  impersonation: async () => {
    const batches: AuthEvent[][] = [];
    const f = await operatorFixture({
      config: {
        operator: {
          secrets: [
            {
              name: "support",
              secretHash: await sha256Hex(OPERATOR_SECRETS.support),
              scopes: ["users", "sessions", "audit"],
            },
          ],
          users: true,
          impersonation: {},
        },
        observe: { sink: { write: (b) => void batches.push([...b]) } },
      },
    });
    const target = await verifiedSession(f.auth, EMAIL);
    const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
    return {
      act: async () => {
        const res = await handle(
          post(
            "/auth/operator/impersonate",
            { userId: target.user.id, reason: "Ticket 4711: the user cannot see the invoices" },
            { cookie: `__Host-tempo_session=${f.operator.token}` },
          ),
        );
        expect(res.status).toBe(200);
      },
      events: () => flushed(f.auth, batches),
    };
  },
};

describe("the flow events (plan 12h Task 5)", () => {
  it("emits sign_in once for each sign-in method, with its via", async () => {
    // One source for the list of methods: SESSION_VIA (ruling 1 point 20 of plan 12h).
    expect(Object.keys(SIGN_INS).sort()).toEqual(Object.keys(SESSION_VIA).sort());
    for (const via of Object.keys(SESSION_VIA) as SessionVia[]) {
      const run = await SIGN_INS[via](world());
      const signIns = await emitted(run, "sign_in", run.act);
      expect(signIns, via).toHaveLength(1);
      const [e] = signIns;
      expect(e?.method, via).toBe(via);
      expect(e?.outcome, via).toBe("success");
      expect(e?.userId, via).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(e?.sessionId, via).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(e?.rejected, via).toBeUndefined();
      expect(e?.provider, via).toBe(via === "social" ? "google" : undefined);
    }
  });

  it("emits sign_in on a password sign-in", async () => {
    const w = world();
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    let token = "";
    const [e, ...more] = await emitted(w, "sign_in", async () => {
      token = tokenOf(await passwordSignInOf(w));
    });
    expect(more).toEqual([]);
    const s = await resolveSession(w.auth.config, token);
    expect(fieldsOf(e)).toEqual({
      name: "sign_in",
      method: "password",
      outcome: "success",
      userId: s?.user.id,
      sessionId: s?.session.id,
    });
  });

  it("emits second_factor_required for a user with a factor on", async () => {
    const w = world();
    const { user } = await enrolled(w.auth);
    const signIns = await emitted(w, "sign_in", async () => {
      const r = must(await passwordSignInOf(w));
      expect("twoFactor" in r).toBe(true);
    });
    expect(signIns.map(fieldsOf)).toEqual([
      {
        name: "sign_in",
        method: "password",
        outcome: "second_factor_required",
        userId: user.id,
      },
    ]);
    // The gated methods of plan 12c, and a reset that answers a challenge, name their first factor.
    const reset = async () => {
      must(await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null }));
      const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
      return resetPassword(w.auth.config, {
        token,
        password: NEW_PASSWORD,
        ip: null,
        userAgent: null,
      });
    };
    const gated: [string, () => Promise<Answer>][] = [
      ["magic_link", () => magicLink(w)],
      ["email_otp", () => emailCode(w)],
      ["social", () => social(w)],
      ["password", reset],
    ];
    for (const [via, act] of gated) {
      const events = await emitted(w, "sign_in", async () =>
        expect(must(await act())).toHaveProperty("twoFactor"),
      );
      expect(events.map(fieldsOf), via).toEqual([
        { name: "sign_in", method: via, outcome: "second_factor_required", userId: user.id },
      ]);
    }
  });

  it("emits sign_up on a password sign-up", async () => {
    const w = world();
    const [e, ...more] = await emitted(w, "sign_up", async () =>
      must(
        await passwordSignUp(w.auth.config, {
          email: EMAIL,
          password: PASSWORD,
          ip: null,
          userAgent: null,
        }),
      ),
    );
    expect(more).toEqual([]);
    expect(fieldsOf(e)).toEqual({
      name: "sign_up",
      method: "password",
      outcome: "success",
      userId: (await userOf(w.auth)).id,
    });
  });

  it("emits sign_out on a sign-out", async () => {
    const w = world();
    const s = await verifiedSession(w.auth);
    const before = (await w.events()).length;
    expect(await destroySession(w.auth.config, s.token)).not.toBeNull();
    const events = (await w.events()).slice(before);
    expect(events.map(fieldsOf)).toEqual([
      {
        name: "sign_out",
        outcome: "success",
        userId: s.user.id,
        sessionId: s.session.id,
      },
      { name: "session.end", reason: "sign_out", count: 1 },
    ]);
  });

  it("emits session.end on a revoke of one session", async () => {
    const w = world();
    const current = await verifiedSession(w.auth);
    const other = await verifiedSession(w.auth);
    const ends = await emitted(w, "session.end", async () =>
      must(await revokeSession(w.auth.config, { session: current, id: other.session.id })),
    );
    expect(ends.map(fieldsOf)).toEqual([{ name: "session.end", reason: "revoked", count: 1 }]);
  });

  it("ends sessions with one event and the count, and no read of each row", async () => {
    const w = world();
    // Three sessions: the one of the verify link, the current one, and one more sign-in.
    const current = await verifiedSession(w.auth);
    tokenOf(await passwordSignInOf(w));
    const reads = sessionReads(w.auth.config.storage);
    const ends = await emitted(w, "session.end", async () =>
      must(
        await changePassword(w.auth.config, {
          session: current,
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ),
    );
    expect(ends.map(fieldsOf)).toEqual([
      { name: "session.end", reason: "password_change", count: 2 },
    ]);
    // The one-statement rule of plan 9h: no afterEnd hook, so no read of each session row.
    expect(reads).toEqual([]);
    vi.restoreAllMocks();
  });

  it("emits second_factor.challenge on a challenge answer", async () => {
    const w = world();
    const { user, secret } = await enrolled(w.auth);
    const challenge = async () => {
      const r = must(await passwordSignInOf(w));
      if (!("twoFactor" in r)) throw new Error("no challenge");
      return r.twoFactor.challenge;
    };
    const code = await codeNow(w.auth, secret);
    const wrong = await emitted(w, "second_factor.challenge", async () =>
      verifyTwoFactor(w.auth.config, {
        challenge: await challenge(),
        code: wrongFor(code),
        ip: null,
      }),
    );
    expect(wrong.map(fieldsOf)).toEqual([
      {
        name: "second_factor.challenge",
        method: "totp",
        outcome: "failure",
        code: "invalid_code",
      },
    ]);
    const right = await emitted(w, "second_factor.challenge", async () =>
      must(await verifyTwoFactor(w.auth.config, { challenge: await challenge(), code, ip: null })),
    );
    expect(right.map(fieldsOf)).toEqual([
      { name: "second_factor.challenge", method: "totp", outcome: "success", userId: user.id },
    ]);
  });

  it("emits second_factor.enable on a TOTP enable", async () => {
    const w = world();
    const [e, ...more] = await emitted(w, "second_factor.enable", () => enrolled(w.auth));
    expect(more).toEqual([]);
    expect(fieldsOf(e)).toEqual({
      name: "second_factor.enable",
      method: "totp",
      outcome: "success",
      userId: (await userOf(w.auth)).id,
    });
  });

  it("emits second_factor.disable on a TOTP disable with a code", async () => {
    const w = world();
    const { user, secret } = await enrolled(w.auth);
    const code = await codeNow(w.auth, secret);
    const [e, ...more] = await emitted(w, "second_factor.disable", async () =>
      must(await disableTotpWithCode(w.auth.config, { user, code })),
    );
    expect(more).toEqual([]);
    expect(e?.level).toBe("warn");
    expect(fieldsOf(e)).toEqual({
      name: "second_factor.disable",
      method: "totp",
      outcome: "success",
      userId: user.id,
    });
  });

  it("emits second_factor.enable and second_factor.disable for the email method", async () => {
    const w = world();
    const { session } = await enrolled(w.auth);
    const on = await emitted(w, "second_factor.enable", async () =>
      must(await enableEmailMethod(w.auth.config, { session, password: PASSWORD })),
    );
    expect(on.map(fieldsOf)).toEqual([
      {
        name: "second_factor.enable",
        method: "email",
        outcome: "success",
        userId: session.user.id,
      },
    ]);
    const off = await emitted(w, "second_factor.disable", async () =>
      must(
        await disableMethod(w.auth.config, {
          user: session.user,
          method: "email",
          password: PASSWORD,
        }),
      ),
    );
    expect(off.map(fieldsOf)).toEqual([
      {
        name: "second_factor.disable",
        method: "email",
        outcome: "success",
        userId: session.user.id,
      },
    ]);
  });

  it("emits second_factor.disable on the in-process disable, and on its refusal", async () => {
    const w = world();
    const { user } = await enrolled(w.auth);
    const off = await emitted(w, "second_factor.disable", async () =>
      must(await disableTotp(w.auth.config, { userId: user.id })),
    );
    // Every method goes, so the event names none.
    expect(off.map(fieldsOf)).toEqual([
      { name: "second_factor.disable", outcome: "success", userId: user.id },
    ]);
    // An act with no route: the engine emits its refusal itself.
    const again = await emitted(w, "second_factor.disable", () =>
      disableTotp(w.auth.config, { userId: user.id }),
    );
    expect(again.map(fieldsOf)).toEqual([
      {
        name: "second_factor.disable",
        outcome: "failure",
        code: "totp_not_enabled",
        userId: user.id,
      },
    ]);
  });

  it("emits backup_codes.regenerate on a regeneration, and on a refusal of the in-process call", async () => {
    const w = world();
    const { user, secret } = await enrolled(w.auth);
    const code = await codeNow(w.auth, secret);
    const done = await emitted(w, "backup_codes.regenerate", async () =>
      must(await regenerateBackupCodesWithCode(w.auth.config, { user, code })),
    );
    expect(done.map(fieldsOf)).toEqual([
      { name: "backup_codes.regenerate", outcome: "success", userId: user.id },
    ]);
    // An act with no route: the engine emits its refusal itself.
    const other = await verifiedSession(w.auth, "bob@example.com");
    const refused = await emitted(w, "backup_codes.regenerate", async () =>
      expect(await regenerateBackupCodes(w.auth.config, { userId: other.user.id })).toEqual({
        ok: false,
        code: "totp_not_enabled",
        status: 400,
      }),
    );
    expect(refused.map(fieldsOf)).toEqual([
      {
        name: "backup_codes.regenerate",
        outcome: "failure",
        code: "totp_not_enabled",
        userId: other.user.id,
      },
    ]);
  });

  it("emits passkey.register on a passkey registration", async () => {
    const w = world();
    const p = await withPasskey(w);
    const [e, ...more] = await emitted(w, "passkey.register", async () => must(await p.register()));
    expect(more).toEqual([]);
    expect(fieldsOf(e)).toEqual({
      name: "passkey.register",
      outcome: "success",
      userId: p.user.id,
    });
  });

  it("emits passkey.delete on a passkey delete", async () => {
    const w = world();
    const p = await withPasskey(w);
    const { id } = must(await p.register());
    const [e, ...more] = await emitted(w, "passkey.delete", async () =>
      must(await deletePasskey(w.auth.config, { user: p.user, id })),
    );
    expect(more).toEqual([]);
    expect(fieldsOf(e)).toEqual({ name: "passkey.delete", outcome: "success", userId: p.user.id });
  });

  it("emits password.reset_request on a reset request, also for an address with no account", async () => {
    const w = world();
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    for (const email of [EMAIL, "nobody@example.com"]) {
      const requested = await emitted(w, "password.reset_request", async () =>
        must(await requestPasswordReset(w.auth.config, { email, ip: null })),
      );
      expect(requested.map(fieldsOf), email).toEqual([
        { name: "password.reset_request", outcome: "success" },
      ]);
    }
  });

  it("emits password.reset on a reset", async () => {
    const w = world();
    await verifiedSession(w.auth);
    must(await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null }));
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const before = (await w.events()).length;
    must(
      await resetPassword(w.auth.config, {
        token,
        password: NEW_PASSWORD,
        ip: null,
        userAgent: null,
      }),
    );
    const events = (await w.events()).slice(before);
    const userId = (await userOf(w.auth)).id;
    expect(events.filter((e) => e.name === "password.reset").map(fieldsOf)).toEqual([
      { name: "password.reset", outcome: "success", userId },
    ]);
    // The reset ends the sessions of the verify link and of the sign-in, with their count.
    expect(events.filter((e) => e.name === "session.end").map(fieldsOf)).toEqual([
      { name: "session.end", reason: "password_reset", count: 2 },
    ]);
  });

  it("emits password.change on a password change", async () => {
    const w = world();
    const s = await verifiedSession(w.auth);
    const [e, ...more] = await emitted(w, "password.change", async () =>
      must(
        await changePassword(w.auth.config, {
          session: s,
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ),
    );
    expect(more).toEqual([]);
    expect(fieldsOf(e)).toEqual({ name: "password.change", outcome: "success", userId: s.user.id });
  });

  it("emits email.verify on the proof of the address", async () => {
    const w = world();
    const [e, ...more] = await emitted(w, "email.verify", () =>
      signUpAndVerify(w.auth, EMAIL, PASSWORD),
    );
    expect(more).toEqual([]);
    expect(fieldsOf(e)).toEqual({
      name: "email.verify",
      method: "password_verify",
      outcome: "success",
      userId: (await userOf(w.auth)).id,
    });
  });

  it("emits session.end with the count of a claim", async () => {
    // An unverified password user with three sessions: the sign-up's and two
    // sign-ins. A magic link proves the address and claims the account.
    const w = world({}, { password: { hash: FAST, uniformSignUp: false, requireVerified: false } });
    must(
      await passwordSignUp(w.auth.config, {
        email: EMAIL,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    );
    for (let i = 0; i < 2; i++) expect(await passwordSignInOf(w)).toMatchObject({ ok: true });
    const ends = await emitted(w, "session.end", async () => tokenOf(await magicLink(w)));
    expect(ends.map(fieldsOf)).toEqual([{ name: "session.end", reason: "claim", count: 3 }]);
  });

  it("emits session.end with the count of a first factor, an address change, and a delete", async () => {
    // Each user has two sessions: the one of the verify link and the current one.
    const w = world();
    const enable = await emitted(w, "session.end", () => enrolled(w.auth));
    // The verify link of the sign-up claims the address and ends the session of the sign-up.
    expect(enable.map(fieldsOf)).toEqual([
      { name: "session.end", reason: "claim", count: 1 },
      { name: "session.end", reason: "two_factor", count: 1 },
    ]);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    must(await requestEmailChange(w.auth.config, { session: bob, newEmail: "bob2@example.com" }));
    const token = tokenFromMail(
      w.auth.mail.findLast((m) => m.to === "bob2@example.com")?.text ?? "",
    );
    const moved = await emitted(w, "session.end", async () =>
      must(await confirmEmailChange(w.auth.config, { token, ip: null, userAgent: null })),
    );
    expect(moved.map(fieldsOf)).toEqual([
      { name: "session.end", reason: "email_change", count: 1 },
    ]);
    const cy = await verifiedSession(w.auth, "cy@example.com");
    const deleted = await emitted(w, "session.end", async () =>
      must(await deleteAccount(w.auth.config, { session: cy, ip: null, userAgent: null })),
    );
    // The delete ends every session of the user, the current one too.
    expect(deleted.map(fieldsOf)).toEqual([
      { name: "session.end", reason: "account_deleted", count: 2 },
    ]);
  });

  it("emits reauth on a re-authentication", async () => {
    const w = world();
    const s = await verifiedSession(w.auth);
    const [e, ...more] = await emitted(w, "reauth", async () =>
      must(
        await reauthenticate(w.auth.config, {
          session: s,
          proof: { password: PASSWORD },
          ip: null,
        }),
      ),
    );
    expect(more).toEqual([]);
    expect(fieldsOf(e)).toEqual({
      name: "reauth",
      method: "password",
      outcome: "success",
      userId: s.user.id,
    });
  });

  it("holds no email in any event of a sign-in", async () => {
    const addresses = ["ada@example.com", "bob@example.com", "cy@example.com", "di@example.com"];
    // With the default include, and with the opt-in hash of the address (spec 31 item 8).
    for (const include of [{}, { include: { email: "hash" as const } }]) {
      const w = world(include);
      const [ada, bob, cy, di] = addresses;
      await signUpAndVerify(w.auth, ada, PASSWORD);
      must(
        await passwordSignIn(w.auth.config, {
          email: ada ?? "",
          password: PASSWORD,
          ip: null,
          userAgent: null,
        }),
      );
      must(await requestPasswordReset(w.auth.config, { email: ada ?? "", ip: null }));
      must(await magicLink(w, bob));
      must(await emailCode(w, cy));
      must(await social(w, di));
      const events = await w.events();
      // The verify link signs in too: six sign-ins.
      expect(events.filter((e) => e.name === "sign_in")).toHaveLength(6);
      const text = JSON.stringify(events);
      for (const address of addresses) expect(text).not.toContain(address);
      expect(text).not.toContain("@");
      for (const e of events) expect(e.rejected, e.name).toBeUndefined();
      const hashed = events.filter((e) => e.emailHash !== undefined);
      if ("include" in include) {
        // Each sign-in and sign-up names its address by the keyed hash only.
        expect(hashed.length).toBeGreaterThanOrEqual(5);
        for (const e of hashed) expect(e.emailHash).toMatch(/^[0-9a-f]{32}$/);
        // The keyed hash of spec 31 item 8 under the app secret, not a plain digest of the address.
        const social = events.find((e) => e.name === "sign_in" && e.method === "social");
        expect(social?.emailHash).toBe(await keyedEmailHash(SECRET, di ?? ""));
        expect(social?.emailHash).not.toBe((await sha256Hex(di ?? "")).slice(0, 32));
      } else expect(hashed).toEqual([]);
    }
  });
});

/** The session cookie name of `makeAuth`. */
const COOKIE = "__Host-tempo_session";

/**
 * The routes of a world (ruling 25 of plan 12h, M2). `send` posts JSON to
 * `/auth` plus `path`, with the session cookie of `token`.
 */
function routed(w: World) {
  const handle = createRouter(w.auth.config, coreRoutes(w.auth.config));
  return (path: string, body: unknown, token?: string) =>
    handle(post(`/auth${path}`, body, token === undefined ? {} : { cookie: `${COOKIE}=${token}` }));
}

/**
 * The events of `names` that the request of `send` emits. Each must carry
 * the trace id of the answer and the route key.
 */
async function inScope(
  w: World,
  names: readonly string[],
  route: string,
  send: () => Promise<Response>,
): Promise<{ res: Response; events: AuthEvent[] }> {
  const before = (await w.events()).length;
  const res = await send();
  const events = (await w.events()).slice(before).filter((e) => names.includes(e.name));
  const trace = res.headers.get("x-authtempo-trace");
  expect(trace).toMatch(/^[0-9a-f]{32}$/);
  expect(events.map((e) => e.name).sort()).toEqual([...names].sort());
  for (const e of events) {
    expect(e.traceId, e.name).toBe(trace);
    expect(e.route, e.name).toBe(route);
  }
  return { res, events };
}

describe("the request scope of the flow events (ruling 25 of plan 12h)", () => {
  it("gives sign_out and session.end of POST /sign-out the trace of the answer", async () => {
    const w = world();
    const s = await verifiedSession(w.auth);
    const { res, events } = await inScope(w, ["sign_out", "session.end"], "POST /sign-out", () =>
      routed(w)("/sign-out", {}, s.token),
    );
    expect(res.status).toBe(200);
    expect(events.map(fieldsOf)).toEqual([
      {
        name: "sign_out",
        outcome: "success",
        userId: s.user.id,
        sessionId: s.session.id,
        route: "POST /sign-out",
      },
      { name: "session.end", reason: "sign_out", count: 1, route: "POST /sign-out" },
    ]);
  });

  it("gives second_factor.challenge of POST /totp/verify the trace of the answer", async () => {
    const w = world();
    const { user, backupCodes } = await enrolled(w.auth);
    const r = must(await passwordSignInOf(w));
    if (!("twoFactor" in r)) throw new Error("no challenge");
    const { res, events } = await inScope(w, ["second_factor.challenge"], "POST /totp/verify", () =>
      routed(w)("/totp/verify", {
        challenge: r.twoFactor.challenge,
        backupCode: backupCodes[0],
      }),
    );
    expect(res.status).toBe(200);
    expect(events.map(fieldsOf)).toEqual([
      {
        name: "second_factor.challenge",
        method: "backup_code",
        outcome: "success",
        userId: user.id,
        route: "POST /totp/verify",
      },
    ]);
  });

  it("gives password.change of POST /password/change the trace of the answer", async () => {
    const w = world();
    const s = await verifiedSession(w.auth);
    const { res, events } = await inScope(
      w,
      ["password.change", "session.end"],
      "POST /password/change",
      () =>
        routed(w)(
          "/password/change",
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          s.token,
        ),
    );
    expect(res.status).toBe(200);
    expect(events.find((e) => e.name === "password.change")).toMatchObject({
      outcome: "success",
      userId: s.user.id,
    });
  });

  it("gives passkey.register of POST /passkey/register/verify the trace of the answer", async () => {
    const w = world();
    const token = tokenOf(await magicLink(w));
    const user = await userOf(w.auth);
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    const reg = must(await passkeyRegistrationOptions(w.auth.config, { user }));
    const response = await soft.register(reg.challenge, new TextEncoder().encode(user.id));
    const { res, events } = await inScope(
      w,
      ["passkey.register"],
      "POST /passkey/register/verify",
      () => routed(w)("/passkey/register/verify", { response }, token),
    );
    expect(res.status).toBe(200);
    expect(events.map(fieldsOf)).toEqual([
      {
        name: "passkey.register",
        outcome: "success",
        userId: user.id,
        route: "POST /passkey/register/verify",
      },
    ]);
  });

  it("gives email.verify of POST /password/verify the trace of the answer", async () => {
    const w = world();
    must(
      await passwordSignUp(w.auth.config, {
        email: EMAIL,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    );
    const mail = w.auth.mail.findLast((m) => m.subject.startsWith("Confirm"));
    const { res, events } = await inScope(w, ["email.verify"], "POST /password/verify", () =>
      routed(w)("/password/verify", { token: tokenFromMail(mail?.text ?? "") }),
    );
    expect(res.status).toBe(200);
    expect(events.map(fieldsOf)).toEqual([
      {
        name: "email.verify",
        method: "password_verify",
        outcome: "success",
        userId: (await userOf(w.auth)).id,
        route: "POST /password/verify",
      },
    ]);
  });
});
