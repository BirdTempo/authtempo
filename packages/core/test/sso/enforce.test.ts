import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { requestEmailOtp, requestResetOtp } from "../../src/engine/email-otp.js";
import { requestMagicLink, verifyMagicLink } from "../../src/engine/magic-link.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../../src/engine/passkeys.js";
import { passwordSignIn, passwordSignUp, requestPasswordReset } from "../../src/engine/password.js";
import { updateDomain } from "../../src/engine/sso/domains.js";
import { SoftAuthenticator } from "../../src/testing/soft-authenticator.js";
import { get, makeAuth, post, tokenFromMail } from "../helpers.js";
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

/** The engine with every first factor: the password, the magic link, the email code, Google, and passkeys. */
function world(extra: Partial<AuthConfig> = {}) {
  const { fetchFn } = tokenEndpoint("idtok-google");
  return ssoSignInWorld({
    social: { google: GOOGLE, fetch: fetchFn },
    passkey: RP,
    password: { hash: FAST, uniformSignUp: false },
    ...extra,
  });
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
  /** JSON: the door answers a JSON body. Else a redirect with `auth_error`. */
  json: boolean;
  /** Runs before the enforce flag, and answers the call of the door. */
  prepare(w: SsoWorld): Promise<() => Promise<Response>>;
}

const DOORS: Door[] = [
  {
    name: "the password sign-in",
    json: true,
    async prepare(w) {
      return () => w.handle(post("/auth/password/sign-in", { email: ADA, password: PASSWORD }));
    },
  },
  {
    name: "the password sign-up of a new address of the domain",
    json: true,
    async prepare(w) {
      return () =>
        w.handle(post("/auth/password/sign-up", { email: "new@acme.example", password: PASSWORD }));
    },
  },
  {
    name: "a first password",
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
    json: false,
    async prepare(w) {
      return () => google(w, ADA);
    },
  },
  {
    name: "a social callback of the linked identity with another address",
    json: false,
    async prepare(w) {
      return () => google(w, "ada@mail.example");
    },
  },
  // Ruling 38 of plan 12d: a proof that was mailed or written before enforce went on.
  {
    name: "a reset link mailed before enforce",
    json: true,
    async prepare(w) {
      must(await requestPasswordReset(w.config, { email: ADA, ip: null }));
      const token = tokenFromMail(w.mail.findLast((m) => m.to === ADA)?.text ?? "");
      return () => w.handle(post("/auth/password/reset", { token, password: NEW_PASSWORD }));
    },
  },
  {
    name: "a reset code mailed before enforce",
    json: true,
    async prepare(w) {
      must(await requestResetOtp(w.config, { email: ADA, ip: null }));
      const code = codeOf(w, ADA);
      return () => w.handle(post("/auth/otp/reset", { email: ADA, code, password: NEW_PASSWORD }));
    },
  },
  {
    name: "a sign-up verify link mailed before enforce",
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
  return { w, call, start: `/auth/sso/${connectionId}/start` };
}

const NEW_PASSWORD = "a brand new horse battery";

/** The answer of an engine call that a scene needs. */
function must(r: { ok: boolean; code?: string }): void {
  if (!r.ok) throw new Error(r.code);
}

/** The ids of the session rows. */
const sessionIds = async (w: SsoWorld) =>
  new Set((await w.storage.findMany("session", [])).map((s) => s.id));

/** The session rows that came after `before`. */
async function newSessions(w: SsoWorld, before: Set<string>): Promise<number> {
  return [...(await sessionIds(w))].filter((id) => !before.has(id)).length;
}

describe("the enforcement of a domain (plan 12d Task 5)", () => {
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
