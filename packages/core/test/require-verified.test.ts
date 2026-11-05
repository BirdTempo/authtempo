import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { passwordSignIn, passwordSignUp, verifyPasswordEmail } from "../src/engine/password.js";
import { defaultSignInPage } from "../src/http/sign-in-page.js";
import { post, tokenFromMail } from "./helpers.js";
import { FAST, pwAuth, pwHandle, signUpAndVerify } from "./password-helpers.js";

const EMAIL = "ada@example.com";
const PW = "correct horse battery";
const call = { ip: "192.0.2.1", userAgent: null };

/** An unverified user with an active password row: the sign-up of plan 8. */
async function unverified(requireVerified: boolean) {
  const auth = pwAuth({ requireVerified });
  const up = await passwordSignUp(auth.config, { email: EMAIL, password: PW, ...call });
  if (!up.ok) throw new Error(up.code);
  return auth;
}

const confirms = (auth: ReturnType<typeof pwAuth>) =>
  auth.mail.filter((m) => m.to === EMAIL && m.subject.startsWith("Confirm"));

describe("password.requireVerified (plan 12b, Better Auth docs audit gap 1)", () => {
  it("refuses a value that is not a boolean at construction", () => {
    expect(() => pwAuth({ requireVerified: "yes" as unknown as boolean })).toThrow(ConfigError);
  });

  it("answers email_unverified to the right password of an unverified user and mails a new link", async () => {
    const auth = await unverified(false);
    // The key on, on the same storage: a sign-up of today, then the upgrade.
    const pw = auth.config.password;
    if (!pw) throw new Error("password sign-in is off");
    auth.config.password = { ...pw, requireVerified: true };
    const before = confirms(auth).length;
    const r = await passwordSignIn(auth.config, { email: EMAIL, password: PW, ...call });
    expect(r).toEqual({ ok: false, code: "email_unverified", status: 403 });
    expect(confirms(auth).length).toBe(before + 1);
    expect(await auth.storage.findMany("session", [])).toHaveLength(1); // the sign-up's own session only
  });

  it("answers invalid_credentials to a wrong password of an unverified user and mails nothing", async () => {
    const auth = await unverified(true);
    const before = confirms(auth).length;
    const r = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: "wrong horse battery",
      ...call,
    });
    expect(r).toEqual({ ok: false, code: "invalid_credentials", status: 401 });
    expect(confirms(auth).length).toBe(before);
  });

  it("opens a session for a verified user as before", async () => {
    const auth = pwAuth({ requireVerified: true });
    await signUpAndVerify(auth, EMAIL, PW);
    const r = await passwordSignIn(auth.config, { email: EMAIL, password: PW, ...call });
    expect(r.ok && "token" in r.value).toBe(true);
  });

  it("opens a session for an unverified user while the key is off (the default)", async () => {
    const auth = await unverified(false);
    const r = await passwordSignIn(auth.config, { email: EMAIL, password: PW, ...call });
    expect(r.ok && "token" in r.value).toBe(true);
  });

  it("mails at most three links in 15 minutes and still answers email_unverified", async () => {
    const auth = await unverified(true);
    const before = confirms(auth).length;
    for (let i = 0; i < 5; i++) {
      const r = await passwordSignIn(auth.config, { email: EMAIL, password: PW, ...call });
      expect(r).toEqual({ ok: false, code: "email_unverified", status: 403 });
    }
    expect(confirms(auth).length - before).toBe(3);
  });

  it("signs in through the new link, and the next sign-in opens a session", async () => {
    const auth = pwAuth({ requireVerified: true });
    const up = await passwordSignUp(auth.config, { email: EMAIL, password: PW, ...call });
    if (!up.ok) throw new Error(up.code);
    // The sign-up's own browser: its proof goes with the sign-in and the
    // confirm, so the new link keeps the password (ruling 11 of plan 12q).
    const signUpProof = up.value.signUpProof;
    await passwordSignIn(auth.config, { email: EMAIL, password: PW, ...call, signUpProof });
    const v = await verifyPasswordEmail(auth.config, {
      token: tokenFromMail(confirms(auth).at(-1)?.text ?? ""),
      ...call,
      signUpProof,
    });
    expect(v.ok && v.value.signedIn !== null).toBe(true);
    expect(v.ok && v.value.passwordKept).toBe(true);
    const r = await passwordSignIn(auth.config, { email: EMAIL, password: PW, ...call });
    expect(r.ok && "token" in r.value).toBe(true);
  });

  it("answers the user and no session at a detailed sign-up", async () => {
    const auth = pwAuth({ requireVerified: true });
    const up = await passwordSignUp(auth.config, { email: EMAIL, password: PW, ...call });
    expect(up.ok && up.value).toMatchObject({
      verifyRequired: true,
      user: { email: EMAIL, emailVerified: false },
    });
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
    expect(confirms(auth)).toHaveLength(1);
  });

  it("answers 403 email_unverified with no cookie on the route", async () => {
    const h = pwHandle({ hash: FAST, requireVerified: true });
    await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    const res = await h.auth.handle(post("/auth/password/sign-in", { email: EMAIL, password: PW }));
    expect({
      status: res.status,
      body: await res.json(),
      cookie: res.headers.get("set-cookie"),
    }).toEqual({
      status: 403,
      body: { error: "email_unverified" },
      cookie: null,
    });
  });

  it("answers 200 with the user, verifyRequired, and no cookie at the sign-up route", async () => {
    const h = pwHandle({ hash: FAST, requireVerified: true });
    const res = await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    const body = (await res.json()) as { token?: unknown; user?: { email?: unknown } };
    // No session cookie: the one cookie is the sign-up proof (ruling 11 of plan 12q).
    expect({
      status: res.status,
      verifyRequired: (body as { verifyRequired?: unknown }).verifyRequired,
      token: body.token,
      email: body.user?.email,
      cookies: res.headers.getSetCookie().map((c) => c.split("=")[0]),
    }).toEqual({
      status: 200,
      verifyRequired: true,
      token: undefined,
      email: EMAIL,
      cookies: ["__Host-tempo_signup"],
    });
  });

  it("shows the email_unverified text on the sign-in page, from the code of the 403", () => {
    const html = defaultSignInPage({
      basePath: "/auth",
      continuePath: "/",
      methods: {
        magicLink: true as const,
        google: false,
        apple: false,
        passkey: false,
        password: true,
        providers: [],
        sso: false,
      },
      nonce: "n1",
      appName: "Acme",
    });
    const start = html.indexOf(`postJson("/password/sign-in"`);
    const handler = html.slice(start, html.indexOf(".catch(", start));
    expect(handler).toContain(
      `if (code === "email_unverified") say("Confirm your email address first. We sent you a new link.");`,
    );
  });
});
