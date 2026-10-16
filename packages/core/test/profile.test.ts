import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { hookRefusal, type UserHooks } from "../src/engine/hooks.js";
import { type ProfileUpdate, unchanged, updateProfile } from "../src/engine/profile.js";
import { later } from "../src/engine/second-factor.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial } from "../src/engine/social.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { UserRow } from "../src/schema.js";
import type { Where } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  googleClaims,
  socialAuth,
  startGoogle,
} from "./social-helpers.js";
import { type Auth, EMAIL, totpAuth, verifiedSession } from "./totp-helpers.js";

const IMAGE = "https://img.example.com/ada.png";
const DAY = 86_400_000;
// The secret of makeAuth, so the api reads the sessions that the test config wrote.
const SECRET = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.restoreAllMocks();
});

type ProfilePatch = Omit<ProfileUpdate, "session">;

const byId = (id: string): Where<"user">[] => [{ field: "id", op: "eq", value: id }];

async function userRow(auth: Auth, id: string): Promise<UserRow> {
  const row = await auth.storage.findOne("user", byId(id));
  if (!row) throw new Error("no user row");
  return row;
}

/** An auth whose user hooks read `auth` itself, so a hook can write as a parallel request does. */
function hooked(make: (get: () => Auth) => UserHooks): Auth {
  let auth: Auth | null = null;
  const get = () => {
    if (!auth) throw new Error("no auth yet");
    return auth;
  };
  auth = totpAuth({ hooks: { user: make(get) } });
  return auth;
}

/** A signed-in claimant: a social sign-in with an address that the provider did not verify. */
async function claimant() {
  const jwtTokens: Record<string, FakeIdToken> = {};
  const social = socialAuth({}, fakeJwt(jwtTokens));
  const st = await startGoogle(social);
  jwtTokens["idtok-default"] = googleClaims(st.nonce, {
    email: "claim@example.com",
    email_verified: false,
    name: "Claimed",
  });
  const done = await completeSocial(social.config, {
    provider: "google",
    state: st.state,
    code: "c",
    error: null,
    bindToken: st.bindToken,
    ip: null,
    userAgent: null,
  });
  if (!done.ok || !("token" in done.value)) throw new Error("the social sign-in opened no session");
  const s = await resolveSession(social.config, done.value.token);
  if (!s) throw new Error("no session");
  return { social, s, token: done.value.token };
}

describe("the profile update (plan 12a)", () => {
  it("writes only the given fields, clears one with null, and answers the public user", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    expect(await updateProfile(auth.config, { session: s, image: IMAGE })).toMatchObject({
      ok: true,
    });
    const named = await updateProfile(auth.config, { session: s, name: "Ada Lovelace" });
    expect(named).toEqual({
      ok: true,
      value: {
        user: {
          id: s.user.id,
          email: s.user.email,
          emailVerified: true,
          name: "Ada Lovelace",
          image: IMAGE,
        },
      },
    });
    expect(await userRow(auth, s.user.id)).toMatchObject({ name: "Ada Lovelace", image: IMAGE });
    const cleared = await updateProfile(auth.config, { session: s, image: null });
    expect(cleared.ok && cleared.value.user).toMatchObject({ name: "Ada Lovelace", image: null });
    expect(await userRow(auth, s.user.id)).toMatchObject({ name: "Ada Lovelace", image: null });
    const both = await updateProfile(auth.config, { session: s, name: null, image: IMAGE });
    expect(both.ok && both.value.user).toMatchObject({ name: null, image: IMAGE });
    expect(await userRow(auth, s.user.id)).toMatchObject({ name: null, image: IMAGE });
  });

  it("moves updatedAt past the row it read, and keeps the address and the verified flag", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    const before = await userRow(auth, s.user.id);
    expect((await updateProfile(auth.config, { session: s, name: "Ada" })).ok).toBe(true);
    const after = await userRow(auth, s.user.id);
    // The fake clock stands still, so the write time is the read time plus 1 ms.
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime() + 1);
    expect(after).toEqual({ ...before, name: "Ada", updatedAt: after.updatedAt });
  });

  it("refuses an unverified user and leaves the claimant's row", async () => {
    const { social, s } = await claimant();
    expect(s.user.emailVerified).toBe(false);
    const before = await social.storage.findOne("user", byId(s.user.id));
    expect(await updateProfile(social.config, { session: s, name: "Mallory" })).toEqual({
      ok: false,
      code: "email_unverified",
      status: 403,
    });
    expect(await updateProfile(social.config, { session: s, image: null })).toMatchObject({
      code: "email_unverified",
    });
    expect(await social.storage.findOne("user", byId(s.user.id))).toEqual(before);
  });

  it("refuses an empty patch, a bad name, and a bad image, and writes nothing", async () => {
    const seen: string[] = [];
    const auth = hooked(() => ({
      beforeUpdate: (e) => {
        seen.push(JSON.stringify(e.patch));
      },
    }));
    const s = await verifiedSession(auth);
    const before = await userRow(auth, s.user.id);
    for (const patch of [
      {},
      { name: undefined, image: undefined },
      { name: "" },
      { name: "line\nbreak" },
      { name: "a".repeat(201) },
      { name: "Ada", image: "http://img.example.com/a.png" },
      { image: "http://img.example.com/a.png" },
      { image: "data:image/png;base64,AAAA" },
      { image: "https://user:pw@img.example.com/a.png" },
      { image: `https://img.example.com/${"a".repeat(2048)}` },
      { image: "https://img.example.com/a b.png" },
      { image: "https://img.example.com/‮gnp.a" },
      { image: "https:///img.example.com/a.png" },
    ])
      expect({ patch, r: await updateProfile(auth.config, { session: s, ...patch }) }).toEqual({
        patch,
        r: { ok: false, code: "invalid_body", status: 400 },
      });
    // A JS caller of api.user.update can pass an array (review L1).
    for (const patch of [{ name: ["Ada"] }, { image: [IMAGE] }] as unknown as ProfilePatch[])
      expect(await updateProfile(auth.config, { session: s, ...patch })).toEqual({
        ok: false,
        code: "invalid_body",
        status: 400,
      });
    expect(seen).toEqual([]);
    expect(await userRow(auth, s.user.id)).toEqual(before);
    // The bounds: 200 code units for a name, 2048 characters for an image.
    const long = `https://img.example.com/${"a".repeat(2048 - 24)}`;
    expect(long.length).toBe(2048);
    expect(
      (await updateProfile(auth.config, { session: s, name: "a".repeat(200), image: long })).ok,
    ).toBe(true);
  });
});

describe("the user hooks of the profile update (plan 12a)", () => {
  it("runs user.beforeUpdate inside the write and user.afterUpdate with the previous row", async () => {
    const seen: string[] = [];
    const auth = totpAuth({
      hooks: {
        user: {
          beforeUpdate: (e) => {
            seen.push(`before:${e.via}:${JSON.stringify(e.patch)}`);
            if (e.patch.name === "Refused") throw hookRefusal("Pick another name.");
          },
          afterUpdate: (e) => {
            seen.push(`after:${e.via}:${e.previous.name ?? "-"}:${e.user.name ?? "-"}`);
          },
        },
      },
    });
    const s = await verifiedSession(auth);
    expect((await updateProfile(auth.config, { session: s, name: "Ada" })).ok).toBe(true);
    expect(await updateProfile(auth.config, { session: s, name: "Refused" })).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Pick another name.",
    });
    expect((await updateProfile(auth.config, { session: s, name: null })).ok).toBe(true);
    expect(seen).toEqual([
      'before:profile:{"name":"Ada"}',
      "after:profile:-:Ada",
      'before:profile:{"name":"Refused"}',
      'before:profile:{"name":null}',
      "after:profile:Ada:-",
    ]);
  });

  it("gives user.beforeUpdate the stored row and user.afterUpdate the stored row after the write", async () => {
    const before: unknown[] = [];
    const after: unknown[] = [];
    const auth = totpAuth({
      hooks: {
        user: {
          beforeUpdate: (e) => {
            before.push(e);
          },
          afterUpdate: (e) => {
            after.push(e);
          },
        },
      },
    });
    const s = await verifiedSession(auth);
    const old = await userRow(auth, s.user.id);
    expect((await updateProfile(auth.config, { session: s, image: IMAGE })).ok).toBe(true);
    const stored = await userRow(auth, s.user.id);
    expect(before).toEqual([{ user: old, patch: { image: IMAGE }, via: "profile" }]);
    expect(after).toEqual([{ user: stored, previous: old, via: "profile" }]);
  });

  it("a refusal or a throw of user.beforeUpdate leaves the row as it was", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    const auth = hooked(() => ({
      beforeUpdate: (e) => {
        if (e.patch.name === "Refused") throw hookRefusal("No.");
        if (e.patch.image !== undefined) throw new TypeError(`bad ${e.user.email}`);
      },
      afterUpdate: after,
    }));
    const s = await verifiedSession(auth);
    const before = await userRow(auth, s.user.id);
    expect(await updateProfile(auth.config, { session: s, name: "Refused" })).toMatchObject({
      code: "hook_refused",
    });
    expect(await updateProfile(auth.config, { session: s, image: IMAGE })).toEqual({
      ok: false,
      code: "hook_failed",
      status: 500,
    });
    expect(await userRow(auth, s.user.id)).toEqual(before);
    expect(after).not.toHaveBeenCalled();
    // A refusal logs nothing; a throw logs the hook name and the error name, never the address.
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "user.beforeUpdate", "TypeError"],
    ]);
  });

  it("keeps the write and logs one line when user.afterUpdate throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = totpAuth({
      hooks: {
        user: {
          afterUpdate: () => {
            throw new RangeError(EMAIL);
          },
        },
      },
    });
    const s = await verifiedSession(auth);
    expect(await updateProfile(auth.config, { session: s, name: "Ada" })).toMatchObject({
      ok: true,
      value: { user: { name: "Ada" } },
    });
    expect((await userRow(auth, s.user.id)).name).toBe("Ada");
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "user.afterUpdate", s.user.id, "RangeError"],
    ]);
  });
});

describe("the races of the profile update (plan 12a)", () => {
  it("a parallel write between the read and the write: one winner per round, and afterUpdate gets the row the update replaced", async () => {
    const seen: (string | null)[] = [];
    const after: { previous: UserRow; user: UserRow }[] = [];
    const auth = hooked((get) => ({
      beforeUpdate: async (e) => {
        seen.push(e.user.name);
        // The first round: a parallel profile update of the name lands, with its own write.
        if (seen.length === 1)
          await get().storage.update("user", byId(e.user.id), {
            name: "Other",
            updatedAt: later(get().clock.now(), e.user.updatedAt),
          });
      },
      afterUpdate: (e) => {
        after.push(e);
      },
    }));
    const s = await verifiedSession(auth);
    const r = await updateProfile(auth.config, { session: s, image: IMAGE });
    expect(r).toMatchObject({ ok: true, value: { user: { name: "Other", image: IMAGE } } });
    // The lost round read the row again and ran the hook again with it.
    expect(seen).toEqual([null, "Other"]);
    const stored = await userRow(auth, s.user.id);
    expect(stored).toMatchObject({ name: "Other", image: IMAGE });
    expect(after).toHaveLength(1);
    expect(after[0]?.previous).toMatchObject({ name: "Other", image: null });
    expect(after[0]?.user).toEqual(stored);
  });

  // writeFill (social.ts) writes `updatedAt: now`. On a clock that stands still, that is the read's updatedAt.
  it.each([
    ["the image, while the update writes the name", "image", { name: "Ada" }],
    ["the name, while the update writes the image", "name", { image: IMAGE }],
  ] as const)(
    "sees a parallel social fill of %s in the same millisecond",
    async (_, field, patch) => {
      const after: { previous: UserRow }[] = [];
      const filled = field === "image" ? "https://lh3.example.com/fill.png" : "Filled";
      let rounds = 0;
      const auth = hooked((get) => ({
        beforeUpdate: async (e) => {
          rounds++;
          if (rounds > 1) return;
          if (get().clock.now().getTime() !== e.user.updatedAt.getTime())
            throw new Error("the clock moved");
          await get().storage.update("user", byId(e.user.id), {
            [field]: filled,
            updatedAt: get().clock.now(),
          });
        },
        afterUpdate: (e) => {
          after.push(e);
        },
      }));
      const s = await verifiedSession(auth);
      const r = await updateProfile(auth.config, { session: s, ...patch });
      expect(r).toMatchObject({ ok: true, value: { user: { ...patch, [field]: filled } } });
      expect(rounds).toBe(2);
      expect(after[0]?.previous).toMatchObject({ [field]: filled });
    },
  );

  // The change of address and the profile update both write through this one
  // compare-and-set. The address and the flag clauses guard the next writer of
  // them (plan 12a Task 8). No writer today makes a race that only they decide:
  // the move writes a strictly newer updatedAt, and no flow clears the flag. So
  // this test reads the clauses of a reachable row and seeds no state (review m1).
  it("matches the six fields of the row it read: id, email, emailVerified, name, image, and updatedAt", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    const row = await userRow(auth, s.user.id);
    expect(unchanged(row)).toEqual([
      { field: "id", op: "eq", value: row.id },
      { field: "email", op: "eq", value: row.email },
      { field: "emailVerified", op: "eq", value: row.emailVerified },
      { field: "name", op: "eq", value: row.name },
      { field: "image", op: "eq", value: row.image },
      { field: "updatedAt", op: "eq", value: row.updatedAt },
    ]);
  });

  it("sees a parallel update that writes the same value, by updatedAt alone", async () => {
    const after: { previous: UserRow }[] = [];
    let rounds = 0;
    let stamped: Date | null = null;
    const auth = hooked((get) => ({
      beforeUpdate: async (e) => {
        rounds++;
        if (rounds > 1) return;
        // A parallel profile update that sets the name the row holds: only updatedAt changes.
        stamped = later(get().clock.now(), e.user.updatedAt);
        await get().storage.update("user", byId(e.user.id), {
          name: e.user.name,
          updatedAt: stamped,
        });
      },
      afterUpdate: (e) => {
        after.push(e);
      },
    }));
    const s = await verifiedSession(auth);
    expect((await updateProfile(auth.config, { session: s, image: IMAGE })).ok).toBe(true);
    expect(rounds).toBe(2);
    expect(stamped).not.toBeNull();
    expect(after[0]?.previous.updatedAt).toEqual(stamped);
  });

  it("answers conflict after 5 lost rounds, writes nothing of its own, and logs the user id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    let rounds = 0;
    const auth = hooked((get) => ({
      beforeUpdate: async (e) => {
        rounds++;
        await get().storage.update("user", byId(e.user.id), {
          name: `Other ${rounds}`,
          updatedAt: later(get().clock.now(), e.user.updatedAt),
        });
      },
      afterUpdate: after,
    }));
    const s = await verifiedSession(auth);
    expect(await updateProfile(auth.config, { session: s, image: IMAGE })).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(rounds).toBe(5);
    expect(await userRow(auth, s.user.id)).toMatchObject({ name: "Other 5", image: null });
    expect(after).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([["authtempo: profile update gave up", s.user.id]]);
  });

  it("answers unauthorized when the user row goes between the read and the write", async () => {
    const auth = hooked((get) => ({
      beforeUpdate: async (e) => {
        // An account delete: the child rows, then the user row.
        await get().storage.delete("session", [{ field: "userId", op: "eq", value: e.user.id }]);
        await get().storage.delete("identity", [{ field: "userId", op: "eq", value: e.user.id }]);
        await get().storage.delete("password", [{ field: "userId", op: "eq", value: e.user.id }]);
        await get().storage.delete("user", byId(e.user.id));
      },
    }));
    const s = await verifiedSession(auth);
    expect(await updateProfile(auth.config, { session: s, name: "Ada" })).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(await auth.storage.findOne("user", byId(s.user.id))).toBeNull();
  });
});

describe("the profile update limit (plan 12a)", () => {
  // The literals are the numbers that the README and the limits page promise.
  it("allows 30 updates per user in 15 minutes, on a key of its own per user", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    const bob = await verifiedSession(auth, "bob@example.com");
    const allow = vi.spyOn(auth.config.limiter, "allow");
    for (let i = 0; i < 30; i++)
      expect((await updateProfile(auth.config, { session: s, name: `Ada ${i}` })).ok).toBe(true);
    expect(await updateProfile(auth.config, { session: s, name: "Ada 31" })).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
    expect((await userRow(auth, s.user.id)).name).toBe("Ada 29");
    expect(allow).toHaveBeenLastCalledWith(`user-update:user:${s.user.id}`, {
      seconds: 900,
      max: 30,
    });
    // Another user has a key of its own.
    expect((await updateProfile(auth.config, { session: bob, name: "Bob" })).ok).toBe(true);
    // 1 ms before the window of the first call ends, the key still refuses.
    auth.clock.advance(15 * 60_000 - 1);
    expect(await updateProfile(auth.config, { session: s, name: "Ada 32" })).toMatchObject({
      code: "rate_limited",
    });
    auth.clock.advance(1);
    expect((await updateProfile(auth.config, { session: s, name: "Ada 33" })).ok).toBe(true);
  });

  it("counts no try of a refused patch or of an unverified user", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    for (let i = 0; i < 31; i++)
      expect(await updateProfile(auth.config, { session: s, name: "" })).toMatchObject({
        code: "invalid_body",
      });
    expect((await updateProfile(auth.config, { session: s, name: "Ada" })).ok).toBe(true);
    const { social, s: claim } = await claimant();
    const allow = vi.spyOn(social.config.limiter, "allow");
    expect(await updateProfile(social.config, { session: claim, name: "M" })).toMatchObject({
      code: "email_unverified",
    });
    expect(allow).not.toHaveBeenCalled();
  });
});

describe("POST /user/update (plan 12a)", () => {
  it("serves the route and refuses the address or any other field", async () => {
    const auth: Auth = totpAuth();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const s = await verifiedSession(auth);
    const bearer = { authorization: `Bearer ${s.token}` };
    const ok = await handle(post("/auth/user/update", { name: "Ada" }, bearer));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      user: { id: s.user.id, email: EMAIL, emailVerified: true, name: "Ada", image: null },
    });
    const before = await userRow(auth, s.user.id);
    for (const body of [
      { email: "x@example.com" },
      { name: "Ada", role: "admin" },
      { name: "Ada", emailVerified: false },
      {},
      [],
      null,
      "Ada",
      { name: 1 },
      { image: true },
      { name: "a".repeat(401) },
      { name: "" },
      { image: "http://img.example.com/a.png" },
    ]) {
      const res = await handle(post("/auth/user/update", body, bearer));
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    const broken = await handle(
      new Request(`${BASE_URL}/auth/user/update`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN, ...bearer },
        body: "{",
      }),
    );
    expect(broken.status).toBe(400);
    expect(await userRow(auth, s.user.id)).toEqual(before);
  });

  it("answers 401 with no session, and the hook and limit errors with their status", async () => {
    const auth = hooked(() => ({
      beforeUpdate: (e) => {
        if (e.patch.name === "Refused") throw hookRefusal("Pick another name.");
      },
    }));
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const s = await verifiedSession(auth);
    const bearer = { authorization: `Bearer ${s.token}` };
    const none = await handle(post("/auth/user/update", { name: "Ada" }));
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });
    const refused = await handle(post("/auth/user/update", { name: "Refused" }, bearer));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "hook_refused", message: "Pick another name." });
    for (let i = 1; i < 30; i++)
      expect((await handle(post("/auth/user/update", { name: `Ada ${i}` }, bearer))).status).toBe(
        200,
      );
    const limited = await handle(post("/auth/user/update", { name: "Ada" }, bearer));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("answers 403 email_unverified to a claimant", async () => {
    const { social, token } = await claimant();
    const handle = createRouter(social.config, coreRoutes(social.config));
    const res = await handle(
      post("/auth/user/update", { name: "Mallory" }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "email_unverified" });
  });

  it("has no fresh rule, and sends the renewed cookie when the read slides the expiry", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    // Past the fresh window and at the sliding refresh: the update still passes.
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    const cookie = { cookie: `${auth.config.cookieName}=${s.token}` };
    const res = await handle(post("/auth/user/update", { name: "Ada" }, cookie));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toContain(
      `${auth.config.cookieName}=${s.token};`,
    );
    // A refused body sends the renewed cookie too.
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    const bad = await handle(post("/auth/user/update", { role: "admin" }, cookie));
    expect(bad.status).toBe(400);
    expect(bad.headers.getSetCookie().join("\n")).toContain(
      `${auth.config.cookieName}=${s.token};`,
    );
  });
});

describe("api.user (plan 12a)", () => {
  it("serves update on the engine call", async () => {
    const base = totpAuth();
    const api = createAuth({
      baseURL: BASE_URL,
      secret: SECRET,
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      clock: base.clock,
      password: { hash: FAST, uniformSignUp: false },
      mail: { send: async () => {} },
    }).api;
    const signedIn = await verifiedSession(base);
    const s = await api.getSession(signedIn.token);
    if (!s) throw new Error("no session");
    expect(await api.user.update({ session: s, name: "Api" })).toEqual({
      ok: true,
      value: {
        user: { id: s.user.id, email: EMAIL, emailVerified: true, name: "Api", image: null },
      },
    });
    expect((await userRow(base, s.user.id)).name).toBe("Api");
  });
});
