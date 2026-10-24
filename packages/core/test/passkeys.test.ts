import { describe, expect, it } from "vitest";
import {
  deletePasskey,
  listPasskeys,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { enablePasskeyMethod } from "../src/engine/second-factor-methods.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { passkeyRoutes } from "../src/http/routes/passkeys.js";
import { sessionRoutes } from "../src/http/routes/sessions.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { get, makeAuth, post } from "./helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";

const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
const ORIGIN = "https://app.example.com";

function passkeyAuth() {
  return makeAuth({ passkey: RP });
}

async function registered(auth: ReturnType<typeof makeAuth>, user: UserRow, name?: string) {
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: ORIGIN });
  const options = await passkeyRegistrationOptions(auth.config, { user });
  if (!options.ok) throw new Error(options.code);
  const r = await verifyPasskeyRegistration(auth.config, {
    user,
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
    name,
  });
  if (!r.ok) throw new Error(r.code);
  return { soft, summary: r.value };
}

async function challengeRows(auth: ReturnType<typeof makeAuth>) {
  return auth.storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "passkey-challenge" },
  ]);
}

describe("passkey registration", () => {
  it("writes a challenge row for the user and returns options that exclude existing passkeys", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { summary } = await registered(auth, user);
    const options = await passkeyRegistrationOptions(auth.config, { user });
    expect(options.ok).toBe(true);
    if (!options.ok) return;
    expect(options.value.rp).toEqual({ id: RP.rpID, name: RP.rpName });
    expect(options.value.user.name).toBe("ada@example.com");
    expect(options.value.excludeCredentials?.map((c) => c.id)).toEqual([summary.credentialId]);
    const rows = await challengeRows(auth);
    const open = rows.filter((r) => r.consumedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ identifier: user.id, data: { kind: "registration" } });
    expect(open[0]?.valueHash).toBe(await sha256Hex(options.value.challenge));
    expect(open[0]?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 5 * 60_000);
  });

  it("keeps a credential id of 1023 bytes and refuses one of 1024 (ruling 7 of plan 12g)", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const ceremony = async (bytes: number) => {
      const soft = await SoftAuthenticator.create({
        rpID: RP.rpID,
        origin: ORIGIN,
        credentialIdBytes: bytes,
      });
      const options = await passkeyRegistrationOptions(auth.config, { user });
      if (!options.ok) throw new Error(options.code);
      return verifyPasskeyRegistration(auth.config, {
        user,
        response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
      });
    };
    expect((await ceremony(1023)).ok).toBe(true);
    expect(await ceremony(1024)).toMatchObject({ ok: false, code: "passkey_failed" });
    const rows = await auth.storage.findMany("passkey", []);
    // 1023 bytes are 1364 base64url characters: the width of the MySQL column.
    expect(rows.map((r) => r.credentialId.length)).toEqual([1364]);
  });

  it("verifies, stores the passkey with its name, and consumes the challenge", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft, summary } = await registered(auth, user, "MacBook");
    expect(summary).toMatchObject({ name: "MacBook", deviceType: "singleDevice", backedUp: false });
    const rows = await auth.storage.findMany("passkey", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      credentialId: soft.credentialId,
      counter: 0,
      transports: "internal",
      name: "MacBook",
    });
    expect((await challengeRows(auth))[0]?.consumedAt).not.toBeNull();
  });

  it("refuses a user whose email is unverified (Review Focus 5)", async () => {
    const auth = passkeyAuth();
    const now = auth.clock.now();
    const user = await auth.storage.create("user", {
      id: "U0",
      email: "c@example.com",
      emailVerified: false,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    expect(await passkeyRegistrationOptions(auth.config, { user })).toMatchObject({
      ok: false,
      code: "email_unverified",
    });
    expect(await verifyPasskeyRegistration(auth.config, { user, response: {} })).toMatchObject({
      ok: false,
      code: "email_unverified",
    });
    expect(await auth.storage.findMany("passkey", [])).toHaveLength(0);
  });

  it("answers not_found when passkeys are not configured", async () => {
    const auth = makeAuth();
    const user = await auth.seedUser("ada@example.com");
    expect(await passkeyRegistrationOptions(auth.config, { user })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await passkeyAuthenticationOptions(auth.config, { ip: null })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("rejects an authentication challenge presented to registration and stores nothing", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: ORIGIN });
    const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!options.ok) throw new Error(options.code);
    const r = await verifyPasskeyRegistration(auth.config, {
      user,
      response: await soft.register(options.value.challenge),
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await auth.storage.findMany("passkey", [])).toHaveLength(0);
  });

  it("rejects a response from another origin and stores nothing (Review Focus 1)", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: "https://evil.example" });
    const options = await passkeyRegistrationOptions(auth.config, { user });
    if (!options.ok) throw new Error(options.code);
    const r = await verifyPasskeyRegistration(auth.config, {
      user,
      response: await soft.register(options.value.challenge),
    });
    expect(r).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(await auth.storage.findMany("passkey", [])).toHaveLength(0);
  });

  it("rejects a reused, expired, foreign, or malformed challenge with invalid_token or token_expired", async () => {
    const auth = passkeyAuth();
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: ORIGIN });
    const options = await passkeyRegistrationOptions(auth.config, { user: ada });
    if (!options.ok) throw new Error(options.code);
    const response = await soft.register(options.value.challenge);
    // Bob presents Ada's challenge.
    expect(await verifyPasskeyRegistration(auth.config, { user: bob, response })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    // Ada's row is consumed by that attempt, so Ada's own verify now fails too.
    expect(await verifyPasskeyRegistration(auth.config, { user: ada, response })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    const o2 = await passkeyRegistrationOptions(auth.config, { user: ada });
    if (!o2.ok) throw new Error(o2.code);
    auth.clock.advance(5 * 60_000);
    expect(
      await verifyPasskeyRegistration(auth.config, {
        user: ada,
        response: await soft.register(o2.value.challenge),
      }),
    ).toMatchObject({ ok: false, code: "token_expired" });
    expect(
      await verifyPasskeyRegistration(auth.config, {
        user: ada,
        response: { id: "x", response: { clientDataJSON: "!!" } },
      }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    expect(
      await verifyPasskeyRegistration(auth.config, { user: ada, response: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
  });

  it("rejects a registration challenge presented to the authentication verify (Review Focus 4)", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft } = await registered(auth, user);
    const options = await passkeyRegistrationOptions(auth.config, { user });
    if (!options.ok) throw new Error(options.code);
    const r = await verifyPasskeyAuthentication(auth.config, {
      response: await soft.authenticate(options.value.challenge),
      ip: null,
      userAgent: null,
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    expect((await challengeRows(auth)).every((row) => row.consumedAt !== null)).toBe(true);
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
  });

  it("refuses a credential id that another user already registered", async () => {
    const auth = passkeyAuth();
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    const { soft } = await registered(auth, ada);
    const options = await passkeyRegistrationOptions(auth.config, { user: bob });
    if (!options.ok) throw new Error(options.code);
    const r = await verifyPasskeyRegistration(auth.config, {
      user: bob,
      response: await soft.register(options.value.challenge),
    });
    expect(r).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(await auth.storage.findMany("passkey", [])).toHaveLength(1);
  });
});

describe("passkey authentication", () => {
  it("writes a sign-in challenge row and returns options with no allowed credentials", async () => {
    const auth = passkeyAuth();
    const options = await passkeyAuthenticationOptions(auth.config, { ip: "1.1.1.1" });
    expect(options.ok).toBe(true);
    if (!options.ok) return;
    expect(options.value.rpId).toBe(RP.rpID);
    expect(options.value.userVerification).toBe("required");
    const rows = await challengeRows(auth);
    expect(rows[0]).toMatchObject({ identifier: "sign-in", data: { kind: "authentication" } });
    expect(rows[0]?.valueHash).toBe(await sha256Hex(options.value.challenge));
  });

  it("signs in, updates the counter, and creates a session", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft } = await registered(auth, user);
    const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!options.ok) throw new Error(options.code);
    const r = await verifyPasskeyAuthentication(auth.config, {
      response: await soft.authenticate(options.value.challenge),
      ip: "2.2.2.2",
      userAgent: "ua",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.id).toBe(user.id);
    expect(r.value.token).toMatch(/^ts_/);
    expect((await resolveSession(auth.config, r.value.token))?.user.id).toBe(user.id);
    expect((await auth.storage.findMany("passkey", []))[0]?.counter).toBe(1);
  });

  it("signs in twice with an authenticator that always reports counter 0", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft } = await registered(auth, user);
    for (let i = 0; i < 2; i++) {
      const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
      if (!options.ok) throw new Error(options.code);
      const r = await verifyPasskeyAuthentication(auth.config, {
        response: await soft.authenticate(options.value.challenge, { counter: 0 }),
        ip: null,
        userAgent: null,
      });
      expect(r.ok).toBe(true);
    }
    expect((await auth.storage.findMany("passkey", []))[0]?.counter).toBe(0);
    expect(await auth.storage.findMany("session", [])).toHaveLength(2);
  });

  it("rejects a replayed response and keeps one session (Review Focus 2)", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft } = await registered(auth, user);
    const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!options.ok) throw new Error(options.code);
    const response = await soft.authenticate(options.value.challenge);
    expect(
      (await verifyPasskeyAuthentication(auth.config, { response, ip: null, userAgent: null })).ok,
    ).toBe(true);
    expect(
      await verifyPasskeyAuthentication(auth.config, { response, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  it("rejects a counter that does not advance and changes nothing (Review Focus 3)", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft } = await registered(auth, user);
    const first = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!first.ok) throw new Error(first.code);
    expect(
      (
        await verifyPasskeyAuthentication(auth.config, {
          response: await soft.authenticate(first.value.challenge),
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
    const second = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!second.ok) throw new Error(second.code);
    const clone = await verifyPasskeyAuthentication(auth.config, {
      response: await soft.authenticate(second.value.challenge, { counter: 1 }),
      ip: null,
      userAgent: null,
    });
    expect(clone).toMatchObject({ ok: false, code: "passkey_failed" });
    expect((await auth.storage.findMany("passkey", []))[0]?.counter).toBe(1);
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  // Plan 12i Task 9 (spec 32 item 3): a credential with no row answers passkey_unknown.
  it("answers passkey_unknown for an unknown credential and passkey_failed for a signature from another key", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft } = await registered(auth, user);
    const stranger = await SoftAuthenticator.create({ rpID: RP.rpID, origin: ORIGIN });
    const o1 = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!o1.ok) throw new Error(o1.code);
    expect(
      await verifyPasskeyAuthentication(auth.config, {
        response: await stranger.authenticate(o1.value.challenge),
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "passkey_unknown" });
    const o2 = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!o2.ok) throw new Error(o2.code);
    const forged = await stranger.authenticate(o2.value.challenge);
    forged.id = soft.credentialId;
    forged.rawId = soft.credentialId;
    expect(
      await verifyPasskeyAuthentication(auth.config, {
        response: forged,
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
  });

  it("limits options to 30 and verifies to 20 per ip per 15 minutes", async () => {
    const auth = passkeyAuth();
    for (let i = 0; i < 30; i++)
      expect((await passkeyAuthenticationOptions(auth.config, { ip: "9.9.9.9" })).ok).toBe(true);
    expect(await passkeyAuthenticationOptions(auth.config, { ip: "9.9.9.9" })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    for (let i = 0; i < 20; i++) {
      expect(
        await verifyPasskeyAuthentication(auth.config, {
          response: null,
          ip: "8.8.8.8",
          userAgent: null,
        }),
      ).toMatchObject({ ok: false, code: "invalid_token" });
    }
    expect(
      await verifyPasskeyAuthentication(auth.config, {
        response: null,
        ip: "8.8.8.8",
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("refuses a sign-in when the stored counter moved after it was read", async () => {
    const auth = passkeyAuth();
    const user = await auth.seedUser("ada@example.com");
    const { soft } = await registered(auth, user);
    const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!options.ok) throw new Error(options.code);
    const response = await soft.authenticate(options.value.challenge);
    // A concurrent replay moves the counter between our read and our write.
    const inner = auth.config.storage;
    const racing: StorageAdapter = {
      createMany: (m, r) => inner.createMany(m, r),
      rowsPerInsert: (m) => inner.rowsPerInsert(m),
      create: (m, d) => inner.create(m, d),
      findOne: (m, w) => inner.findOne(m, w),
      findMany: (m, w, o) => inner.findMany(m, w, o),
      update: async (m, w, d) => {
        if (m === "passkey") {
          await inner.update(
            "passkey",
            [{ field: "credentialId", op: "eq", value: soft.credentialId }],
            { counter: 7 },
          );
        }
        return inner.update(m, w, d);
      },
      delete: (m, w) => inner.delete(m, w),
      transaction: (fn) => inner.transaction(fn),
    };
    const r = await verifyPasskeyAuthentication(
      { ...auth.config, storage: racing },
      { response, ip: null, userAgent: null },
    );
    expect(r).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
    expect((await auth.storage.findMany("passkey", []))[0]?.counter).toBe(7);
  });
});

describe("passkey list and delete", () => {
  it("lists the user's passkeys only and deletes one of their own", async () => {
    const auth = passkeyAuth();
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    const a = await registered(auth, ada, "Laptop");
    await registered(auth, bob, "Phone");
    const list = await listPasskeys(auth.config, { user: ada });
    expect(list.ok && list.value.map((p) => p.name)).toEqual(["Laptop"]);
    expect(await deletePasskey(auth.config, { user: bob, id: a.summary.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await deletePasskey(auth.config, { user: ada, id: a.summary.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await auth.storage.findMany("passkey", [])).toHaveLength(1);
  });
});

describe("passkey routes", () => {
  async function signedIn(auth: ReturnType<typeof makeAuth>, email = "ada@example.com") {
    const user = await auth.seedUser(email);
    const { token } = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    return { user, cookie: `__Host-tempo_session=${token}` };
  }

  it("registers and signs in through the routes, with the cookie on sign-in", async () => {
    const auth = passkeyAuth();
    const handle = createRouter(auth.config, [
      ...sessionRoutes(auth.config),
      ...passkeyRoutes(auth.config),
    ]);
    const { cookie } = await signedIn(auth);
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: ORIGIN });
    const options = await handle(post("/auth/passkey/register/options", {}, { cookie }));
    expect(options.status).toBe(200);
    const creation = (await options.json()) as { challenge: string };
    const verify = await handle(
      post(
        "/auth/passkey/register/verify",
        { response: await soft.register(creation.challenge), name: "Laptop" },
        { cookie },
      ),
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({
      passkey: { name: "Laptop", deviceType: "singleDevice" },
    });
    const list = await handle(get("/auth/passkeys", { cookie }));
    expect(((await list.json()) as { passkeys: unknown[] }).passkeys).toHaveLength(1);
    const request = await handle(post("/auth/passkey/authenticate/options", {}));
    expect(request.status).toBe(200);
    const req = (await request.json()) as { challenge: string };
    const signIn = await handle(
      post("/auth/passkey/authenticate/verify", {
        response: await soft.authenticate(req.challenge),
      }),
    );
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ user: { email: "ada@example.com" } });
    expect(signIn.headers.get("set-cookie")).toMatch(
      /^__Host-tempo_session=ts_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(await auth.storage.findMany("session", [])).toHaveLength(2);
  });

  it("renews the sliding-refresh cookie on a session route, once", async () => {
    const auth = passkeyAuth();
    const handle = createRouter(auth.config, passkeyRoutes(auth.config));
    const { cookie } = await signedIn(auth);
    auth.clock.advance(8 * 86_400_000);
    const first = await handle(get("/auth/passkeys", { cookie }));
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toMatch(
      /^__Host-tempo_session=ts_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/,
    );
    const second = await handle(get("/auth/passkeys", { cookie }));
    expect(second.status).toBe(200);
    expect(second.headers.get("set-cookie")).toBeNull();
  });

  it("answers 401 without a session on the registration and management routes", async () => {
    const auth = passkeyAuth();
    const handle = createRouter(auth.config, passkeyRoutes(auth.config));
    expect((await handle(post("/auth/passkey/register/options", {}))).status).toBe(401);
    expect((await handle(post("/auth/passkey/register/verify", { response: {} }))).status).toBe(
      401,
    );
    expect((await handle(get("/auth/passkeys"))).status).toBe(401);
    expect((await handle(post("/auth/passkeys/delete", { id: "x" }))).status).toBe(401);
  });

  it("answers 400 on a bad body, 404 on a foreign delete, and 403 for an unverified user", async () => {
    const auth = passkeyAuth();
    const handle = createRouter(auth.config, passkeyRoutes(auth.config));
    const { cookie } = await signedIn(auth);
    expect(
      (await handle(post("/auth/passkey/register/verify", { nope: 1 }, { cookie }))).status,
    ).toBe(400);
    expect(
      (await handle(post("/auth/passkey/authenticate/verify", { response: "x" }))).status,
    ).toBe(400);
    expect((await handle(post("/auth/passkeys/delete", { id: "nope" }, { cookie }))).status).toBe(
      404,
    );
    const now = auth.clock.now();
    const u = await auth.storage.create("user", {
      id: "U9",
      email: "u@example.com",
      emailVerified: false,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    const { token } = await createSession(auth.config, { userId: u.id, ip: null, userAgent: null });
    const res = await handle(
      post("/auth/passkey/register/options", {}, { cookie: `__Host-tempo_session=${token}` }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "email_unverified" });
  });

  it("registers no passkey route when passkeys are off", async () => {
    const auth = makeAuth();
    const handle = createRouter(auth.config, passkeyRoutes(auth.config));
    expect((await handle(post("/auth/passkey/authenticate/options", {}))).status).toBe(404);
  });
});

describe("the last passkey of the passkey method (plan 12c)", () => {
  it("refuses the delete of the last passkey while the passkey method is on, and one of two parallel deletes wins", async () => {
    const auth = makeAuth({ passkey: RP, password: { hash: FAST } });
    await signUpAndVerify(auth, "ada@example.com", "correct horse battery");
    const user = await auth.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@example.com" },
    ]);
    if (!user) throw new Error("no user");
    const one = await registered(auth, user, "one");
    const two = await registered(auth, user, "two");
    const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
    if (!options.ok) throw new Error(options.code);
    const session = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    const resolved = await resolveSession(auth.config, session.token);
    if (!resolved) throw new Error("no session");
    const on = await enablePasskeyMethod(auth.config, {
      session: resolved,
      password: "correct horse battery",
      response: await one.soft.authenticate(options.value.challenge),
    });
    if (!on.ok) throw new Error(on.code);
    const answers = await Promise.all([
      deletePasskey(auth.config, { user, id: one.summary.id }),
      deletePasskey(auth.config, { user, id: two.summary.id }),
    ]);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok).map((a) => (a.ok ? null : a.code))).toEqual([
      expect.stringMatching(/^(second_factor_last_method|conflict)$/),
    ]);
    const left = await auth.storage.findMany("passkey", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(left).toHaveLength(1);
    expect(await deletePasskey(auth.config, { user, id: left[0]?.id ?? "" })).toEqual({
      ok: false,
      code: "second_factor_last_method",
      status: 409,
    });
    // The refusal undoes the delete: the last passkey stays.
    expect(
      await auth.storage.findMany("passkey", [{ field: "userId", op: "eq", value: user.id }]),
    ).toHaveLength(1);
  });
});
