import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { requestEmailOtp } from "../src/engine/email-otp.js";
import { passwordMethod } from "../src/engine/last-method.js";
import { requestMagicLink } from "../src/engine/magic-link.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { passwordSignIn as engineSignIn } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { setUsername } from "../src/engine/username.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import {
  APP_ORIGIN,
  BASE_URL,
  get,
  makeAuth,
  post,
  recordCredential,
  tokenFromMail,
} from "./helpers.js";
import { signUpAndVerify } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, GOOGLE, tokenEndpoint } from "./social-helpers.js";
import { codeNow, EMAIL, enrolled, PASSWORD, totpAuth } from "./totp-helpers.js";

// The last method (plan 12i Task 12, spec 32 item 11). A readable cookie
// with one value of a closed set, set at each browser sign-in. It is a hint
// for the sign-in page only: it signs no one in and names no account.
// The phone value comes from the phone routes of Task 5, and the anonymous
// sign-in of Task 6 sets no cookie; each of those tasks adds its case here.

const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };
const LAST = "__Host-tempo_last_method";
const SESSION = "__Host-tempo_session";
/** 30 days, the default. */
const MAX_AGE = 30 * 86_400;

function world(extra: Partial<AuthConfig> = {}) {
  const tokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = tokenEndpoint("idtok-default");
  const auth = totpAuth({
    username: {},
    social: { google: GOOGLE, fetch: fetchFn },
    jwt: fakeJwt(tokens),
    passkey: RP,
    lastMethod: {},
    ...extra,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  return { auth, tokens, handle };
}
type World = ReturnType<typeof world>;

/** The Set-Cookie of the last method, or null. */
function lastCookie(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${LAST}=`)) ?? null;
}

function hasSession(res: Response): boolean {
  return res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=`));
}

const expected = (value: string) =>
  `${LAST}=${value}; Path=/; Max-Age=${MAX_AGE}; Secure; SameSite=Lax`;

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const passwordSignIn = (w: World, by: Record<string, string>, headers = {}) =>
  w.handle(post("/auth/password/sign-in", { ...by, password: PASSWORD }, headers));

/** A verified user with a password and the username `ada`, set by the real engine. */
async function named(w: World) {
  await signUpAndVerify(w.auth, EMAIL, PASSWORD);
  const signedIn = await engineSignIn(w.auth.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!signedIn.ok || !("token" in signedIn.value)) throw new Error("no session");
  const session = await resolveSession(w.auth.config, signedIn.value.token);
  if (!session) throw new Error("no session");
  const set = await setUsername(w.auth.config, {
    session,
    username: "ada",
    ip: null,
    userAgent: null,
  });
  if (!set.ok) throw new Error(set.code);
}

/** One browser sign-in per value: the answer, and whether it is JSON. */
const CASES: Record<string, (w: World) => Promise<{ res: Response; json: boolean }>> = {
  password: async (w) => {
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    return { res: await passwordSignIn(w, { email: EMAIL }), json: true };
  },
  username: async (w) => {
    await named(w);
    return { res: await passwordSignIn(w, { username: "Ada" }), json: true };
  },
  magic_link: async (w) => {
    const sent = await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
    if (!sent.ok) throw new Error(sent.code);
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    // The form of the confirm page: a redirect with the cookies.
    const res = await w.handle(
      new Request(`${BASE_URL}/auth/magic-link/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    return { res, json: false };
  },
  email_otp: async (w) => {
    const sent = await requestEmailOtp(w.auth.config, { email: EMAIL, ip: null });
    if (!sent.ok) throw new Error(sent.code);
    const code = recordCredential(/\b(\d{6})\b/.exec(w.auth.mail.at(-1)?.text ?? "")?.[1] ?? "");
    return { res: await w.handle(post("/auth/otp/verify", { email: EMAIL, code })), json: true };
  },
  passkey: async (w) => {
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
    if (!user) throw new Error("no user");
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const reg = await passkeyRegistrationOptions(w.auth.config, { user });
    if (!reg.ok) throw new Error(reg.code);
    const response = await soft.register(reg.value.challenge, new TextEncoder().encode(user.id));
    const done = await verifyPasskeyRegistration(w.auth.config, { user, response });
    if (!done.ok) throw new Error(done.code);
    const options = await passkeyAuthenticationOptions(w.auth.config, { ip: null });
    if (!options.ok) throw new Error(options.code);
    const assertion = await soft.authenticate(options.value.challenge);
    return {
      res: await w.handle(post("/auth/passkey/authenticate/verify", { response: assertion })),
      json: true,
    };
  },
  "social:google": async (w) => {
    const start = await w.handle(get("/auth/social/google/start?next=/home"));
    const url = new URL(start.headers.get("location") ?? "");
    const bind = /^([^=]+=[^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1] ?? "";
    w.tokens["idtok-default"] = {
      audience: GOOGLE.clientId,
      issuer: "https://accounts.google.com",
      claims: {
        sub: "g-1",
        email: EMAIL,
        email_verified: true,
        nonce: url.searchParams.get("nonce") ?? "",
      },
    };
    const state = url.searchParams.get("state") ?? "";
    const res = await w.handle(
      get(`/auth/social/google/callback?code=c&state=${encodeURIComponent(state)}`, {
        cookie: bind,
      }),
    );
    expect(res.status).toBe(302);
    return { res, json: false };
  },
};

/** The token of the confirm mail of a sign-up through the route, which opens a session too. */
async function signedUp(w: World): Promise<{ res: Response; token: string }> {
  const res = await w.handle(post("/auth/password/sign-up", { email: EMAIL, password: PASSWORD }));
  const mail = w.auth.mail.findLast((m) => m.to === EMAIL && m.subject.startsWith("Confirm"));
  return { res, token: tokenFromMail(mail?.text ?? "") };
}

/**
 * More browser sign-ins of a value of CASES (review I2): the name of the
 * case, the value, and the run. `json` is true when the answer has `via`.
 */
const MORE: [string, string, (w: World) => Promise<{ res: Response; json: boolean }>][] = [
  [
    "the sign-up with a session",
    "password",
    async (w) => ({ res: (await signedUp(w)).res, json: true }),
  ],
  [
    "the confirm link, form",
    "password",
    async (w) => {
      const { token } = await signedUp(w);
      const res = await w.handle(
        new Request(`${BASE_URL}/auth/password/verify`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
          body: new URLSearchParams({ token }).toString(),
        }),
      );
      expect(res.status).toBe(302);
      return { res, json: false };
    },
  ],
  [
    "the confirm link, JSON",
    "password",
    async (w) => {
      const { token } = await signedUp(w);
      const res = await w.handle(post("/auth/password/verify", { token }));
      // The answer is { verified: true }: a confirm, not a sign-in answer, so no `via`.
      expect(await res.clone().json()).toEqual({ verified: true });
      return { res, json: false };
    },
  ],
  [
    "the magic link, JSON",
    "magic_link",
    async (w) => {
      const sent = await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
      if (!sent.ok) throw new Error(sent.code);
      const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
      return { res: await w.handle(post("/auth/magic-link/verify", { token })), json: true };
    },
  ],
];

describe("the last method cookie (plan 12i Task 12)", () => {
  it("sets the cookie at each browser sign-in with its value", async () => {
    for (const [value, run] of Object.entries(CASES)) {
      const w = world();
      const { res, json } = await run(w);
      expect(hasSession(res), value).toBe(true);
      expect(lastCookie(res), value).toBe(expected(value));
      if (json) expect((await bodyOf(res)).via, value).toBe(value);
    }
    for (const [name, value, run] of MORE) {
      const w = world();
      const { res, json } = await run(w);
      expect(hasSession(res), name).toBe(true);
      expect(lastCookie(res), name).toBe(expected(value));
      if (json) expect((await bodyOf(res)).via, name).toBe(value);
    }
    // The value of a sign-in behind the second factor: the challenge verify sets it.
    const w = world();
    await named(w);
    const { secret } = await enrolled(w.auth, EMAIL);
    const first = await passwordSignIn(w, { username: "ada" });
    expect(lastCookie(first)).toBeNull();
    const challenge = ((await bodyOf(first)).twoFactor as { challenge: string }).challenge;
    const res = await w.handle(
      post("/auth/totp/verify", { challenge, code: await codeNow(w.auth, secret) }),
    );
    expect(hasSession(res)).toBe(true);
    expect(lastCookie(res)).toBe(expected("username"));
    expect((await bodyOf(res)).via).toBe("username");
    // A custom name and lifetime.
    const custom = world({ lastMethod: { cookieName: "last_way", days: 2 } });
    const r = await CASES.password?.(custom);
    expect(r?.res.headers.getSetCookie().find((c) => c.startsWith("last_way="))).toBe(
      "last_way=password; Path=/; Max-Age=172800; Secure; SameSite=Lax",
    );
  });

  it("writes no cookie for a bearer client, and nothing with lastMethod off", async () => {
    // A bearer client: the JSON names the method, and no readable cookie goes out.
    const w = world();
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    const bearer = await passwordSignIn(w, { email: EMAIL }, { authorization: "Bearer ts_x" });
    expect(bearer.status).toBe(200);
    expect(lastCookie(bearer)).toBeNull();
    expect((await bodyOf(bearer)).via).toBe("password");
    // Off by default: no cookie and no `via`.
    const off = world({ lastMethod: false });
    await signUpAndVerify(off.auth, EMAIL, PASSWORD);
    const res = await passwordSignIn(off, { email: EMAIL });
    expect(hasSession(res)).toBe(true);
    expect(lastCookie(res)).toBeNull();
    expect(Object.keys(await bodyOf(res))).toEqual(["token", "user", "session"]);
    const absent = totpAuth();
    expect(absent.config.lastMethod).toBeNull();
  });

  it("refuses a cookie name of core, a bad name, and days out of range", () => {
    // A clash lets the readable cookie overwrite a cookie of core in the same answer (review I2).
    const names = [
      SESSION,
      "tempo_session",
      "__Secure-tempo_session_oauth",
      "__Host-tempo_session_actor",
      "tempo_totp_trust",
      "a b",
      "",
    ];
    for (const cookieName of names)
      expect(() => makeAuth({ lastMethod: { cookieName } }), cookieName).toThrow(
        /lastMethod\.cookieName/,
      );
    // The names follow a custom session cookie name.
    expect(() =>
      makeAuth({ cookieName: "__Host-app", lastMethod: { cookieName: "__Host-app_actor" } }),
    ).toThrow(/lastMethod\.cookieName/);
    expect(() => makeAuth({ lastMethod: { days: 0 } })).toThrow(/lastMethod\.days/);
    expect(() => makeAuth({ lastMethod: { days: 401 } })).toThrow(/lastMethod\.days/);
    expect(makeAuth({ lastMethod: { days: 400 } }).config.lastMethod?.days).toBe(400);
  });

  it("never stores the method on the user row", async () => {
    const w = world();
    const p = await CASES.password?.(w);
    const s = await CASES["social:google"]?.(w);
    expect(lastCookie(p?.res as Response)).toBe(expected("password"));
    expect(lastCookie(s?.res as Response)).toBe(expected("social:google"));
    const users = await w.auth.storage.findMany("user", []);
    expect(users).toHaveLength(1);
    for (const user of users) {
      // The keys of the user row of schema version 15 (plan 12i Task 1).
      expect(Object.keys(user).sort()).toEqual(
        [
          "id",
          "email",
          "emailVerified",
          "name",
          "image",
          "bannedAt",
          "banReason",
          "banUntil",
          "username",
          "displayUsername",
          "phone",
          "isAnonymous",
          "createdAt",
          "updatedAt",
        ].sort(),
      );
      for (const value of Object.values(user))
        expect(["password", "social:google"]).not.toContain(value);
    }
  });

  it("names the password sign-in by its identifier: phone for a number (plan 12i Task 4)", () => {
    // The route sets passwordMethod(by). A proved phone comes with Task 5
    // (verifyAddPhone), so no test here seeds one; Task 5 adds the route case.
    expect(passwordMethod({})).toBe("password");
    expect(passwordMethod({ username: "ada" })).toBe("username");
    expect(passwordMethod({ phone: "+14155550100" })).toBe("phone");
  });
});
