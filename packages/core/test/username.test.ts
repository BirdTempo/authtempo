import { describe, expect, it, vi } from "vitest";
import { type AuthConfig, ConfigError, DEFAULT_RESERVED_SLUGS } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import type { UserHooks } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { later } from "../src/engine/second-factor.js";
import { resolveSocialUser } from "../src/engine/social.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import {
  BASE_URL,
  get,
  noVerifyHooks,
  post,
  recordAddress,
  recordCredential,
  tokenFromMail,
} from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type Auth, EMAIL, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

const DAY = 86_400_000;
const OTHER = "bob@example.com";
const NOTICE = "Security notice for your api.example.com account";
const CLAIMANT = recordCredential("claimant horse battery");

/** The engine with the username on, the router, and a fresh session of a verified user. */
async function world(extra: Partial<AuthConfig> = {}) {
  const auth = totpAuth({ username: {}, ...extra });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const me = await verifiedSession(auth);
  const bearer = { authorization: `Bearer ${me.token}` };
  return { auth, handle, me, bearer };
}

async function call(handle: (r: Request) => Promise<Response>, request: Request) {
  const res = await handle(request);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const setName = (bearer: Record<string, string>, username: string) =>
  post("/auth/user/username", { username }, bearer);

const available = (username: string, ip = "198.51.100.7") =>
  get(`/auth/username/available?username=${encodeURIComponent(username)}`, {
    "cf-connecting-ip": recordAddress(ip),
  });

async function rowOf(auth: Auth, email: string) {
  const row = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!row) throw new Error(`no user ${email}`);
  return row;
}

describe("the username (plan 12i Task 2)", () => {
  it("stores the NFKC lower-case form and keeps the typed case", async () => {
    const { auth, handle, bearer } = await world();
    // U+FF21 is the full-width A: NFKC folds it to A.
    expect(await call(handle, setName(bearer, "Ａlice.B"))).toEqual({
      status: 200,
      body: { username: "alice.b", displayUsername: "Alice.B" },
    });
    const row = await rowOf(auth, EMAIL);
    expect({ username: row.username, displayUsername: row.displayUsername }).toEqual({
      username: "alice.b",
      displayUsername: "Alice.B",
    });
  });

  it("refuses a name with @, +, a space, or a control character", async () => {
    const { auth, handle, bearer } = await world();
    for (const name of ["ada@home", "ada+1", "ada lovelace", "ada\u0007x", "ada-l", "émile"])
      expect(await call(handle, setName(bearer, name)), JSON.stringify(name)).toEqual({
        status: 400,
        body: { error: "username_invalid" },
      });
    expect((await rowOf(auth, EMAIL)).username).toBeNull();
  });

  it("refuses a reserved name on the stored form", async () => {
    const { handle } = await world({ organizations: { reservedSlugs: ["acme"] } });
    const names = ["Admin", "ROOT", "support", "Security", "acme", ...DEFAULT_RESERVED_SLUGS];
    for (const [i, name] of names.entries())
      expect(await call(handle, available(name, `198.51.100.${i + 10}`)), name).toEqual({
        status: 400,
        body: { error: "username_invalid" },
      });
    // The app's own list joins the defaults.
    const own = await world({ username: { reserved: ["staff"] } });
    expect(await call(own.handle, setName(own.bearer, "Staff"))).toEqual({
      status: 400,
      body: { error: "username_invalid" },
    });
    expect((await call(own.handle, setName(own.bearer, "ada"))).status).toBe(200);
  });

  it("applies the length bounds", async () => {
    const { handle, bearer } = await world({ username: { minLength: 4, maxLength: 6 } });
    expect(await call(handle, setName(bearer, "abc"))).toEqual({
      status: 400,
      body: { error: "username_invalid" },
    });
    expect(await call(handle, setName(bearer, "abcdefg"))).toEqual({
      status: 400,
      body: { error: "username_invalid" },
    });
    expect((await call(handle, setName(bearer, "abcd"))).status).toBe(200);
    const base: AuthConfig = {
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
    };
    expect(() => createAuth({ ...base, username: { maxLength: 31 } })).toThrow(
      new ConfigError("username.maxLength must be an integer from 3 to 30"),
    );
    expect(() => createAuth({ ...base, username: { minLength: 2 } })).toThrow(
      new ConfigError("username.minLength must be an integer from 3 to 30"),
    );
    expect(() => createAuth({ ...base, username: { minLength: 8, maxLength: 5 } })).toThrow(
      new ConfigError("username.maxLength must be an integer from 8 to 30"),
    );
    expect(() => createAuth({ ...base, username: { reserved: ["Staff"] } })).toThrow(
      new ConfigError("username.reserved entry is not a username in the stored form: Staff"),
    );
    expect(() => createAuth({ ...base, username: { hold: 1 } as never })).toThrow(
      new ConfigError("username.hold is not an option; core has minLength, maxLength, reserved"),
    );
  });

  it("answers username_taken for a taken name on sign-up and on set", async () => {
    const { auth, handle, bearer } = await world();
    expect((await call(handle, setName(bearer, "Ada"))).status).toBe(200);
    const bob = await verifiedSession(auth, OTHER);
    const bobBearer = { authorization: `Bearer ${bob.token}` };
    // Another case of the same stored form is the same name.
    expect(await call(handle, setName(bobBearer, "ADA"))).toEqual({
      status: 409,
      body: { error: "username_taken" },
    });
    const up = post("/auth/password/sign-up", {
      email: "carol@example.com",
      password: PASSWORD,
      username: "ada",
    });
    expect(await call(handle, up)).toEqual({ status: 409, body: { error: "username_taken" } });
    expect(
      await auth.storage.findOne("user", [
        { field: "email", op: "eq", value: "carol@example.com" },
      ]),
    ).toBeNull();
    // A free name: the sign-up stores both forms.
    const free = post("/auth/password/sign-up", {
      email: "dan@example.com",
      password: PASSWORD,
      username: "Dan_1",
    });
    expect((await call(handle, free)).status).toBe(200);
    const dan = await rowOf(auth, "dan@example.com");
    expect({ username: dan.username, displayUsername: dan.displayUsername }).toEqual({
      username: "dan_1",
      displayUsername: "Dan_1",
    });
  });

  it("checks the username before the address on sign-up", async () => {
    // The detailed answer (uniformSignUp false), the setting of the compat shim.
    const { auth, handle, bearer } = await world();
    expect((await call(handle, setName(bearer, "ada"))).status).toBe(200);
    const mails = auth.mail.length;
    const taken = { email: EMAIL, password: PASSWORD };
    // A taken name answers username_taken for a taken and a new address.
    expect(
      await call(handle, post("/auth/password/sign-up", { ...taken, username: "ada" })),
    ).toEqual({ status: 409, body: { error: "username_taken" } });
    expect(
      await call(
        handle,
        post("/auth/password/sign-up", {
          email: "new@example.com",
          password: PASSWORD,
          username: "ada",
        }),
      ),
    ).toEqual({ status: 409, body: { error: "username_taken" } });
    expect(auth.mail.length).toBe(mails);
    // A free name with a taken address: email_taken, and the name stays free.
    expect(
      await call(handle, post("/auth/password/sign-up", { ...taken, username: "other" })),
    ).toEqual({ status: 409, body: { error: "email_taken" } });
    expect((await rowOf(auth, EMAIL)).username).toBe("ada");
    expect(await call(handle, available("other"))).toEqual({
      status: 200,
      body: { available: true },
    });
  });

  it("refuses a username at a uniform sign-up the same for a known and a new address", async () => {
    // The uniform answer of plan 12b (the default). A name held only by a
    // new address would tell which address has an account (ruling 16 M1).
    const auth = totpAuth({ username: {}, password: { hash: FAST } });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    await verifiedSession(auth);
    recordAddress("new@example.com");
    const mails = auth.mail.length;
    const up = (email: string, username: string) =>
      call(handle, post("/auth/password/sign-up", { email, password: PASSWORD, username }));
    expect(await up(EMAIL, "probe_k")).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await up("new@example.com", "probe_f")).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    expect(auth.mail.length).toBe(mails);
    for (const name of ["probe_k", "probe_f"])
      expect(await call(handle, available(name)), name).toEqual({
        status: 200,
        body: { available: true },
      });
    expect(
      await auth.storage.findOne("user", [{ field: "email", op: "eq", value: "new@example.com" }]),
    ).toBeNull();
    // With no name, the uniform sign-up answers as before.
    expect(
      await call(
        handle,
        post("/auth/password/sign-up", { email: "new@example.com", password: PASSWORD }),
      ),
    ).toEqual({ status: 200, body: { sent: true } });
  });

  it("keeps the name of a sign-up at its own confirm, and clears it at every other claim", async () => {
    const auth = totpAuth({ username: {} });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const signUp = async (email: string, username: string) => {
      recordAddress(email);
      const r = await passwordSignUp(auth.config, {
        email,
        password: CLAIMANT,
        username,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
    };
    // The sign-up's own verify link proves the address that named the name.
    await signUp("own@example.com", "Own_Name");
    const confirm = auth.mail.findLast((m) => m.to === "own@example.com");
    const v = await verifyPasswordEmail(auth.config, {
      token: tokenFromMail(confirm?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(v.ok).toBe(true);
    const own = await rowOf(auth, "own@example.com");
    expect([own.emailVerified, own.username, own.displayUsername]).toEqual([
      true,
      "own_name",
      "Own_Name",
    ]);
    // A claimant names the owner's address. The owner's magic link claims it.
    await signUp("victim@example.com", "Victim_Official");
    await requestMagicLink(auth.config, { email: "victim@example.com", ip: null });
    const link = auth.mail.findLast((m) => m.to === "victim@example.com");
    const claimed = await verifyMagicLink(auth.config, {
      token: tokenFromMail(link?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!claimed.ok || !("user" in claimed.value)) throw new Error("no claim");
    expect(claimed.value.user.username).toBeNull();
    const victim = await rowOf(auth, "victim@example.com");
    expect([victim.emailVerified, victim.username, victim.displayUsername]).toEqual([
      true,
      null,
      null,
    ]);
    expect(await call(handle, available("victim_official"))).toEqual({
      status: 200,
      body: { available: true },
    });
    // The reset of the owner claims too.
    await signUp("reset@example.com", "Reset_Name");
    expect(
      (await requestPasswordReset(auth.config, { email: "reset@example.com", ip: null })).ok,
    ).toBe(true);
    const reset = auth.mail.findLast((m) => m.to === "reset@example.com");
    const done = await resetPassword(auth.config, {
      token: tokenFromMail(reset?.text ?? ""),
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!done.ok || !("user" in done.value)) throw new Error("no reset session");
    // The answer of the claim holds no name, as the row does (ruling 19 L-1).
    expect([done.value.user.username, done.value.user.displayUsername]).toEqual([null, null]);
    expect((await rowOf(auth, "reset@example.com")).username).toBeNull();
    // A provider that proves the owner's address claims too (social.ts, the
    // claim of an address with no identity of this provider).
    await signUp("google@example.com", "Google_Name");
    const social = await resolveSocialUser(
      auth.storage,
      "google",
      {
        subject: "g-owner",
        email: "google@example.com",
        emailVerified: true,
        name: null,
        image: null,
      },
      auth.clock.now(),
      noVerifyHooks("social"),
    );
    if (!social.ok) throw new Error(social.code);
    expect([social.value.username, social.value.displayUsername]).toEqual([null, null]);
    expect((await rowOf(auth, "google@example.com")).username).toBeNull();
  });

  it("sets the username with a fresh session and mails a notice", async () => {
    const { auth, handle, bearer } = await world();
    auth.clock.advance(DAY);
    expect(await call(handle, setName(bearer, "ada"))).toEqual({
      status: 403,
      body: { error: "session_not_fresh" },
    });
    expect((await rowOf(auth, EMAIL)).username).toBeNull();
    const fresh = await verifiedSession(auth);
    const before = auth.mail.length;
    expect(
      (await call(handle, setName({ authorization: `Bearer ${fresh.token}` }, "ada"))).status,
    ).toBe(200);
    const sent = auth.mail.slice(before);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[EMAIL, NOTICE]]);
    expect(sent[0]?.text).toContain("The username of your account was changed.");
    // The same name in the same case writes nothing and mails nothing.
    expect(
      (await call(handle, setName({ authorization: `Bearer ${fresh.token}` }, "ada"))).status,
    ).toBe(200);
    expect(auth.mail.length).toBe(before + 1);
  });

  it("answers availability under its limit", async () => {
    const { handle } = await world();
    for (let i = 0; i < 30; i++)
      expect((await call(handle, available(`name${i}`))).body).toEqual({ available: true });
    expect(await call(handle, available("name30"))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // Another IP has its own count.
    expect((await call(handle, available("name30", "198.51.100.8"))).status).toBe(200);
  });

  it("refuses the sixth set in one hour", async () => {
    const { auth, handle, bearer } = await world();
    for (const name of ["ada1", "ada2", "ada3", "ada4", "ada5"])
      expect((await call(handle, setName(bearer, name))).status, name).toBe(200);
    expect(await call(handle, setName(bearer, "ada6"))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect((await rowOf(auth, EMAIL)).username).toBe("ada5");
  });

  it("counts a bad name against the availability limit", async () => {
    const { handle } = await world();
    for (let i = 0; i < 30; i++)
      expect((await call(handle, available(`bad@${i}`))).status).toBe(400);
    expect(await call(handle, available("good"))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
  });

  it("frees a name at once", async () => {
    const { auth, handle, bearer } = await world();
    expect((await call(handle, setName(bearer, "ada"))).status).toBe(200);
    expect(await call(handle, available("ADA"))).toEqual({
      status: 200,
      body: { available: false },
    });
    expect((await call(handle, setName(bearer, "ada.l"))).status).toBe(200);
    expect(await call(handle, available("ada"))).toEqual({
      status: 200,
      body: { available: true },
    });
    const bob = await verifiedSession(auth, OTHER);
    expect(await call(handle, setName({ authorization: `Bearer ${bob.token}` }, "Ada"))).toEqual({
      status: 200,
      body: { username: "ada", displayUsername: "Ada" },
    });
  });

  it("refuses a bad name at sign-up, and the field while the username is off", async () => {
    const { auth, handle } = await world();
    const up = (username: string) =>
      post("/auth/password/sign-up", { email: "eve@example.com", password: PASSWORD, username });
    expect(await call(handle, up("eve@home"))).toEqual({
      status: 400,
      body: { error: "username_invalid" },
    });
    expect(await call(handle, up("admin"))).toEqual({
      status: 400,
      body: { error: "username_invalid" },
    });
    const off = totpAuth();
    const offHandle = createRouter(off.config, coreRoutes(off.config));
    expect(await call(offHandle, up("eve"))).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    for (const a of [auth, off])
      expect(
        await a.storage.findOne("user", [{ field: "email", op: "eq", value: "eve@example.com" }]),
      ).toBeNull();
    // With the username off, neither route is mounted.
    expect((await offHandle(available("eve"))).status).toBe(404);
  });

  it("runs the user hooks with via username, and answers conflict after 5 lost rounds", async () => {
    const seen: { via: string; patch?: unknown }[] = [];
    let other = 0;
    const hooks: UserHooks = {
      beforeUpdate: async (e) => {
        seen.push({ via: e.via, patch: e.patch });
        // A parallel write of the row in each round: the compare-and-set loses.
        if (e.patch.username === "lost")
          await w.auth.storage.update("user", [{ field: "id", op: "eq", value: e.user.id }], {
            name: `Other ${++other}`,
            updatedAt: later(w.auth.clock.now(), e.user.updatedAt),
          });
      },
      afterUpdate: (e) => {
        seen.push({ via: e.via });
      },
    };
    const w = await world({ hooks: { user: hooks } });
    expect((await call(w.handle, setName(w.bearer, "Ada"))).status).toBe(200);
    expect(seen).toEqual([
      { via: "username", patch: { username: "ada", displayUsername: "Ada" } },
      { via: "username" },
    ]);
    const mails = w.auth.mail.length;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await call(w.handle, setName(w.bearer, "lost"))).toEqual({
      status: 409,
      body: { error: "conflict" },
    });
    expect(other).toBe(5);
    // The default line of `username.set_gave_up` (ruling 16 m3).
    expect(log.mock.calls).toEqual([["authtempo: username set gave up", w.me.user.id]]);
    log.mockRestore();
    const row = await rowOf(w.auth, EMAIL);
    expect({ username: row.username, name: row.name }).toEqual({
      username: "ada",
      name: "Other 5",
    });
    expect(w.auth.mail.length).toBe(mails);
  });
});
