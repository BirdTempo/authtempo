import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { hasAddress, passkeyUserName, verifiedHandle } from "../src/engine/address.js";
import { HookStop } from "../src/engine/hooks.js";
import { publicKeySet } from "../src/engine/jwt.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { sendNotice } from "../src/engine/notices.js";
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from "../src/engine/passkeys.js";
import { passwordSignUp } from "../src/engine/password.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { draftUserRow, mayCreateUser } from "../src/engine/users.js";
import { decodeJws } from "../src/primitives/jwk.js";
import type { UserRow } from "../src/schema.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, tokenFromMail } from "./helpers.js";
import {
  authorized,
  exchange,
  type Handle,
  ISSUER,
  oauthHandle,
  pkce,
  registered,
} from "./oauth-helpers.js";
import { FAST } from "./password-helpers.js";

const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };
type Auth = ReturnType<typeof makeAuth>;

/**
 * A user with no address, through the one builder of a user row. No route
 * makes one before plan 12i Task 6, so this test writes the draft; Task 6
 * runs the same checks on two users of `POST /anonymous/sign-in`.
 */
async function addressless(storage: Auth["storage"], now: Date, name: string | null = null) {
  return storage.create("user", draftUserRow({ email: null, emailVerified: false, name }, now));
}

/** A passkey for `user`, by a real ceremony. */
async function withPasskey(auth: Auth, user: UserRow): Promise<void> {
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
  const options = await passkeyRegistrationOptions(auth.config, { user });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(auth.config, {
    user,
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!added.ok) throw new Error(added.code);
}

describe("the account with no address (plan 12i Task 1)", () => {
  it("two users with no address coexist", async () => {
    const auth = makeAuth();
    const now = auth.clock.now();
    const a = await addressless(auth.storage, now);
    const b = await addressless(auth.storage, now);
    expect(a.id).not.toBe(b.id);
    for (const id of [a.id, b.id])
      expect(
        await auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]),
      ).toMatchObject({
        email: null,
        username: null,
        displayUsername: null,
        phone: null,
        isAnonymous: false,
      });
    await auth.storage.create(
      "user",
      draftUserRow({ email: "d@example.com", emailVerified: true, name: null }, now),
    );
    await expect(
      auth.storage.create(
        "user",
        draftUserRow({ email: "d@example.com", emailVerified: false, name: null }, now),
      ),
    ).rejects.toMatchObject({ name: "StorageError", code: "unique_violation" });
  });

  it("sends no mail to a user with no address", async () => {
    const auth = makeAuth();
    const emit = vi.spyOn(auth.config.observe, "emit");
    const send = vi.spyOn(auth.config.mail, "send");
    await sendNotice(auth.config, {
      event: "password_changed",
      email: null,
      ip: null,
      userAgent: null,
    });
    expect(send).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(auth.mail).toEqual([]);
    // The same call with an address sends one mail.
    await sendNotice(auth.config, {
      event: "password_changed",
      email: "ada@example.com",
      ip: null,
      userAgent: null,
    });
    expect(auth.mail.map((m) => m.to)).toEqual(["ada@example.com"]);
  });

  it("claims nothing with a null address", async () => {
    const auth = makeAuth();
    const lone = await addressless(auth.storage, auth.clock.now());
    const { token } = await createSession(auth.config, {
      userId: lone.id,
      ip: null,
      userAgent: null,
    });
    const sent = await requestMagicLink(auth.config, { email: "new@example.com", ip: "1.2.3.4" });
    expect(sent.ok).toBe(true);
    const link = auth.mail.at(-1);
    if (!link) throw new Error("no mail");
    const verified = await verifyMagicLink(auth.config, {
      token: tokenFromMail(link.text),
      ip: "1.2.3.4",
      userAgent: null,
    });
    if (!verified.ok || !("user" in verified.value)) throw new Error("no session");
    expect(verified.value.user).toMatchObject({ email: "new@example.com", emailVerified: true });
    expect(verified.value.user.id).not.toBe(lone.id);
    // The user with no address keeps its row and its session.
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: lone.id }]),
    ).toMatchObject({ email: null });
    expect((await resolveSession(auth.config, token))?.user.id).toBe(lone.id);
    expect(await auth.storage.findMany("user", [])).toHaveLength(2);
  });

  it("mayCreateUser on a null address", async () => {
    for (const [signUp, stops] of [
      ["open", false],
      ["invited", true],
      [false, true],
    ] as const) {
      const auth = makeAuth({ signUp, organizations: {} });
      const run = mayCreateUser(auth.config, auth.storage, null);
      if (!stops) await expect(run).resolves.toBeUndefined();
      else {
        const stop = await run.then(
          () => null,
          (e: unknown) => e,
        );
        expect(stop).toBeInstanceOf(HookStop);
        expect(stop).toMatchObject({ result: { code: "sign_up_closed" } });
      }
    }
  });

  it("omits email claims for a null address", async () => {
    // The session JWT of GET /token.
    const auth = makeAuth();
    const jwtAuth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: auth.storage,
      mail: { send: async () => {} },
      clock: auth.clock,
      limiter: auth.config.limiter,
    });
    const lone = await addressless(auth.storage, auth.clock.now(), "Lone");
    const s = await createSession(auth.config, { userId: lone.id, ip: null, userAgent: null });
    const res = await jwtAuth.handle(get("/auth/token", { authorization: `Bearer ${s.token}` }));
    expect(res.status).toBe(200);
    const payload = decodeJws(((await res.json()) as { token: string }).token)?.payload ?? {};
    expect(payload).toMatchObject({ sub: lone.id, name: "Lone" });
    expect(Object.keys(payload)).not.toContain("email");
    expect(Object.keys(payload)).not.toContain("email_verified");
    // The ID token and userinfo with the email scope.
    const h: Handle = oauthHandle();
    const user = await addressless(h.storage, h.clock.now(), "Lone");
    const session = await createSession(h.config, { userId: user.id, ip: null, userAgent: null });
    const cookie = `__Host-tempo_session=${session.token}`;
    const clientId = await registered(h);
    const p = await pkce();
    const { code } = await authorized(h, cookie, {
      clientId,
      challenge: p.challenge,
      scope: "openid email profile mcp:read",
    });
    const tokens = (await (await h.auth.handle(exchange(code, clientId, p.verifier))).json()) as {
      access_token: string;
      id_token?: string;
    };
    const idToken = await jwtVerify(
      tokens.id_token ?? "",
      createLocalJWKSet(await publicKeySet(h.config)),
      { issuer: ISSUER, audience: clientId, currentDate: h.clock.now() },
    );
    expect(idToken.payload).toMatchObject({ sub: user.id, name: "Lone" });
    expect(Object.keys(idToken.payload)).not.toContain("email");
    expect(Object.keys(idToken.payload)).not.toContain("email_verified");
    const info = await h.auth.handle(
      get("/auth/oauth/userinfo", { authorization: `Bearer ${tokens.access_token}` }),
    );
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({ sub: user.id, name: "Lone", picture: null });
  });

  it("the verified handle", async () => {
    const auth = makeAuth({ passkey: RP, password: { hash: FAST, uniformSignUp: false } });
    const now = auth.clock.now();
    const verified = await auth.storage.create(
      "user",
      draftUserRow({ email: "v@example.com", emailVerified: true, name: null }, now),
    );
    expect(await verifiedHandle(auth.config, auth.storage, verified)).toBe(true);
    // A password sign-up leaves the address unverified.
    const up = await passwordSignUp(auth.config, {
      email: "u@example.com",
      password: "correct horse battery",
      ip: "1.2.3.4",
      userAgent: null,
    });
    if (!up.ok || !("user" in up.value)) throw new Error("no user");
    const unverified = up.value.user;
    expect(unverified.emailVerified).toBe(false);
    expect(await verifiedHandle(auth.config, auth.storage, unverified)).toBe(false);
    const lone = await addressless(auth.storage, now);
    expect(await verifiedHandle(auth.config, auth.storage, lone)).toBe(false);
    await withPasskey(auth, lone);
    expect(await verifiedHandle(auth.config, auth.storage, lone)).toBe(true);
  });

  it("passkeyUserName never answers null", () => {
    const auth = makeAuth({ appName: "Acme" });
    const row = (fields: Partial<UserRow>): UserRow => ({
      ...draftUserRow({ email: null, emailVerified: false, name: null }, auth.clock.now()),
      ...fields,
    });
    const all = {
      username: "ada",
      email: "ada@example.com",
      phone: "+14155550100",
      name: "Ada",
    };
    expect(passkeyUserName(auth.config, row(all))).toBe("ada");
    expect(passkeyUserName(auth.config, row({ ...all, username: null }))).toBe("ada@example.com");
    expect(passkeyUserName(auth.config, row({ ...all, username: null, email: null }))).toBe(
      "+14155550100",
    );
    expect(
      passkeyUserName(auth.config, row({ ...all, username: null, email: null, phone: null })),
    ).toBe("Ada");
    expect(passkeyUserName(auth.config, row({}))).toBe("Acme");
    expect(hasAddress(row({}))).toBe(false);
    expect(hasAddress(row({ email: "ada@example.com" }))).toBe(true);
  });

  it("the change of address admits a user with no address", async () => {
    const auth = makeAuth({ passkey: RP });
    const handle = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: auth.storage,
      mail: auth.config.mail,
      clock: auth.clock,
      limiter: auth.config.limiter,
      passkey: RP,
    });
    const lone = await addressless(auth.storage, auth.clock.now());
    await withPasskey(auth, lone);
    const { token } = await createSession(auth.config, {
      userId: lone.id,
      ip: null,
      userAgent: null,
    });
    const cookie = `__Host-tempo_session=${token}`;
    const res = await handle.handle(
      post("/auth/user/change-email", { newEmail: "found@example.com" }, { cookie }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    // One mail: the proof to the new address. No notice goes to an old one.
    expect(auth.mail.map((m) => m.to)).toEqual(["found@example.com"]);
    const confirm = await handle.handle(
      post("/auth/user/change-email/confirm", { token: tokenFromMail(auth.mail[0]?.text ?? "") }),
    );
    expect(confirm.status).toBe(200);
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: lone.id }]),
    ).toMatchObject({ email: "found@example.com", emailVerified: true });
    expect(auth.mail.map((m) => m.to)).toEqual(["found@example.com"]);
  });
});
