import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { requestEmailOtp, requestResetOtp } from "../../src/engine/email-otp.js";
import { SESSION_VIA, type SessionVia } from "../../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../../src/engine/magic-link.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../../src/engine/passkeys.js";
import { passwordSignIn, passwordSignUp, requestPasswordReset } from "../../src/engine/password.js";
import { addPhone, requestPhone, verifyAddPhone } from "../../src/engine/phone.js";
import { resolveSession } from "../../src/engine/sessions.js";
import { updateDomain } from "../../src/engine/sso/domains.js";
import { setUsername } from "../../src/engine/username.js";
import type { PasswordHashSeam } from "../../src/seams/password-hash.js";
import { createRecordingSms } from "../../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../../src/testing/soft-authenticator.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, settled, tokenFromMail } from "../helpers.js";
import { FAST, signUpAndVerify } from "../password-helpers.js";
import { GOOGLE, tokenEndpoint } from "../social-helpers.js";
import { codeNow, enrolled } from "../totp-helpers.js";
import { SSO_APP } from "./helpers.js";
import { acmeWithSso, type SsoWorld, ssoSignInWorld } from "./sign-in-helpers.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ADA = "ada@acme.example";
const PASSWORD = "correct horse battery";
const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
const ADA_PHONE = "+14155550100";

/**
 * The engine with every first factor: the password, the magic link, the
 * email code, Google, passkeys, and the phone code. `sms` holds the SMS.
 */
function world(extra: Partial<AuthConfig> = {}) {
  const { fetchFn } = tokenEndpoint("idtok-google");
  const sms = createRecordingSms();
  const w = ssoSignInWorld({
    social: { google: GOOGLE, fetch: fetchFn },
    passkey: RP,
    password: { hash: FAST, uniformSignUp: false },
    // Plan 12i Task 3: the password sign-in by username.
    username: {},
    // Plan 12i Task 5: the phone code sign-in and the password sign-in by phone.
    phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
    ...extra,
  });
  return { ...w, sms };
}

type World = ReturnType<typeof world>;

/** The code of the last SMS to `phone`. */
const smsCodeOf = (w: World, phone: string) =>
  /^(\d+) /.exec(w.sms.sent.findLast((m) => m.to === phone)?.text ?? "")?.[1] ?? "";

/** A fresh session of `email` by the password. */
async function sessionOf(w: World, email = ADA) {
  const s = await passwordSignIn(w.config, {
    email,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!s.ok || !("token" in s.value)) throw new Error("no session");
  const session = await resolveSession(w.config, s.value.token);
  if (!session) throw new Error("no session");
  return session;
}

/** The user of `email` adds `phone` through the add flow. */
async function addPhoneOf(w: World, phone = ADA_PHONE, email = ADA): Promise<void> {
  const session = await sessionOf(w, email);
  must(await addPhone(w.config, { session, phone, ip: null }));
  const code = smsCodeOf(w, phone);
  must(await verifyAddPhone(w.config, { session, code, ip: null, userAgent: null }));
}

/** A Google sign-in through the routes, whose ID token names `sub` and `email`. */
async function google(w: SsoWorld, email: string, sub = "g-1"): Promise<Response> {
  const started = await w.handle(get("/auth/social/google/start?next=/"));
  const url = new URL(started.headers.get("location") ?? "");
  const bind = started.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
    ?.split(";")[0];
  w.tokens["idtok-google"] = {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: { sub, email, email_verified: true, nonce: url.searchParams.get("nonce") ?? "" },
  };
  const q = new URLSearchParams({ code: "code-1", state: url.searchParams.get("state") ?? "" });
  return w.handle(get(`/auth/social/google/callback?${q}`, { cookie: bind ?? "" }));
}

/** The code of the last mail to `email`. */
const codeOf = (w: SsoWorld, email: string) =>
  /\b(\d{6})\b/.exec(w.mail.findLast((m) => m.to === email)?.text ?? "")?.[1] ?? "";

/** The code and the detail of an answer: the JSON body, or the `auth_error` of a redirect. */
async function answerOf(res: Response): Promise<{ status: number; code: string | null }> {
  const location = res.headers.get("location");
  if (location !== null)
    return { status: res.status, code: new URL(location).searchParams.get("auth_error") };
  const body = (await res.json()) as { error?: string };
  return { status: res.status, code: body.error ?? null };
}

interface Door {
  name: string;
  /** The `SessionVia` of the session that the door opens with enforce off. */
  via: SessionVia;
  /** JSON: the door answers a JSON body. Else a redirect with `auth_error`. */
  json: boolean;
  /** Runs before the enforce flag, and answers the call of the door. */
  prepare(w: World): Promise<() => Promise<Response>>;
}

const DOORS: Door[] = [
  {
    name: "the password sign-in",
    via: "password",
    json: true,
    async prepare(w) {
      return () => w.handle(post("/auth/password/sign-in", { email: ADA, password: PASSWORD }));
    },
  },
  {
    // Plan 12i Task 3: a username names its address only through the user
    // row, so the check runs after the password, and the answer is the same.
    name: "the password sign-in by username",
    via: "password",
    json: true,
    async prepare(w) {
      const session = await sessionOf(w);
      must(await setUsername(w.config, { session, username: "Ada", ip: null, userAgent: null }));
      return () =>
        w.handle(post("/auth/password/sign-in", { username: "ada", password: PASSWORD }));
    },
  },
  {
    // Plan 12i Task 3: the check runs after the password, as by username.
    name: "the password sign-in by phone",
    via: "password",
    json: true,
    async prepare(w) {
      await addPhoneOf(w);
      return () =>
        w.handle(post("/auth/password/sign-in", { phone: ADA_PHONE, password: PASSWORD }));
    },
  },
  {
    // Plan 12i Task 5: a code sent before enforce went on (final review A H1).
    name: "the phone code verify",
    via: "phone",
    json: true,
    async prepare(w) {
      await addPhoneOf(w);
      must(await requestPhone(w.config, { phone: ADA_PHONE, ip: null }));
      const code = smsCodeOf(w, ADA_PHONE);
      return () => w.handle(post("/auth/phone/verify", { phone: ADA_PHONE, code }));
    },
  },
  {
    name: "the password sign-up of a new address of the domain",
    via: "password",
    json: true,
    async prepare(w) {
      return () =>
        w.handle(post("/auth/password/sign-up", { email: "new@acme.example", password: PASSWORD }));
    },
  },
  {
    name: "a first password",
    via: "password",
    json: true,
    async prepare(w) {
      // Pat signs in by a magic link, so Pat has no password row.
      await requestMagicLink(w.config, { email: "pat@acme.example", ip: null });
      const link = tokenFromMail(w.mail.findLast((m) => m.to === "pat@acme.example")?.text ?? "");
      const pat = await verifyMagicLink(w.config, { token: link, ip: null, userAgent: null });
      if (!pat.ok || !("token" in pat.value)) throw new Error("no session");
      const cookie = `__Host-tempo_session=${pat.value.token}`;
      return () => w.handle(post("/auth/password/change", { newPassword: PASSWORD }, { cookie }));
    },
  },
  {
    name: "the magic link verify",
    via: "magic_link",
    json: true,
    async prepare(w) {
      const sent = await requestMagicLink(w.config, { email: ADA, ip: null });
      if (!sent.ok) throw new Error(sent.code);
      const token = tokenFromMail(w.mail.findLast((m) => m.to === ADA)?.text ?? "");
      return () => w.handle(post("/auth/magic-link/verify", { token }));
    },
  },
  {
    name: "the email code verify",
    via: "email_otp",
    json: true,
    async prepare(w) {
      const sent = await requestEmailOtp(w.config, { email: ADA, ip: null });
      if (!sent.ok) throw new Error(sent.code);
      const code = codeOf(w, ADA);
      return () => w.handle(post("/auth/otp/verify", { email: ADA, code }));
    },
  },
  {
    name: "a social callback with the address",
    via: "social",
    json: false,
    async prepare(w) {
      return () => google(w, ADA);
    },
  },
  {
    name: "a social callback of the linked identity with another address",
    via: "social",
    json: false,
    async prepare(w) {
      return () => google(w, "ada@mail.example");
    },
  },
  // Ruling 38 of plan 12d: a proof that was mailed or written before enforce went on.
  {
    name: "a reset link mailed before enforce",
    via: "password",
    json: true,
    async prepare(w) {
      must(await requestPasswordReset(w.config, { email: ADA, ip: null }));
      const token = tokenFromMail(w.mail.findLast((m) => m.to === ADA)?.text ?? "");
      return () => w.handle(post("/auth/password/reset", { token, password: NEW_PASSWORD }));
    },
  },
  {
    name: "a reset code mailed before enforce",
    via: "email_otp",
    json: true,
    async prepare(w) {
      must(await requestResetOtp(w.config, { email: ADA, ip: null }));
      const code = codeOf(w, ADA);
      return () => w.handle(post("/auth/otp/reset", { email: ADA, code, password: NEW_PASSWORD }));
    },
  },
  {
    name: "a sign-up verify link mailed before enforce",
    via: "password",
    json: true,
    async prepare(w) {
      const email = "neo@acme.example";
      must(
        await passwordSignUp(w.config, { email, password: PASSWORD, ip: null, userAgent: null }),
      );
      const token = tokenFromMail(w.mail.findLast((m) => m.to === email)?.text ?? "");
      return () => w.handle(post("/auth/password/verify", { token }));
    },
  },
  {
    name: "a second factor challenge written before enforce",
    via: "password",
    json: true,
    async prepare(w) {
      const email = "tia@acme.example";
      const { secret } = await enrolled(w, email);
      const r = await passwordSignIn(w.config, {
        email,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });
      if (!r.ok || !("twoFactor" in r.value)) throw new Error("no challenge");
      const challenge = r.value.twoFactor.challenge;
      return async () =>
        w.handle(post("/auth/totp/verify", { challenge, code: await codeNow(w, secret) }));
    },
  },
  {
    name: "a passkey sign-in",
    via: "passkey",
    json: true,
    async prepare(w) {
      const user = await w.storage.findOne("user", [{ field: "email", op: "eq", value: ADA }]);
      if (!user) throw new Error("no user");
      const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
      const reg = await passkeyRegistrationOptions(w.config, { user });
      if (!reg.ok) throw new Error(reg.code);
      const stored = await verifyPasskeyRegistration(w.config, {
        user,
        response: await soft.register(reg.value.challenge, new TextEncoder().encode(user.id)),
      });
      if (!stored.ok) throw new Error(stored.code);
      return async () => {
        const options = await passkeyAuthenticationOptions(w.config, { ip: null });
        if (!options.ok) throw new Error(options.code);
        const response = await soft.authenticate(options.value.challenge);
        return w.handle(post("/auth/passkey/authenticate/verify", { response }));
      };
    },
  },
];

/**
 * The `SessionVia` values with no door, each with its reason. Every other
 * value needs a door in `DOORS`, so a new first factor fails the test below
 * until it gets one (final review A H1 of plan 12i).
 */
const NO_DOOR: Partial<Record<SessionVia, string>> = {
  sso: "the SSO sign-in is the door that enforce sends the person to",
  anonymous: "an anonymous user has no address, so no domain claims it",
  handoff: "a handoff carries a session that a door opened before",
  impersonation: "an operator acts as the user; the person signs in at no door",
};

/**
 * Ada of acme.example with a password, a Google identity, and the door's
 * own state, then the domain routed to the connection, with `enforce`.
 */
async function scene(door: Door, enforce: boolean) {
  const w = world();
  const { connectionId, domainId } = await acmeWithSso(w);
  await signUpAndVerify(w, ADA, PASSWORD);
  const linked = await answerOf(await google(w, ADA));
  if (linked.code !== null) throw new Error(linked.code);
  const call = await door.prepare(w);
  const routed = await updateDomain(w.config, SSO_APP, {
    id: domainId,
    connectionId,
    enforce,
    ip: null,
    userAgent: null,
  });
  if (!routed.ok) throw new Error(routed.code);
  return { w, call, start: `${BASE_URL}/auth/sso/${connectionId}/start` };
}

const NEW_PASSWORD = "a brand new horse battery";

/** The answer of an engine call that a scene needs. */
function must(r: { ok: boolean; code?: string }): void {
  if (!r.ok) throw new Error(r.code);
}

/** The ids of the session rows. */
const sessionIds = async (w: World) =>
  new Set((await w.storage.findMany("session", [])).map((s) => s.id));

/** The session rows that came after `before`. */
async function newSessions(w: World, before: Set<string>): Promise<number> {
  return [...(await sessionIds(w))].filter((id) => !before.has(id)).length;
}

describe("the enforcement of a domain (plan 12d Task 5)", () => {
  it("has a door for each SessionVia value but the named exceptions", () => {
    const vias = Object.keys(SESSION_VIA) as SessionVia[];
    const withDoor = new Set(DOORS.map((d) => d.via));
    for (const via of vias) {
      const reason = NO_DOOR[via];
      expect({ via, door: withDoor.has(via), reason: reason !== undefined }).toEqual({
        via,
        door: reason === undefined,
        reason: reason !== undefined,
      });
    }
  });

  it.each(DOORS)("refuses every first factor of an enforced domain: $name", async (door) => {
    const { w, call, start } = await scene(door, true);
    const before = await sessionIds(w);
    const res = await call();
    if (door.json) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "sso_required", detail: start });
    } else expect(await answerOf(res)).toEqual({ status: 302, code: "sso_required" });
    expect(await newSessions(w, before)).toBe(0);
  });

  it("checks the password before the domain in a sign-in by username", async () => {
    // Plan 12i Task 3: a username is public. A wrong password must not tell
    // that its account is in an enforced domain.
    const verified: string[] = [];
    const hash: PasswordHashSeam = {
      dummy: () => FAST.dummy(),
      hash: (p) => FAST.hash(p),
      verify: (p, stored) => {
        verified.push(stored);
        return FAST.verify(p, stored);
      },
    };
    const w = world({ password: { hash, uniformSignUp: false } });
    const { connectionId, domainId } = await acmeWithSso(w);
    await signUpAndVerify(w, ADA, PASSWORD);
    const byName = DOORS.find((d) => d.name === "the password sign-in by username") as Door;
    const right = await byName.prepare(w);
    must(
      await updateDomain(w.config, SSO_APP, {
        id: domainId,
        connectionId,
        enforce: true,
        ip: null,
        userAgent: null,
      }),
    );
    const before = await sessionIds(w);
    verified.length = 0;
    const wrong = await w.handle(
      post("/auth/password/sign-in", { username: "ada", password: "a wrong horse battery" }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });
    // One verify against the stored hash, as any wrong password costs.
    expect(verified).toHaveLength(1);
    expect(verified[0]).not.toBe(await FAST.dummy());
    // The right password gets the SSO answer.
    const res = await right();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "sso_required",
      detail: `${BASE_URL}/auth/sso/${connectionId}/start`,
    });
    expect(await newSessions(w, before)).toBe(0);
  });

  it("answers the start on the baseURL origin when the app is on another origin", async () => {
    const w = world({ appURL: APP_ORIGIN });
    expect([w.config.baseURL, w.config.appURL]).toEqual([BASE_URL, APP_ORIGIN]);
    const { connectionId, domainId } = await acmeWithSso(w);
    await signUpAndVerify(w, ADA, PASSWORD);
    const routed = await updateDomain(w.config, SSO_APP, {
      id: domainId,
      connectionId,
      enforce: true,
      ip: null,
      userAgent: null,
    });
    if (!routed.ok) throw new Error(routed.code);
    const res = await w.handle(
      post("/auth/password/sign-in", { email: ADA, password: PASSWORD }, { origin: APP_ORIGIN }),
    );
    expect(res.status).toBe(403);
    const { detail } = (await res.json()) as { detail: string };
    expect(detail).toBe(`https://api.example.com/auth/sso/${connectionId}/start`);
    // The app sends the browser to the detail as it is: the start goes to the IdP.
    const go = await w.handle(new Request(detail));
    expect(go.status).toBe(302);
    expect(new URL(go.headers.get("location") ?? "").origin).toBe("https://login.acme-idp.example");
  });

  it("sends nothing from a request of an enforced address", async () => {
    const { w } = await scene(DOORS[0] as Door, true);
    const requests = (email: string) => [
      () => requestMagicLink(w.config, { email, ip: null }),
      () => requestEmailOtp(w.config, { email, ip: null }),
      () => requestPasswordReset(w.config, { email, ip: null }),
    ];
    w.mail.length = 0;
    for (const request of requests(ADA))
      expect(await request()).toEqual({ ok: true, value: { sent: true } });
    expect(w.mail).toEqual([]);
    for (const request of requests("bob@other.example")) {
      const sent = w.mail.length;
      expect(await request()).toEqual({ ok: true, value: { sent: true } });
      expect(w.mail.length - sent).toBe(1);
    }
  });

  it("sends no phone code to a user of an enforced address", async () => {
    // Final review A H1 of plan 12i: in process, and on the route after the answer.
    const door = DOORS.find((d) => d.name === "the password sign-in by phone") as Door;
    const { w } = await scene(door, true);
    const route = settled(w.handle);
    const other = "+14155550111";
    w.sms.sent.length = 0;
    expect(await requestPhone(w.config, { phone: ADA_PHONE, ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const res = await route(post("/auth/phone/request", { phone: ADA_PHONE }));
    expect([res.status, await res.json()]).toEqual([200, { sent: true }]);
    expect(w.sms.sent).toEqual([]);
    // A known number outside the domain gets its code: the check is of the domain.
    await signUpAndVerify(w, "bob@other.example", PASSWORD);
    await addPhoneOf(w, other, "bob@other.example");
    w.sms.sent.length = 0;
    const sent = await route(post("/auth/phone/request", { phone: other }));
    expect([sent.status, await sent.json()]).toEqual([200, { sent: true }]);
    expect(w.sms.sent.map((m) => m.to)).toEqual([other]);
  });

  it.each(DOORS)("keeps every door open with enforce off: $name", async (door) => {
    const { w, call } = await scene(door, false);
    const before = await sessionIds(w);
    const answer = await answerOf(await call());
    expect(answer.code).toBeNull();
    expect(answer.status).toBe(door.json ? 200 : 302);
    // Each door but the first password opens one new session.
    expect(await newSessions(w, before)).toBe(door.name === "a first password" ? 0 : 1);
  });

  it("reads the domain table only when sso is on", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    await signUpAndVerify(auth, ADA, PASSWORD);
    const findMany = vi.spyOn(auth.storage, "findMany");
    const r = await passwordSignIn(auth.config, {
      email: ADA,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(true);
    expect(findMany.mock.calls.filter((c) => c[0] === "ssoDomain")).toEqual([]);
  });
});
