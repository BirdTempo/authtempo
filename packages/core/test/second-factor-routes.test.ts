import { describe, expect, it } from "vitest";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { post, sessionFor } from "./helpers.js";
import { FAST, proofCookie, pwHandle } from "./password-helpers.js";

const EMAIL = "ada@example.com";
const PW = "correct horse battery";
const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
type Handle = ReturnType<typeof pwHandle>;

/** The `name=value` part of a Set-Cookie value. */
const pair = (cookie: string) => cookie.split(";")[0] ?? "";
const cookieNamed = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;

/** A verified user with a password, the session cookie of a sign-in, and one registered passkey. */
async function withPasskey(h: Handle) {
  const up = await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
  const token = h.mails.findLast((m) => m.to === EMAIL && m.subject.startsWith("Confirm"))?.token;
  if (!token) throw new Error("no confirm mail");
  // The sign-up's own browser keeps the password (ruling 11 of plan 12q).
  await h.auth.handle(post("/auth/password/verify", { token }, proofCookie(up)));
  const res = await h.auth.handle(post("/auth/password/sign-in", { email: EMAIL, password: PW }));
  const c = cookieNamed(res, "__Host-tempo_session");
  if (!c) throw new Error(`the sign-in answered ${res.status} with no session cookie`);
  const user = await h.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
  if (!user) throw new Error("no user");
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
  const options = await passkeyRegistrationOptions(h.config, {
    session: await sessionFor(h.config, user),
  });
  if (!options.ok) throw new Error(options.code);
  const registered = await verifyPasskeyRegistration(h.config, {
    session: await sessionFor(h.config, user),
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!registered.ok) throw new Error(registered.code);
  return { cookie: pair(c), soft, user };
}

/** A sign-in assertion of `soft`: the enable's proof. */
async function signInAssertion(h: Handle, soft: SoftAuthenticator) {
  const options = await passkeyAuthenticationOptions(h.config, { ip: null });
  if (!options.ok) throw new Error(options.code);
  return soft.authenticate(options.value.challenge);
}

describe("the second-factor method routes (plan 12c)", () => {
  it("answers 401 on every route that needs a session, with no session and with a tk_ token", async () => {
    const h = pwHandle({ hash: FAST }, { passkey: RP });
    const { cookie } = await withPasskey(h);
    const made = await h.auth.handle(post("/auth/tokens", { name: "ci" }, { cookie }));
    const { token } = (await made.json()) as { token: string };
    expect(token).toMatch(/^tk_/);
    const routes: [string, Record<string, unknown>][] = [
      ["/auth/second-factor/passkey/enable", { password: PW, response: {} }],
      ["/auth/second-factor/disable", { method: "passkey", password: PW }],
      ["/auth/second-factor/email/enable", { password: PW }],
    ];
    for (const [path, body] of routes)
      for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
        const res = await h.auth.handle(post(path, body, headers));
        expect([path, res.status]).toEqual([path, 401]);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    expect(await h.storage.findMany("secondFactor", [])).toEqual([]);
  });

  it("answers the options with no session, and refuses a disable of the TOTP method with invalid_body", async () => {
    const h = pwHandle({ hash: FAST }, { passkey: RP });
    const { cookie } = await withPasskey(h);
    const options = await h.auth.handle(
      post("/auth/second-factor/passkey/options", { challenge: `tf_${"x".repeat(43)}` }),
    );
    expect(options.status).toBe(400);
    expect(await options.json()).toMatchObject({ error: "invalid_token" });
    const totp = await h.auth.handle(
      post("/auth/second-factor/disable", { method: "totp", password: PW }, { cookie }),
    );
    expect(totp.status).toBe(400);
    expect(await totp.json()).toMatchObject({ error: "invalid_body" });
  });

  it("turns the passkey method on and passes a challenge through the routes; the last disable clears the trust cookie and deletes the trusted devices", async () => {
    const h = pwHandle({ hash: FAST }, { passkey: RP });
    const { cookie, soft, user } = await withPasskey(h);
    const enable = await h.auth.handle(
      post(
        "/auth/second-factor/passkey/enable",
        { password: PW, response: await signInAssertion(h, soft) },
        { cookie },
      ),
    );
    expect(enable.status).toBe(200);
    const enabled = (await enable.json()) as { methods: string[]; backupCodes: string[] };
    expect(enabled.methods).toEqual(["passkey"]);
    expect(enabled.backupCodes).toHaveLength(10);
    const signIn = await h.auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: PW }),
    );
    const { twoFactor } = (await signIn.json()) as { twoFactor: { challenge: string } };
    const optionsRes = await h.auth.handle(
      post("/auth/second-factor/passkey/options", { challenge: twoFactor.challenge }),
    );
    expect(optionsRes.status).toBe(200);
    const options = (await optionsRes.json()) as { challenge: string };
    const verify = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: twoFactor.challenge,
        passkey: await soft.authenticate(options.challenge),
        trustDevice: true,
      }),
    );
    expect(verify.status).toBe(200);
    const trust = cookieNamed(verify, "tempo_totp_trust");
    const session = cookieNamed(verify, "__Host-tempo_session");
    if (!trust || !session) throw new Error("the verify set no trust or session cookie");
    expect(
      await h.storage.findMany("trustedDevice", [{ field: "userId", op: "eq", value: user.id }]),
    ).toHaveLength(1);
    const disable = await h.auth.handle(
      post(
        "/auth/second-factor/disable",
        { method: "passkey", password: PW },
        { cookie: `${pair(session)}; ${pair(trust)}` },
      ),
    );
    expect(disable.status).toBe(200);
    expect(await disable.json()).toEqual({ ok: true, methods: [] });
    expect(cookieNamed(disable, "tempo_totp_trust")).toBe(
      "tempo_totp_trust=; Path=/auth/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    expect(
      await h.storage.findMany("trustedDevice", [{ field: "userId", op: "eq", value: user.id }]),
    ).toEqual([]);
    expect(await h.storage.findMany("secondFactor", [])).toEqual([]);
  });
});
