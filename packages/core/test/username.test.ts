import { describe, expect, it } from "vitest";
import { type AuthConfig, ConfigError, DEFAULT_RESERVED_SLUGS } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import type { UserHooks } from "../src/engine/hooks.js";
import { later } from "../src/engine/second-factor.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { BASE_URL, get, post, recordAddress } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type Auth, EMAIL, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

const DAY = 86_400_000;
const OTHER = "bob@example.com";
const NOTICE = "Security notice for your api.example.com account";

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
    // The uniform answer of plan 12b is on.
    const auth = totpAuth({ username: {}, password: { hash: FAST } });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const me = await verifiedSession(auth);
    const bearer = { authorization: `Bearer ${me.token}` };
    expect((await call(handle, setName(bearer, "ada"))).status).toBe(200);
    const mails = auth.mail.length;
    const taken = { email: EMAIL, password: PASSWORD };
    expect(
      await call(handle, post("/auth/password/sign-up", { ...taken, username: "ada" })),
    ).toEqual({ status: 409, body: { error: "username_taken" } });
    // A taken name with a new address answers the same: the answer tells nothing of the address.
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
    // A free name with a taken address: the uniform answer, and the name stays free.
    expect(
      await call(handle, post("/auth/password/sign-up", { ...taken, username: "other" })),
    ).toEqual({ status: 200, body: { sent: true } });
    expect((await rowOf(auth, EMAIL)).username).toBe("ada");
    expect(await call(handle, available("other"))).toEqual({
      status: 200,
      body: { available: true },
    });
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
    expect(await call(w.handle, setName(w.bearer, "lost"))).toEqual({
      status: 409,
      body: { error: "conflict" },
    });
    expect(other).toBe(5);
    const row = await rowOf(w.auth, EMAIL);
    expect({ username: row.username, name: row.name }).toEqual({
      username: "ada",
      name: "Other 5",
    });
    expect(w.auth.mail.length).toBe(mails);
  });
});
