import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { requestAccountDelete } from "../src/engine/account-delete.js";
import {
  byAddressThenId,
  hasAddress,
  passkeyUserName,
  verifiedHandle,
} from "../src/engine/address.js";
import { HookStop } from "../src/engine/hooks.js";
import { waysIn } from "../src/engine/identities.js";
import { acceptInvitation, inviteMember } from "../src/engine/invitations.js";
import { publicKeySet } from "../src/engine/jwt.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { sendNotice } from "../src/engine/notices.js";
import { createOrganization } from "../src/engine/organizations.js";
import {
  deletePasskey,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { passwordSignUp, verifyPassword } from "../src/engine/password.js";
import { addPhone, requestPhone, verifyAddPhone, verifyPhone } from "../src/engine/phone.js";
import { requestReauthCode } from "../src/engine/reauth.js";
import { createSession, type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { draftUserRow, mayCreateUser } from "../src/engine/users.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, sessionFor, tokenFromMail } from "./helpers.js";
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

/**
 * A session of `user`, as a sign-in opens it. `proved` is true. That is the
 * value that the engine now sets for a user with no address that is not
 * anonymous (`provedAtOpen`, ruling 20 of plan 12p).
 */
async function sessionOf(auth: Auth, user: UserRow): Promise<ResolvedSession> {
  const { token } = await createSession(auth.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
    proved: true,
  });
  const resolved = await resolveSession(auth.config, token);
  if (!resolved) throw new Error("no session");
  return resolved;
}

/** A passkey for `user`, by a real ceremony. */
async function withPasskey(auth: Auth, user: UserRow): Promise<void> {
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
  const options = await passkeyRegistrationOptions(auth.config, {
    session: await sessionFor(auth.config, user),
  });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(auth.config, {
    session: await sessionFor(auth.config, user),
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!added.ok) throw new Error(added.code);
}

describe("the account with no address (plan 12i Task 1)", () => {
  it("two users with no address coexist", async () => {
    // Two users of the anonymous sign-in of plan 12i Task 6, the first route with no address.
    const auth = makeAuth({ anonymous: { isolateLimiter: "allow" } });
    const now = auth.clock.now();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const ids: string[] = [];
    for (const ip of ["198.51.100.1", "198.51.100.2"]) {
      const res = await handle(post("/auth/anonymous/sign-in", {}, { "x-forwarded-for": ip }));
      expect(res.status).toBe(200);
      ids.push(((await res.json()) as { user: { id: string } }).user.id);
    }
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids)
      expect(
        await auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]),
      ).toMatchObject({
        email: null,
        username: null,
        displayUsername: null,
        phone: null,
        isAnonymous: true,
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
      proved: true,
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
    const s = await createSession(auth.config, {
      userId: lone.id,
      ip: null,
      userAgent: null,
      proved: true,
    });
    const res = await jwtAuth.handle(get("/auth/token", { authorization: `Bearer ${s.token}` }));
    expect(res.status).toBe(200);
    const payload = decodeJws(((await res.json()) as { token: string }).token)?.payload ?? {};
    expect(payload).toMatchObject({ sub: lone.id, name: "Lone" });
    expect(Object.keys(payload)).not.toContain("email");
    expect(Object.keys(payload)).not.toContain("email_verified");
    // The ID token and userinfo with the email scope.
    const h: Handle = oauthHandle();
    const user = await addressless(h.storage, h.clock.now(), "Lone");
    const session = await createSession(h.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
      proved: true,
    });
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
      proved: true,
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

  it("counts no stored phone as a way in or a handle with no phone config (ruling 15)", async () => {
    // A phone that a real code proved (ruling 23 L3). A user with no address
    // and a passkey adds it with `phone` on, then drops the passkey.
    const sms = createRecordingSms();
    const on = makeAuth({
      passkey: RP,
      phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
    });
    const lone = await addressless(on.storage, on.clock.now());
    await withPasskey(on, lone);
    const session = await sessionOf(on, lone);
    expect(await addPhone(on.config, { session, phone: "+14155550100", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect(await verifyAddPhone(on.config, { session, code, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { phone: "+14155550100" },
    });
    const [first] = await on.storage.findMany("passkey", [
      { field: "userId", op: "eq", value: lone.id },
    ]);
    if (!first) throw new Error("no passkey");
    expect(
      await deletePasskey(on.config, { user: { ...lone, phone: "+14155550100" }, id: first.id }),
    ).toEqual({ ok: true, value: { ok: true } });
    // The app turns `phone` off on the same store. With no `phone` config no
    // phone code exists, so the phone signs in nowhere.
    const auth = makeAuth({ storage: on.storage, clock: on.clock, passkey: RP });
    const phoned = await on.storage.findOne("user", [{ field: "id", op: "eq", value: lone.id }]);
    if (!phoned) throw new Error("no user");
    expect(phoned.phone).toBe("+14155550100");
    expect(await verifiedHandle(auth.config, on.storage, phoned)).toBe(false);
    expect(await waysIn(auth.config, on.storage, phoned)).toBe(0);
    await withPasskey(auth, phoned);
    expect(await waysIn(auth.config, on.storage, phoned)).toBe(1);
    const [passkey] = await on.storage.findMany("passkey", [
      { field: "userId", op: "eq", value: phoned.id },
    ]);
    if (!passkey) throw new Error("no passkey");
    expect(await deletePasskey(auth.config, { user: phoned, id: passkey.id })).toEqual({
      ok: false,
      code: "last_credential",
      status: 409,
    });
  });

  it("counts a stored phone as a way in and a handle only with phone on and the number in a region (ruling 15)", async () => {
    // A user with no address and a passkey adds a phone by a real code (ruling 20 m2).
    const sms = createRecordingSms();
    const on = makeAuth({
      passkey: RP,
      phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
    });
    const lone = await addressless(on.storage, on.clock.now());
    await withPasskey(on, lone);
    const session = await sessionOf(on, lone);
    expect(await addPhone(on.config, { session, phone: "+14155550100", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect(await verifyAddPhone(on.config, { session, code, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { phone: "+14155550100" },
    });
    const read = async (auth: Auth) => {
      const row = await auth.config.storage.findOne("user", [
        { field: "id", op: "eq", value: lone.id },
      ]);
      if (!row) throw new Error("no user");
      return row;
    };
    const phoned = await read(on);
    expect(phoned.phone).toBe("+14155550100");
    expect(await waysIn(on.config, on.storage, phoned)).toBe(2);
    // The passkey can go: the phone stays a way in and a handle.
    const [passkey] = await on.storage.findMany("passkey", [
      { field: "userId", op: "eq", value: phoned.id },
    ]);
    if (!passkey) throw new Error("no passkey");
    expect(await deletePasskey(on.config, { user: phoned, id: passkey.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await waysIn(on.config, on.storage, phoned)).toBe(1);
    expect(await verifiedHandle(on.config, on.storage, phoned)).toBe(true);
    // The app moves its regions to +44 on the same store. A number outside
    // every region gets no code, so it is no way in and no handle.
    const elsewhere = makeAuth({
      storage: on.storage,
      passkey: RP,
      phone: { sms, regions: ["+44"], isolateLimiter: "allow" },
    });
    const far = await read(elsewhere);
    expect(await verifiedHandle(elsewhere.config, elsewhere.config.storage, far)).toBe(false);
    expect(await waysIn(elsewhere.config, elsewhere.config.storage, far)).toBe(0);
  });

  it("sorts a member with no address after every address", () => {
    const rows = [
      { email: null, id: "a" },
      { email: "z@example.com", id: "c" },
      { email: null, id: "b" },
      { email: "a@example.com", id: "d" },
    ];
    expect([...rows].sort(byAddressThenId).map((r) => r.id)).toEqual(["d", "c", "a", "b"]);
    expect(
      [...rows]
        .reverse()
        .sort(byAddressThenId)
        .map((r) => r.id),
    ).toEqual(["d", "c", "a", "b"]);
  });

  it("issues no re-authentication code and sends no mail to a user with no address", async () => {
    const auth = makeAuth();
    const send = vi.spyOn(auth.config.mail, "send");
    const lone = await addressless(auth.storage, auth.clock.now());
    expect(await requestReauthCode(auth.config, { session: await sessionOf(auth, lone) })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "reauth-otp" },
      ]),
    ).toEqual([]);
  });

  it("sends no delete link to a user with no address", async () => {
    const auth = makeAuth({ account: { deleteConfirm: { ttlMinutes: 60 } } });
    const send = vi.spyOn(auth.config.mail, "send");
    const lone = await addressless(auth.storage, auth.clock.now());
    const session = await sessionOf(auth, lone);
    expect(await requestAccountDelete(auth.config, { session, ip: null, userAgent: null })).toEqual(
      { ok: true, value: { sent: true } },
    );
    expect(send).not.toHaveBeenCalled();
    expect(auth.mail).toEqual([]);
  });

  it("limits the password check of a user with no address by the user id (ruling 15 m4)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const lone = await addressless(auth.storage, auth.clock.now());
    const other = await addressless(auth.storage, auth.clock.now());
    // Ten tries, each from its own IP, so the per-IP limit never counts to its end.
    for (let i = 0; i < 10; i++)
      expect(
        await verifyPassword(auth.config, {
          userId: lone.id,
          password: "a guess",
          ip: `1.2.3.${i}`,
        }),
      ).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(
      await verifyPassword(auth.config, { userId: lone.id, password: "a guess", ip: "1.2.4.1" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    // The count is per user: another user with no address still gets a try.
    expect(
      await verifyPassword(auth.config, { userId: other.id, password: "a guess", ip: "1.2.4.2" }),
    ).toMatchObject({ ok: false, code: "invalid_credentials" });
  });

  it("answers email_mismatch to a user with no address at an invitation (spec 32 item 1)", async () => {
    const auth = makeAuth({ organizations: {} });
    const owner = await auth.seedUser("owner@example.com");
    const org = await createOrganization(auth.config, { user: owner, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    await inviteMember(auth.config, {
      user: owner,
      organizationId: org.value.organization.id,
      email: "bob@example.com",
      role: "member",
    });
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(auth.mail[0]?.text ?? "")?.[1];
    if (!token) throw new Error("no token in mail");
    const lone = await addressless(auth.storage, auth.clock.now());
    expect(await acceptInvitation(auth.config, { user: lone, token, ip: null })).toMatchObject({
      ok: false,
      code: "email_mismatch",
      status: 403,
    });
  });
});

/**
 * A user with no address from a real phone code (plan 12i Task 5): the
 * sign-up by `verifyPhone`, then a first password through the route. The
 * world serves every route of the config.
 */
async function phoneWorld(extra: Parameters<typeof makeAuth>[0] = {}) {
  const sms = createRecordingSms();
  const auth = makeAuth({
    passkey: RP,
    password: { hash: FAST, uniformSignUp: false },
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    ...extra,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const phone = "+14155550100";
  const signIn = async () => {
    await requestPhone(auth.config, { phone, ip: "203.0.113.7" });
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    return verifyPhone(auth.config, { phone, code, ip: "203.0.113.7", userAgent: null });
  };
  const made = await signIn();
  if (!made.ok || !("token" in made.value)) throw new Error("no phone session");
  const cookie = `${auth.config.cookieName}=${made.value.token}`;
  const first = await handle(
    post("/auth/password/change", { newPassword: "correct horse battery" }, { cookie }),
  );
  expect(first.status).toBe(200);
  return { auth, handle, phone, signIn, user: made.value.user, cookie };
}

describe("a user with no address and a verified handle (plan 12i Task 5, ruling 15)", () => {
  it("opens the profile update and the API tokens to a verified handle (ruling 15 m2)", async () => {
    const w = await phoneWorld();
    const update = await w.handle(post("/auth/user/update", { name: "Ada" }, { cookie: w.cookie }));
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ user: { email: null, name: "Ada" } });
    const created = await w.handle(post("/auth/tokens", { name: "cli" }, { cookie: w.cookie }));
    expect(created.status).toBe(200);
    const { token } = (await created.json()) as { token: string };
    const current = await w.handle(
      get("/auth/tokens/current", { authorization: `Bearer ${token}` }),
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ user: { id: w.user.id, email: null } });
    // A user with no address and no handle still gets email_unverified.
    const lone = await addressless(w.auth.storage, w.auth.clock.now());
    const { token: loneToken } = await createSession(w.auth.config, {
      userId: lone.id,
      ip: null,
      userAgent: null,
      proved: true,
    });
    const loneCookie = { cookie: `${w.auth.config.cookieName}=${loneToken}` };
    for (const [path, body] of [
      ["/auth/user/update", { name: "Bob" }],
      ["/auth/tokens", { name: "cli" }],
    ] as const) {
      const res = await w.handle(post(path, body, loneCookie));
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: "email_unverified" });
    }
  });

  it("signs a phone user in by a passkey and by a second factor", async () => {
    const w = await phoneWorld();
    // A passkey, by a real ceremony through the routes.
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const options = await w.handle(
      post("/auth/passkey/register/options", {}, { cookie: w.cookie }),
    );
    const { challenge } = (await options.json()) as { challenge: string };
    const registered = await w.handle(
      post(
        "/auth/passkey/register/verify",
        { response: await soft.register(challenge, new TextEncoder().encode(w.user.id)) },
        { cookie: w.cookie },
      ),
    );
    expect(registered.status).toBe(200);
    const request = await w.handle(post("/auth/passkey/authenticate/options", {}));
    const req = (await request.json()) as { challenge: string };
    const byPasskey = await w.handle(
      post("/auth/passkey/authenticate/verify", {
        response: await soft.authenticate(req.challenge),
      }),
    );
    expect(byPasskey.status).toBe(200);
    expect(await byPasskey.json()).toMatchObject({ user: { id: w.user.id, email: null } });
    // The TOTP factor of a user with no address (`provedAccount`), then a phone sign-in.
    const session = await sessionOf(w.auth, w.user);
    const setup = await setupTotp(w.auth.config, {
      session,
      password: "correct horse battery",
    });
    if (!setup.ok) throw new Error(setup.code);
    const secret = base32Decode(setup.value.secret);
    const enabled = await enableTotp(w.auth.config, {
      session,
      code: await totpCode(secret, w.auth.clock.now()),
    });
    expect(enabled.ok).toBe(true);
    w.auth.clock.advance(30_000);
    const gated = await w.signIn();
    if (!gated.ok || !("twoFactor" in gated.value)) throw new Error("no challenge");
    const verified = await w.handle(
      post("/auth/totp/verify", {
        challenge: gated.value.twoFactor.challenge,
        code: await totpCode(secret, w.auth.clock.now()),
      }),
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ user: { id: w.user.id, email: null } });
  });

  it("deletes an account with no address on a fresh re-authentication (ruling 15 m3)", async () => {
    // The mailed confirm is on, and a user with no address gets no mail: the fresh session is the proof.
    const w = await phoneWorld({ account: { deleteConfirm: { ttlMinutes: 60 } } });
    const del = (cookie: string) => w.handle(post("/auth/user/delete", {}, { cookie }));
    // A stale session answers session_not_fresh.
    w.auth.clock.advance(w.auth.config.session.freshMinutes * 60_000);
    const stale = await del(w.cookie);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "session_not_fresh" });
    // A new sign-in by a phone code is a fresh re-authentication.
    const again = await w.signIn();
    if (!again.ok || !("token" in again.value)) throw new Error("no session");
    const deleted = await del(`${w.auth.config.cookieName}=${again.value.token}`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(
      await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: w.user.id }]),
    ).toBeNull();
    expect(w.auth.mail).toEqual([]);
  });

  it("deletes an account with no address after a passkey re-authentication (ruling 15 m3)", async () => {
    const w = await phoneWorld({ account: { deleteConfirm: { ttlMinutes: 60 } } });
    await withPasskey(w.auth, w.user);
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    // `withPasskey` used its own authenticator: register this one too, while the session is fresh.
    const options = await w.handle(
      post("/auth/passkey/register/options", {}, { cookie: w.cookie }),
    );
    const { challenge } = (await options.json()) as { challenge: string };
    await w.handle(
      post(
        "/auth/passkey/register/verify",
        { response: await soft.register(challenge, new TextEncoder().encode(w.user.id)) },
        { cookie: w.cookie },
      ),
    );
    w.auth.clock.advance(w.auth.config.session.freshMinutes * 60_000);
    expect((await w.handle(post("/auth/user/delete", {}, { cookie: w.cookie }))).status).toBe(403);
    const reauthOptions = await w.handle(
      post("/auth/reauth/passkey/options", {}, { cookie: w.cookie }),
    );
    const reauthChallenge = ((await reauthOptions.json()) as { challenge: string }).challenge;
    const reauth = await w.handle(
      post(
        "/auth/reauth",
        { passkey: await soft.authenticate(reauthChallenge) },
        { cookie: w.cookie },
      ),
    );
    expect(reauth.status).toBe(200);
    const deleted = await w.handle(post("/auth/user/delete", {}, { cookie: w.cookie }));
    expect(await deleted.json()).toEqual({ ok: true });
    expect(
      await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: w.user.id }]),
    ).toBeNull();
  });
});
