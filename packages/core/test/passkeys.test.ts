import { describe, expect, it } from "vitest";
import {
  deletePasskey,
  listPasskeys,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { resolveSession } from "../src/engine/sessions.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { makeAuth } from "./helpers.js";

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

  it("answers passkey_failed for an unknown credential and for a signature from another key", async () => {
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
    ).toMatchObject({ ok: false, code: "passkey_failed" });
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
