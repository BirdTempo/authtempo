import { describe, expect, it } from "vitest";
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
    passkey: { ...RP, signUp: true },
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
    // The transaction undid the user of the refused sign-up.
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
