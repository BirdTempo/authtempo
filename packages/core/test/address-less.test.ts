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
import { requestReauthCode } from "../src/engine/reauth.js";
import { createSession, type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { draftUserRow, mayCreateUser } from "../src/engine/users.js";
import { decodeJws } from "../src/primitives/jwk.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
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

/** A session of `user`, as a sign-in opens it. */
async function sessionOf(auth: Auth, user: UserRow): Promise<ResolvedSession> {
  const { token } = await createSession(auth.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
  });
  const resolved = await resolveSession(auth.config, token);
  if (!resolved) throw new Error("no session");
  return resolved;
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

  it("counts no stored phone as a way in or a handle with no phone config (ruling 15)", async () => {
    // A Better Auth store holds a phone that its own code verify proved. With
    // no `phone` config no phone code exists, so the phone signs in nowhere.
    const auth = makeAuth({ passkey: RP });
    const phoned = await auth.storage.create(
      "user",
      draftUserRow(
        { email: null, emailVerified: false, name: null, phone: "+14155550100" },
        auth.clock.now(),
      ),
    );
    expect(await verifiedHandle(auth.config, auth.storage, phoned)).toBe(false);
    expect(await waysIn(auth.config, auth.storage, phoned)).toBe(0);
    await withPasskey(auth, phoned);
    expect(await waysIn(auth.config, auth.storage, phoned)).toBe(1);
    const [passkey] = await auth.storage.findMany("passkey", [
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
    // The same stored phone as the test before: a Better Auth store holds one
    // that its code verify proved. Core's own verify of a phone is Task 5.
    const phone = (regions: string[]) =>
      makeAuth({
        passkey: RP,
        phone: { sms: createRecordingSms(), regions, isolateLimiter: "allow" },
      });
    const on = phone(["+1"]);
    const phoned = await on.storage.create(
      "user",
      draftUserRow(
        { email: null, emailVerified: false, name: null, phone: "+14155550100" },
        on.clock.now(),
      ),
    );
    expect(await verifiedHandle(on.config, on.storage, phoned)).toBe(true);
    expect(await waysIn(on.config, on.storage, phoned)).toBe(1);
    // With a passkey too, the passkey can go: the phone stays a way in.
    await withPasskey(on, phoned);
    expect(await waysIn(on.config, on.storage, phoned)).toBe(2);
    const [passkey] = await on.storage.findMany("passkey", [
      { field: "userId", op: "eq", value: phoned.id },
    ]);
    if (!passkey) throw new Error("no passkey");
    expect(await deletePasskey(on.config, { user: phoned, id: passkey.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    // A number outside every region gets no code, so it is no way in and no handle.
    const elsewhere = phone(["+44"]);
    const far = await elsewhere.storage.create(
      "user",
      draftUserRow(
        { email: null, emailVerified: false, name: null, phone: "+14155550100" },
        elsewhere.clock.now(),
      ),
    );
    expect(await verifiedHandle(elsewhere.config, elsewhere.storage, far)).toBe(false);
    expect(await waysIn(elsewhere.config, elsewhere.storage, far)).toBe(0);
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
