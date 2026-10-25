import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
import {
  passkeyRegistrationOptions,
  renamePasskey,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { UserRow } from "../src/schema.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, BASE_URL, get, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type Auth, totpAuth, verifiedSession } from "./totp-helpers.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const SECRET = "0123456789abcdef0123456789abcdef";
const RP = { rpID: "api.example.com", rpName: "Example", origins: [BASE_URL] };

afterEach(() => {
  vi.restoreAllMocks();
});

/** A passkey of the user by the register ceremony, as the product makes one. */
async function addPasskey(auth: Auth, user: UserRow, name?: string) {
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE_URL });
  const options = await passkeyRegistrationOptions(auth.config, { user });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(auth.config, {
    user,
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
    ...(name !== undefined ? { name } : {}),
  });
  if (!added.ok) throw new Error(added.code);
  return added.value;
}

/**
 * Two verified users with a password sign-in each, and one passkey each by
 * the register ceremony. The fresh window is 10 minutes.
 */
async function world() {
  const auth = totpAuth({ passkey: RP, session: { freshMinutes: 10 } });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const ada = await verifiedSession(auth);
  const bob = await verifiedSession(auth, "bob@example.com");
  const adaKey = await addPasskey(auth, ada.user, "Phone");
  const bobKey = await addPasskey(auth, bob.user, "Bob's key");
  const cookie = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  const rename = (token: string, body: unknown) =>
    handle(post("/auth/passkeys/rename", body, cookie(token)));
  const rows = () => auth.storage.findMany("passkey", [], { sort: { field: "id", dir: "asc" } });
  return { auth, handle, ada, bob, adaKey, bobKey, cookie, rename, rows };
}

/** The names that the rule refuses, with the reason of each. */
const REFUSED: [string, string][] = [
  ["empty", ""],
  ["65 code units", "x".repeat(65)],
  ["a C0 control (BEL)", "a\u0007b"],
  ["DEL", "a\u007fb"],
  ["a C1 control", "a\u0085b"],
  ["a right-to-left override", "Phone‮gnp.exe"],
  ["a zero-width space", "Pho​ne"],
  ["a line separator", "a b"],
  ["a lone surrogate", "a\ud800b"],
];

/** The names that the rule takes. */
const TAKEN: [string, string][] = [
  ["64 code units", "x".repeat(64)],
  ["a space inside", "Work laptop"],
  ["a Persian name with a zero-width non-joiner", "می‌رود"],
  ["an emoji joined by a zero-width joiner", "\u{1f469}‍\u{1f4bb} key"],
];

describe("POST /passkeys/rename (plan 12a Task 19)", () => {
  it("renames the caller's passkey", async () => {
    const w = await world();
    const before = await w.rows();
    w.auth.clock.advance(MINUTE);
    const res = await w.rename(w.ada.token, { id: w.adaKey.id, name: "Work laptop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passkey: Record<string, unknown> };
    expect(body).toEqual({
      passkey: {
        id: w.adaKey.id,
        credentialId: w.adaKey.credentialId,
        name: "Work laptop",
        deviceType: w.adaKey.deviceType,
        backedUp: w.adaKey.backedUp,
        discoverable: w.adaKey.discoverable,
        prf: w.adaKey.prf,
        largeBlob: w.adaKey.largeBlob,
        createdAt: w.adaKey.createdAt.toISOString(),
      },
    });
    const list = await w.handle(get("/auth/passkeys", w.cookie(w.ada.token)));
    expect(((await list.json()) as { passkeys: { name: string }[] }).passkeys).toEqual([
      expect.objectContaining({ id: w.adaKey.id, name: "Work laptop" }),
    ]);
    // Only the name and updatedAt of the one row move.
    const after = await w.rows();
    const was = before.find((r) => r.id === w.adaKey.id);
    if (!was) throw new Error("no row");
    expect(after).toEqual(
      before.map((r) =>
        r.id === w.adaKey.id ? { ...was, name: "Work laptop", updatedAt: w.auth.clock.now() } : r,
      ),
    );
  });

  it("answers not_found for another user's passkey and changes nothing", async () => {
    const w = await world();
    const before = await w.rows();
    const res = await w.rename(w.ada.token, { id: w.bobKey.id, name: "Mine now" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await w.rows()).toEqual(before);
  });

  it("answers another user's id and an unknown id by the same storage calls and the same answer", async () => {
    const w = await world();
    const storage = w.auth.config.storage;
    /** The engine's storage calls and limit counts for one id, after the route read the session. */
    const seen = async (id: string) => {
      const spies = {
        update: vi.spyOn(storage, "update"),
        findOne: vi.spyOn(storage, "findOne"),
        findMany: vi.spyOn(storage, "findMany"),
        create: vi.spyOn(storage, "create"),
        delete: vi.spyOn(storage, "delete"),
        transaction: vi.spyOn(storage, "transaction"),
        allow: vi.spyOn(w.auth.config.limiter, "allow"),
      };
      const r = await renamePasskey(w.auth.config, { user: w.ada.user, id, name: "Mine now" });
      const trace = {
        r,
        ...Object.fromEntries(
          Object.entries(spies).map(([k, spy]) => [k, spy.mock.calls.map((c) => c[0])]),
        ),
      };
      vi.restoreAllMocks();
      return trace;
    };
    const other = await seen(w.bobKey.id);
    const unknown = await seen("pk_unknown");
    expect(other).toEqual({
      r: { ok: false, code: "not_found", status: 404 },
      update: ["passkey"],
      findOne: [],
      findMany: [],
      create: [],
      delete: [],
      transaction: [],
      allow: [`passkey-rename:user:${w.ada.user.id}`],
    });
    expect(unknown).toEqual(other);
  });

  it.each(REFUSED)(
    "refuses %s with invalid_body, counts no try, and writes nothing",
    async (_, name) => {
      const w = await world();
      const before = await w.rows();
      const allow = vi.spyOn(w.auth.config.limiter, "allow");
      const res = await w.rename(w.ada.token, { id: w.adaKey.id, name });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
      expect(allow).not.toHaveBeenCalled();
      expect(await w.rows()).toEqual(before);
    },
  );

  it.each(TAKEN)("takes %s", async (_, name) => {
    const w = await world();
    const res = await w.rename(w.ada.token, { id: w.adaKey.id, name });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { passkey: { name: string } }).passkey.name).toBe(name);
  });

  it("refuses a body that is not { id, name }", async () => {
    const w = await world();
    const before = await w.rows();
    for (const body of [
      {},
      { id: w.adaKey.id },
      { name: "Phone 2" },
      { id: w.adaKey.id, name: 7 },
      { id: "", name: "Phone 2" },
      { id: "x".repeat(65), name: "Phone 2" },
      { id: w.adaKey.id, name: "Phone 2", userId: w.bob.user.id },
      [],
    ]) {
      const res = await w.rename(w.ada.token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await w.rows()).toEqual(before);
  });

  it("answers 401 with no session", async () => {
    const w = await world();
    const before = await w.rows();
    const res = await w.handle(post("/auth/passkeys/rename", { id: w.adaKey.id, name: "Phone 2" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await w.rows()).toEqual(before);
  });

  it("answers rate_limited after 30 renames in 15 minutes", async () => {
    const w = await world();
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    for (let i = 0; i < 30; i++)
      expect((await w.rename(w.ada.token, { id: w.adaKey.id, name: `Phone ${i}` })).status).toBe(
        200,
      );
    const held = await w.rename(w.ada.token, { id: w.adaKey.id, name: "Phone 30" });
    expect(held.status).toBe(429);
    expect(await held.json()).toEqual({ error: "rate_limited" });
    expect(allow).toHaveBeenLastCalledWith(`passkey-rename:user:${w.ada.user.id}`, {
      seconds: 900,
      max: 30,
    });
    expect((await w.rows()).find((r) => r.id === w.adaKey.id)?.name).toBe("Phone 29");
    // Another user has a key of its own.
    expect((await w.rename(w.bob.token, { id: w.bobKey.id, name: "Bob 2" })).status).toBe(200);
    // 1 ms before the window of the first rename ends, the key still refuses.
    w.auth.clock.advance(15 * MINUTE - 1);
    expect((await w.rename(w.ada.token, { id: w.adaKey.id, name: "Phone 31" })).status).toBe(429);
    w.auth.clock.advance(1);
    expect((await w.rename(w.ada.token, { id: w.adaKey.id, name: "Phone 32" })).status).toBe(200);
  });

  it("needs no fresh session, and sends the renewed cookie on the answer and on a refusal", async () => {
    const w = await world();
    // Past the fresh window and at the sliding refresh: the rename still passes.
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const renewed = `${w.auth.config.cookieName}=${w.ada.token};`;
    const res = await w.rename(w.ada.token, { id: w.adaKey.id, name: "Old phone" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toContain(renewed);
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const bad = await w.rename(w.ada.token, { id: w.adaKey.id, name: "" });
    expect(bad.status).toBe(400);
    expect(bad.headers.getSetCookie().join("\n")).toContain(renewed);
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const missing = await w.rename(w.ada.token, { id: w.bobKey.id, name: "Old phone" });
    expect(missing.status).toBe(404);
    expect(missing.headers.getSetCookie().join("\n")).toContain(renewed);
    // A body that the parser refuses, before the engine runs.
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const parsed = await w.rename(w.ada.token, { id: w.adaKey.id, name: 7 });
    expect(parsed.status).toBe(400);
    expect(parsed.headers.getSetCookie().join("\n")).toContain(renewed);
  });

  it("answers not_found with no passkey config, and counts no try", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    const allow = vi.spyOn(auth.config.limiter, "allow");
    expect(
      await renamePasskey(auth.config, { user: s.user, id: "pk_x", name: "Phone" }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(allow).not.toHaveBeenCalled();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(
      post(
        "/auth/passkeys/rename",
        { id: "pk_x", name: "Phone" },
        {
          cookie: `${auth.config.cookieName}=${s.token}`,
        },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("serves renamePasskey on the engine call", async () => {
    const base = totpAuth({ passkey: RP });
    const api = createAuth({
      baseURL: BASE_URL,
      secret: SECRET,
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      clock: base.clock,
      password: { hash: FAST, uniformSignUp: false },
      passkey: RP,
      mail: { send: async () => {} },
    }).api;
    const s = await verifiedSession(base);
    const key = await addPasskey(base, s.user);
    const r = await api.renamePasskey({ user: s.user, id: key.id, name: "Api key" });
    expect(r.ok && r.value.passkey).toMatchObject({ id: key.id, name: "Api key" });
    expect(await api.renamePasskey({ user: s.user, id: key.id, name: "a‮b" })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
  });
});

describe("the passkey name at the registration (plan 12a Task 19, review M2)", () => {
  /** A register ceremony through the route, with the body's name. */
  async function register(name: string | undefined) {
    const auth = totpAuth({ passkey: RP });
    const s = await verifiedSession(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE_URL });
    const options = await passkeyRegistrationOptions(auth.config, { user: s.user });
    if (!options.ok) throw new Error(options.code);
    const response = await soft.register(
      options.value.challenge,
      new TextEncoder().encode(s.user.id),
    );
    const res = await handle(
      post(
        "/auth/passkey/register/verify",
        { response, ...(name !== undefined ? { name } : {}) },
        { cookie: `${auth.config.cookieName}=${s.token}` },
      ),
    );
    return { res, rows: await auth.storage.findMany("passkey", []) };
  }

  /** Names that registered before Task 19, and the other names that the rename refuses. */
  const STORED_AS_NONE: [string, string][] = [
    ["an empty name", ""],
    ["a blank name", "   "],
    [
      "the England flag (tag characters)",
      "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} key",
    ],
    ["a soft hyphen", "caf\u00ade"],
    ["a right-to-left override", "Phone\u202egnp.exe"],
    ["65 code units", "x".repeat(65)],
  ];

  it.each(STORED_AS_NONE)("keeps the credential for %s, and stores no name", async (_, name) => {
    const { res, rows } = await register(name);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { passkey: { name: unknown } }).passkey.name).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBeNull();
  });

  it("stores a name of the rule as given, and no name when the body has none", async () => {
    const given = await register("\u{1f469}\u200d\u{1f4bb} key");
    expect(given.res.status).toBe(200);
    expect(given.rows.map((r) => r.name)).toEqual(["\u{1f469}\u200d\u{1f4bb} key"]);
    const none = await register(undefined);
    expect(none.res.status).toBe(200);
    expect(none.rows.map((r) => r.name)).toEqual([null]);
  });
});
