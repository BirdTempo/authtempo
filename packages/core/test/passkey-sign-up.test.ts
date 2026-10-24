import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, ResolvedConfig } from "../src/config.js";
import type { AnonymousLinkEvent, UserCreateVia } from "../src/engine/hooks.js";
import { passkeySignUpOptions, verifyPasskeySignUp } from "../src/engine/passkeys.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { fromBase64Url } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import { createSimpleWebAuthnSeam, type WebAuthnSeam } from "../src/seams/webauthn.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { BASE_URL, get, makeAuth, post, recordCredential, settled } from "./helpers.js";
import { observed } from "./observe-helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";

/**
 * Passkey-first sign-up (plan 12i Task 8, spec 32 item 2). Each user comes
 * from a real ceremony of `SoftAuthenticator` through the routes.
 */

const RP = { rpID: "api.example.com", rpName: "Example", origins: [BASE_URL] };

function world(extra: Partial<AuthConfig> = {}) {
  const created: { user: UserRow; via: UserCreateVia }[] = [];
  const links: AnonymousLinkEvent[] = [];
  const names: { userName: string; userDisplayName: string }[] = [];
  const opened: string[] = [];
  // The names that reach the seam, at each registration.
  const seam = createSimpleWebAuthnSeam();
  const webauthn: WebAuthnSeam = {
    ...seam,
    registrationOptions(input) {
      names.push({ userName: input.userName, userDisplayName: input.userDisplayName });
      return seam.registrationOptions(input);
    },
  };
  const auth = makeAuth({
    webauthn,
    passkey: { ...RP, signUp: { isolateLimiter: "allow" } },
    anonymous: { isolateLimiter: "allow" },
    password: { hash: FAST, uniformSignUp: false },
    hooks: {
      user: { beforeCreate: (e) => void created.push({ user: e.user, via: e.via }) },
      anonymous: { afterLink: (e) => void links.push(e) },
      session: { afterCreate: (e) => void opened.push(`${e.user.id} ${e.via}`) },
    },
    ...extra,
  });
  const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
  return { ...auth, handle, created, links, names, opened };
}
type World = ReturnType<typeof world>;

let n = 0;
/** A new client IP, so no per-IP limit decides a test. Core reads `cf-connecting-ip`. */
const ip = () => ({ "cf-connecting-ip": `203.0.113.${(++n % 250) + 1}` });

interface CreationOptions {
  challenge: string;
  user: { id: string; name: string; displayName: string };
}

/** The options of a sign-up: the answer and its JSON. */
async function options(
  handle: World["handle"],
  body: unknown,
  headers: Record<string, string> = ip(),
) {
  const res = await handle(post("/auth/passkey/sign-up/options", body, headers));
  return { res, json: (await res.json()) as CreationOptions & { error?: string } };
}

/** The response of a new authenticator to the options. */
async function ceremony(o: CreationOptions, soft?: SoftAuthenticator) {
  const auth = soft ?? (await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE_URL }));
  return { soft: auth, response: await auth.register(o.challenge, fromBase64Url(o.user.id)) };
}

const verify = (
  handle: World["handle"],
  response: unknown,
  headers: Record<string, string> = ip(),
) => handle(post("/auth/passkey/sign-up/verify", { response }, headers));

/** The session token of an answer that set the session cookie, or null. */
function setToken(config: ResolvedConfig, res: Response): string | null {
  const name = `${config.cookieName}=`;
  const line = res.headers.getSetCookie().find((s) => s.startsWith(name));
  const token = line?.slice(name.length).split(";")[0];
  return token ? recordCredential(token) : null;
}

/** One full sign-up: the options, the ceremony, the verify. */
async function signUp(w: World, name = "Ana") {
  const o = await options(w.handle, { name });
  expect(o.res.status).toBe(200);
  const { soft, response } = await ceremony(o.json);
  const res = await verify(w.handle, response);
  expect(res.status).toBe(200);
  const token = setToken(w.config, res);
  if (!token) throw new Error("no session");
  return { soft, res, token, cookie: `${w.config.cookieName}=${token}`, userId: o.json.user.id };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("passkey-first sign-up (plan 12i Task 8)", () => {
  it("signs up with a passkey and no address", async () => {
    const w = world();
    const { res } = await signUp(w);
    const body = (await res.json()) as { user: { email: string | null; name: string } };
    expect(body.user.email).toBeNull();
    expect(body.user.name).toBe("Ana");
    const users = await w.storage.findMany("user", []);
    expect(users).toHaveLength(1);
    const [user] = users;
    expect(user?.email).toBeNull();
    expect(user?.emailVerified).toBe(false);
    expect(user?.name).toBe("Ana");
    expect(user?.isAnonymous).toBe(false);
    const passkeys = await w.storage.findMany("passkey", []);
    expect(passkeys.map((p) => p.userId)).toEqual([user?.id]);
    const sessions = await w.storage.findMany("session", []);
    expect(sessions.map((s) => s.userId)).toEqual([user?.id]);
    expect(w.opened).toEqual([`${user?.id} passkey`]);
    expect(w.created.map((c) => c.via)).toEqual(["passkey"]);
    // No address, so no mail of any kind.
    expect(w.mail).toEqual([]);
  });

  it("mints the user id at the options and uses it as the user handle", async () => {
    const w = world();
    const o = await options(w.handle, { name: "Ana" });
    expect(o.json.user.name).toBe("Ana");
    expect(o.json.user.displayName).toBe("Ana");
    const { response } = await ceremony(o.json);
    expect((await verify(w.handle, response)).status).toBe(200);
    const [user] = await w.storage.findMany("user", []);
    expect(new TextDecoder().decode(fromBase64Url(o.json.user.id))).toBe(user?.id);
    // The options write no user: only the verify does.
    const other = await options(w.handle, { name: "Bo" });
    expect(other.json.user.id).not.toBe(o.json.user.id);
    expect(await w.storage.findMany("user", [])).toHaveLength(1);
  });

  it("refuses a name that is empty, over 80 characters, or holds a control character", async () => {
    const w = world();
    for (const name of ["", "   ", "a".repeat(81), "An\u0000a", "An‮a", 7]) {
      const o = await options(w.handle, { name });
      expect(o.res.status, JSON.stringify(name)).toBe(400);
      expect(o.json.error).toBe("invalid_body");
    }
    expect((await options(w.handle, {})).json.error).toBe("invalid_body");
    expect((await options(w.handle, { name: "a".repeat(80) })).res.status).toBe(200);
    expect(await w.storage.findMany("user", [])).toEqual([]);
  });

  it("answers passkey_failed for a credential id that exists", async () => {
    const w = world();
    const first = await signUp(w);
    const o = await options(w.handle, { name: "Bo" });
    // The same authenticator registers its one credential again.
    const { response } = await ceremony(o.json, first.soft);
    const res = await verify(w.handle, response);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passkey_failed" });
    expect(setToken(w.config, res)).toBeNull();
    // The passkey row comes first, so the refused sign-up wrote no user.
    expect((await w.storage.findMany("user", [])).map((u) => u.id)).toEqual([
      new TextDecoder().decode(fromBase64Url(first.userId)),
    ]);
    expect(await w.storage.findMany("passkey", [])).toHaveLength(1);
  });

  it("consumes the challenge once", async () => {
    const w = world();
    const o = await options(w.handle, { name: "Ana" });
    const { response } = await ceremony(o.json);
    expect((await verify(w.handle, response)).status).toBe(200);
    const again = await verify(w.handle, response);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_token" });
    expect(await w.storage.findMany("user", [])).toHaveLength(1);
  });

  it("keeps the sign-up challenge apart from the other ceremonies", async () => {
    const w = world();
    // A sign-up challenge at the sign-in verify.
    const o = await options(w.handle, { name: "Ana" });
    const { soft } = await signUp(w, "Bo");
    const signIn = await w.handle(
      post(
        "/auth/passkey/authenticate/verify",
        { response: await soft.authenticate(o.json.challenge) },
        ip(),
      ),
    );
    expect(await signIn.json()).toEqual({ error: "invalid_token" });
    // A sign-in challenge at the sign-up verify.
    const asked = await w.handle(post("/auth/passkey/authenticate/options", {}, ip()));
    const { challenge } = (await asked.json()) as { challenge: string };
    const fresh = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE_URL });
    const res = await verify(w.handle, await fresh.register(challenge));
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expect(await w.storage.findMany("user", [])).toHaveLength(1);
  });

  it("lets a passkey-first user add a second passkey with a fresh session", async () => {
    const w = world();
    const { cookie } = await signUp(w);
    const reg = await w.handle(post("/auth/passkey/register/options", {}, { ...ip(), cookie }));
    expect(reg.status).toBe(200);
    const o = (await reg.json()) as CreationOptions;
    const second = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE_URL });
    const added = await w.handle(
      post(
        "/auth/passkey/register/verify",
        { response: await second.register(o.challenge, fromBase64Url(o.user.id)) },
        { ...ip(), cookie },
      ),
    );
    expect(added.status).toBe(200);
    expect(await w.storage.findMany("passkey", [])).toHaveLength(2);
    // The user name rule: the name of the person, and never another value.
    expect(w.names.at(-1)).toEqual({ userName: "Ana", userDisplayName: "Ana" });
    // The second passkey signs in.
    const signIn = await w.handle(post("/auth/passkey/authenticate/options", {}, ip()));
    const { challenge } = (await signIn.json()) as { challenge: string };
    const res = await w.handle(
      post(
        "/auth/passkey/authenticate/verify",
        { response: await second.authenticate(challenge) },
        ip(),
      ),
    );
    expect(res.status).toBe(200);
  });

  it("never sends null as the user name", async () => {
    // A user with no address, no username, no phone, and no name: the hook clears the name.
    const w = world({
      appName: "Acme",
      hooks: { user: { beforeCreate: () => ({ name: null }) } },
    });
    const { cookie } = await signUp(w);
    const [user] = await w.storage.findMany("user", []);
    expect(user).toMatchObject({ email: null, username: null, phone: null, name: null });
    const reg = await w.handle(post("/auth/passkey/register/options", {}, { ...ip(), cookie }));
    expect(reg.status).toBe(200);
    const o = (await reg.json()) as CreationOptions;
    expect(o.user.name).toBe("Acme");
    expect(o.user.displayName).toBe("Acme");
    expect(w.names.at(-1)).toEqual({ userName: "Acme", userDisplayName: "Acme" });
  });

  it("answers sign_up_closed under signUp invited or false", async () => {
    for (const signUp of ["invited", false] as const) {
      const w = world({ signUp, organizations: {} });
      const o = await options(w.handle, { name: "Ana" });
      expect(o.res.status).toBe(403);
      expect(o.json.error).toBe("sign_up_closed");
      // A config that closed the sign-up after the options: the verify refuses too.
      const open = world();
      const asked = await options(open.handle, { name: "Ana" });
      const closed: ResolvedConfig = { ...open.config, signUp };
      const handle = settled(createRouter(closed, coreRoutes(closed)));
      const res = await verify(handle, (await ceremony(asked.json)).response);
      expect(res.status, String(signUp)).toBe(403);
      expect(await res.json()).toEqual({ error: "sign_up_closed" });
      expect(await open.storage.findMany("user", [])).toEqual([]);
      expect(await open.storage.findMany("passkey", [])).toEqual([]);
    }
  });

  it("replaces an anonymous user", async () => {
    const w = world();
    const anon = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
    const anonToken = setToken(w.config, anon);
    const jar = `${w.config.cookieName}=${anonToken}`;
    const [anonUser] = await w.storage.findMany("user", []);
    const o = await options(w.handle, { name: "Ana" }, { ...ip(), cookie: jar });
    const { response } = await ceremony(o.json);
    const res = await verify(w.handle, response, { ...ip(), cookie: jar });
    expect(res.status).toBe(200);
    expect(setToken(w.config, res)).not.toBe(anonToken);
    expect(w.links.map((e) => [e.anonymousUser.id, e.proof, e.via])).toEqual([
      [anonUser?.id, "verified", "passkey"],
    ]);
    const users = await w.storage.findMany("user", []);
    expect(users.map((u) => [u.isAnonymous, u.name])).toEqual([[false, "Ana"]]);
    const old = await w.handle(get("/auth/session", { cookie: jar }));
    expect(old.status).toBe(401);
  });

  it("replaces the anonymous user of the options when the verify has no cookie (ruling 38 M2)", async () => {
    const w = world();
    const anon = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
    const anonToken = setToken(w.config, anon);
    const jar = `${w.config.cookieName}=${anonToken}`;
    const [anonUser] = await w.storage.findMany("user", []);
    // The options come from the anonymous browser. The verify carries no cookie.
    const o = await options(w.handle, { name: "Ana" }, { ...ip(), cookie: jar });
    const res = await verify(w.handle, (await ceremony(o.json)).response);
    expect(res.status).toBe(200);
    // The challenge row recorded the anonymous user, so the verify links it.
    expect(w.links.map((e) => [e.anonymousUser.id, e.proof, e.via])).toEqual([
      [anonUser?.id, "verified", "passkey"],
    ]);
    const users = await w.storage.findMany("user", []);
    expect(users.map((u) => [u.isAnonymous, u.name])).toEqual([[false, "Ana"]]);
    expect((await w.handle(get("/auth/session", { cookie: jar }))).status).toBe(401);
  });

  it("links nothing to a signed-in user that is not anonymous", async () => {
    const w = world();
    await signUpAndVerify(w, "cy@example.com", "correct horse battery");
    const signIn = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "cy@example.com", password: "correct horse battery" },
        ip(),
      ),
    );
    const cookie = `${w.config.cookieName}=${setToken(w.config, signIn)}`;
    const o = await options(w.handle, { name: "Ana" }, { ...ip(), cookie });
    const res = await verify(w.handle, (await ceremony(o.json)).response, { ...ip(), cookie });
    expect(res.status).toBe(200);
    expect(w.links).toEqual([]);
    const users = await w.storage.findMany("user", []);
    expect(users.map((u) => u.email).sort()).toEqual(["cy@example.com", null]);
    // The password user keeps its session and gains no passkey.
    expect((await w.handle(get("/auth/session", { cookie }))).status).toBe(200);
    const cy = users.find((u) => u.email === "cy@example.com");
    expect(
      await w.storage.findMany("passkey", [{ field: "userId", op: "eq", value: cy?.id ?? "" }]),
    ).toEqual([]);
  });

  it("keeps the sign-up when the clean-up after afterLink fails", async () => {
    // The join of plan 12i Tasks 8 and 10: the rules of ruling 36 hold at this sign-in too.
    const events: { name: string; rowId?: unknown; errorName?: unknown }[] = [];
    let down = false;
    const w = world({
      // The next transaction after afterLink is the end of the anonymous session.
      hooks: {
        anonymous: {
          afterLink: () => {
            down = true;
          },
        },
      },
      observe: { sink: { write: (b) => void events.push(...b) } },
    });
    const anon = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
    const jar = `${w.config.cookieName}=${setToken(w.config, anon)}`;
    const [anonUser] = await w.storage.findMany("user", []);
    const transaction = w.storage.transaction.bind(w.storage);
    // A store error after the commit, such as query 51 on D1 Free (ruling 36 L2).
    w.storage.transaction = ((work) => {
      if (!down) return transaction(work);
      down = false;
      return Promise.reject(new Error("Too many API requests by single worker invocation."));
    }) as typeof w.storage.transaction;
    const o = await options(w.handle, { name: "Ana" }, { ...ip(), cookie: jar });
    const res = await verify(w.handle, (await ceremony(o.json)).response, { ...ip(), cookie: jar });
    expect(res.status).toBe(200);
    expect(setToken(w.config, res)).not.toBeNull();
    await w.config.observe.flush();
    const lines = events.filter((e) => e.name === "anonymous.cleanup_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rowId: anonUser?.id, errorName: "Error" });
    // The anonymous user stays for the sweep.
    const users = await w.storage.findMany("user", []);
    expect(users.map((u) => [u.isAnonymous, u.name]).sort()).toEqual([
      [false, "Ana"],
      [true, null],
    ]);
  });

  it("links nothing through options recorded before anonymous was turned off", async () => {
    const w = world();
    const anon = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
    const jar = `${w.config.cookieName}=${setToken(w.config, anon)}`;
    const [anonUser] = await w.storage.findMany("user", []);
    // The options record the anonymous user. Then the deployment turns anonymous off.
    const o = await options(w.handle, { name: "Ana" }, { ...ip(), cookie: jar });
    const ended: string[] = [];
    const off = world({
      anonymous: false,
      storage: w.storage,
      clock: w.config.clock,
      hooks: { session: { afterEnd: (e) => void ended.push(e.session.userId) } },
    });
    const res = await verify(off.handle, (await ceremony(o.json)).response, {
      ...ip(),
      cookie: jar,
    });
    expect(res.status).toBe(200);
    expect(setToken(off.config, res)).not.toBeNull();
    expect(ended).toEqual([]);
    const still = await w.storage.findOne("user", [
      { field: "id", op: "eq", value: anonUser?.id ?? "" },
    ]);
    expect(still?.isAnonymous).toBe(true);
    const [row] = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: anonUser?.id ?? "" },
    ]);
    // No claim: the anonymous session keeps its freshAt.
    expect(row?.freshAt).not.toBeNull();
  });

  it("takes no address code step under password.verifyBy code (Task 20 join)", async () => {
    // The sign-up code of plan 12i Task 20 proves an address. This sign-up has none.
    const w = world({ password: { hash: FAST, uniformSignUp: true, verifyBy: "code" } });
    const { res } = await signUp(w);
    const body = (await res.json()) as { user: { id: string; email: string | null } };
    expect(body.user.email).toBeNull();
    const sessions = await w.storage.findMany("session", []);
    expect(sessions.map((s) => s.userId)).toEqual([body.user.id]);
    expect(w.created.map((c) => c.via)).toEqual(["passkey"]);
    // No code mail and no code row: the code path keys on an address.
    expect(w.mail).toEqual([]);
    const rows = await w.storage.findMany("verification", []);
    expect(rows.map((r) => [r.purpose, r.identifier])).toEqual([["passkey-challenge", "sign-up"]]);
  });

  it("limits the options by IP", async () => {
    const w = world();
    const one = ip();
    for (let i = 0; i < 10; i++)
      expect((await options(w.handle, { name: "Ana" }, one)).res.status).toBe(200);
    const over = await options(w.handle, { name: "Ana" }, one);
    expect(over.res.status).toBe(429);
    expect(over.json.error).toBe("rate_limited");
    expect((await options(w.handle, { name: "Ana" })).res.status).toBe(200);
  });

  it("checks the captcha when the app names the flow", async () => {
    const tokens: string[] = [];
    const w = world({
      captcha: {
        port: {
          verify: async (input) => {
            tokens.push(`${input.flow} ${input.token}`);
            return input.token === "good" ? "pass" : "fail";
          },
        },
        flows: ["passkey-sign-up"],
      },
    });
    expect((await options(w.handle, { name: "Ana" })).json.error).toBe("captcha_required");
    const bad = await options(w.handle, { name: "Ana" }, { ...ip(), "x-captcha-response": "bad" });
    expect(bad.json.error).toBe("captcha_failed");
    const good = await options(
      w.handle,
      { name: "Ana" },
      { ...ip(), "x-captcha-response": "good" },
    );
    expect(good.res.status).toBe(200);
    expect(tokens).toEqual(["passkey-sign-up bad", "passkey-sign-up good"]);
  });

  it("refuses a credential id over 1023 bytes and writes nothing (ruling 38 L1)", async () => {
    const w = world();
    const o = await options(w.handle, { name: "Ana" });
    // WebAuthn Level 3 bounds a credential id to 1023 bytes (ruling 7 of plan 12g).
    const long = await SoftAuthenticator.create({
      rpID: RP.rpID,
      origin: BASE_URL,
      credentialIdBytes: 1024,
    });
    const signed = (await ceremony(o.json, long)).response;
    // The id fields are short; the attested data holds the long id.
    const short = "AAAA";
    const res = await verify(w.handle, { ...signed, id: short, rawId: short });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passkey_failed" });
    expect(setToken(w.config, res)).toBeNull();
    expect(await w.storage.findMany("user", [])).toEqual([]);
    expect(await w.storage.findMany("passkey", [])).toEqual([]);
    // An id of 1023 bytes passes.
    const edge = await options(w.handle, { name: "Bo" });
    const fits = await SoftAuthenticator.create({
      rpID: RP.rpID,
      origin: BASE_URL,
      credentialIdBytes: 1023,
    });
    const kept = (await ceremony(edge.json, fits)).response;
    expect((await verify(w.handle, { ...kept, id: short, rawId: short })).status).toBe(200);
  });

  it("writes the passkey row before the user row (ruling 38 L2)", async () => {
    const w = world();
    const order: string[] = [];
    const real = w.storage.transaction.bind(w.storage);
    vi.spyOn(w.storage, "transaction").mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      real((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "create")
                return (model: string, data: unknown) => {
                  order.push(model);
                  return (target.create as (m: string, d: unknown) => unknown)(model, data);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      )) as never);
    await signUp(w);
    // A credential id that exists fails at the first write, so the
    // transaction undoes nothing. The other order leaves a user with no way in.
    expect(order.filter((m) => m === "passkey" || m === "user")).toEqual(["passkey", "user"]);
  });

  it("caps the sign-up options of the deployment per day (ruling 38 M3)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const o = observed({
      passkey: { ...RP, signUp: { isolateLimiter: "allow", dailyCap: 2 } },
    });
    const ask = () => o.auth.handle(post("/auth/passkey/sign-up/options", { name: "Ana" }, ip()));
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    // A new IP: the per-IP limit allows it, and the cap of the deployment refuses it.
    const third = await ask();
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "rate_limited" });
    const hits = (await o.events()).filter((e) => e.name === "limit.hit");
    expect(hits.map((e) => e.family)).toEqual(["passkey-sign-up:all-day"]);
    // The window is 24 hours.
    o.clock.advance(day - 1000);
    expect((await ask()).status).toBe(429);
    o.clock.advance(1000);
    expect((await ask()).status).toBe(200);
  });

  it("counts no failed captcha against the daily cap (ruling 38 M3)", async () => {
    const w = world({
      passkey: { ...RP, signUp: { isolateLimiter: "allow", dailyCap: 1 } },
      captcha: {
        port: { verify: async ({ token }) => (token === "good" ? "pass" : "fail") },
        flows: ["passkey-sign-up"],
      },
    });
    const ask = (token: string) =>
      options(w.handle, { name: "Ana" }, { ...ip(), "x-captcha-response": token });
    for (let i = 0; i < 3; i++) expect((await ask("bad")).json.error).toBe("captcha_failed");
    // The cap of 1 is still free: the three failures counted nothing.
    expect((await ask("good")).res.status).toBe(200);
    const second = await ask("good");
    expect(second.res.status).toBe(429);
    expect(second.json.error).toBe("rate_limited");
  });

  it("serves no sign-up route while passkey.signUp is off", async () => {
    const w = world({ passkey: RP });
    expect((await options(w.handle, { name: "Ana" })).res.status).toBe(404);
    expect((await verify(w.handle, { id: "x", response: { clientDataJSON: "x" } })).status).toBe(
      404,
    );
    // The engine refuses too, for a caller of the functions in process.
    expect(await passkeySignUpOptions(w.config, { name: "Ana", ip: null })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await verifyPasskeySignUp(w.config, { response: {}, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});
