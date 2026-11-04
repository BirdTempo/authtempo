import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import type { AnonymousLinkEvent, SessionEndReason, SessionVia } from "../src/engine/hooks.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from "../src/engine/passkeys.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { AuthEvent } from "../src/observe/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import {
  BASE_URL,
  get,
  makeAuth,
  post,
  recordCredential,
  sessionFor,
  settled,
  tokenFromMail,
} from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  GOOGLE,
  googleClaims,
  tokenEndpoint,
} from "./social-helpers.js";
import { codeNow, enrolled, PASSWORD } from "./totp-helpers.js";

/**
 * The anonymous upgrade, always by replace (plan 12i Task 7, spec 32 item
 * 9). Each test starts from a real anonymous sign-in in one cookie jar: a
 * jar is the cookie header of one browser.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const RP = { rpID: "api.example.com", rpName: "Example", origins: [BASE_URL] };
const PHONE = "+15550100001";

/** The hooks of a test: each call of each point, in order. */
function recorder() {
  const links: { point: "before" | "after"; event: AnonymousLinkEvent }[] = [];
  const deleted: string[] = [];
  const ended: { userId: string; reason: SessionEndReason }[] = [];
  return {
    links,
    deleted,
    ended,
    before: (e: AnonymousLinkEvent) => void links.push({ point: "before", event: e }),
    after: (e: AnonymousLinkEvent) => void links.push({ point: "after", event: e }),
    hooks(
      over: {
        beforeLink?: (e: AnonymousLinkEvent) => void;
        afterLink?: (e: AnonymousLinkEvent) => void;
      } = {},
    ): NonNullable<AuthConfig["hooks"]> {
      return {
        anonymous: {
          beforeLink: over.beforeLink ?? ((e) => this.before(e)),
          afterLink: over.afterLink ?? ((e) => this.after(e)),
        },
        user: { afterDelete: (e) => void deleted.push(e.user.id) },
        session: {
          afterEnd: (e) => void ended.push({ userId: e.session.userId, reason: e.reason }),
        },
      };
    },
  };
}

/** Every pathway on, a recording SMS port, a fake provider, and a recording event sink. */
function world(extra: Partial<AuthConfig> = {}, rec = recorder()) {
  const sms = createRecordingSms();
  const jwtTokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = tokenEndpoint("idtok-default");
  const batches: AuthEvent[] = [];
  const auth = makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    emailOtp: {},
    social: { google: GOOGLE, fetch: fetchFn },
    jwt: fakeJwt(jwtTokens),
    passkey: RP,
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    anonymous: { isolateLimiter: "allow" },
    hooks: rec.hooks(),
    observe: { sink: { write: (b) => void batches.push(...b) } },
    ...extra,
  });
  const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
  async function events(): Promise<AuthEvent[]> {
    await auth.config.observe.flush();
    return batches;
  }
  return { ...auth, sms, jwtTokens, handle, rec, events };
}
type World = ReturnType<typeof world>;

let n = 0;
/** A new client IP, so no per-IP limit decides a test. Core reads `cf-connecting-ip`. */
const ip = () => ({ "cf-connecting-ip": `198.51.100.${(++n % 250) + 1}` });

/** The session token of an answer that set the session cookie, or null. */
function setToken(w: World, res: Response): string | null {
  const name = `${w.config.cookieName}=`;
  const line = res.headers.getSetCookie().find((s) => s.startsWith(name));
  const token = line?.slice(name.length).split(";")[0];
  return token ? recordCredential(token) : null;
}

/** One anonymous sign-in through the route: the jar of a browser that holds it. */
async function anonymousJar(w: World) {
  const res = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
  expect(res.status).toBe(200);
  const token = setToken(w, res);
  if (!token) throw new Error("no anonymous session");
  const user = (await w.storage.findMany("user", [])).find((u) => u.isAnonymous && !seen.has(u.id));
  if (!user) throw new Error("no anonymous user");
  seen.add(user.id);
  return { token, cookie: `${w.config.cookieName}=${token}`, userId: user.id };
}
const seen = new Set<string>();

const userOf = (w: World, id: string): Promise<UserRow | null> =>
  w.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);
const sessionsOf = (w: World, userId: string) =>
  w.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);

/** A request from a jar: its cookie, or none. */
const jarHeaders = (cookie: string | null) => ({ ...ip(), ...(cookie ? { cookie } : {}) });

/** The magic link of `email`, asked from `from` and opened in `at`. Answers the verify. */
async function magicLink(w: World, email: string, from: string | null, at: string | null) {
  const asked = await w.handle(post("/auth/magic-link/request", { email }, jarHeaders(from)));
  expect(asked.status).toBe(200);
  const mail = w.mail.findLast((m) => m.to === email);
  const token = tokenFromMail(mail?.text ?? "");
  return w.handle(post("/auth/magic-link/verify", { token }, jarHeaders(at)));
}

/** The email code of `email`, asked and verified from `jar`. */
async function emailCode(w: World, email: string, jar: string) {
  const asked = await w.handle(post("/auth/otp/request", { email }, jarHeaders(jar)));
  expect(asked.status).toBe(200);
  const code = /\b(\d{6})\b/.exec(w.mail.findLast((m) => m.to === email)?.text ?? "")?.[1];
  if (!code) throw new Error("no code in the mail");
  return w.handle(
    post("/auth/otp/verify", { email, code: recordCredential(code) }, jarHeaders(jar)),
  );
}

/** The phone code, asked and verified from `jar`. */
async function phoneCode(w: World, jar: string) {
  const asked = await w.handle(post("/auth/phone/request", { phone: PHONE }, jarHeaders(jar)));
  expect(asked.status).toBe(200);
  const text = w.sms.sent.findLast((s) => s.to === PHONE)?.text ?? "";
  const code = /^(\d+) is your /.exec(text)?.[1];
  if (!code) throw new Error("no code in the text");
  return w.handle(
    post("/auth/phone/verify", { phone: PHONE, code: recordCredential(code) }, jarHeaders(jar)),
  );
}

/**
 * A Google sign-in: the start from `from`, the callback in `at` with the
 * binding cookie of the start. `verified` is the provider's address flag.
 */
async function google(
  w: World,
  from: string | null,
  at: string | null,
  claims: Record<string, unknown> = {},
) {
  const start = await w.handle(get("/auth/social/google/start", jarHeaders(from)));
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const nonce = location.searchParams.get("nonce") ?? "";
  const bind = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  w.jwtTokens["idtok-default"] = googleClaims(nonce, claims);
  const cookie = [bind, at].filter((c) => c !== null && c !== "").join("; ");
  return w.handle(get(`/auth/social/google/callback?state=${state}&code=c`, { ...ip(), cookie }));
}

/** A verified password user with a passkey: the soft authenticator that holds it. */
async function passkeyUser(w: World, email: string) {
  await signUpAndVerify(w, email, PASSWORD);
  const user = await w.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("no user");
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE_URL });
  const options = await passkeyRegistrationOptions(w.config, {
    session: await sessionFor(w.config, user),
  });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(w.config, {
    session: await sessionFor(w.config, user),
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!added.ok) throw new Error(added.code);
  return { soft, user };
}

/** A passkey sign-in: the options and the verify from `jar`. */
async function passkeySignIn(w: World, soft: SoftAuthenticator, jar: string) {
  const options = await w.handle(post("/auth/passkey/authenticate/options", {}, jarHeaders(jar)));
  const { challenge } = (await options.json()) as { challenge: string };
  return w.handle(
    post(
      "/auth/passkey/authenticate/verify",
      { response: await soft.authenticate(challenge) },
      jarHeaders(jar),
    ),
  );
}

/** The anonymous user is gone, its session ended with anonymous_upgrade, and the delete hook ran. */
async function replaced(w: World, anon: { userId: string; token: string }) {
  expect(await userOf(w, anon.userId)).toBeNull();
  expect(await sessionsOf(w, anon.userId)).toEqual([]);
  const ends = w.rec.ended.filter((e) => e.userId === anon.userId);
  expect(ends.map((e) => e.reason)).toEqual(["anonymous_upgrade"]);
  expect(w.rec.deleted).toEqual([anon.userId]);
  const after = await w.handle(
    get("/auth/session", { cookie: `${w.config.cookieName}=${anon.token}` }),
  );
  expect(after.status).toBe(401);
}

/** The anonymous user and its live session stay, and no hook ran. */
async function kept(w: World, anon: { userId: string; cookie: string }) {
  expect(w.rec.links).toEqual([]);
  expect((await userOf(w, anon.userId))?.isAnonymous).toBe(true);
  const still = await w.handle(get("/auth/session", { cookie: anon.cookie }));
  expect(still.status).toBe(200);
}

describe("the anonymous upgrade (plan 12i Task 7)", () => {
  it("replaces the anonymous user on a verified proof in the same browser", async () => {
    const w = world();
    const anon = await anonymousJar(w);
    const res = await magicLink(w, "ada@example.com", anon.cookie, anon.cookie);
    expect(res.status).toBe(200);
    const token = setToken(w, res);
    expect(token).not.toBeNull();
    expect(token).not.toBe(anon.token);
    const ada = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@example.com" },
    ]);
    expect(w.rec.links.map((l) => l.point)).toEqual(["before", "after"]);
    for (const { event } of w.rec.links)
      expect(event).toMatchObject({
        anonymousUser: { id: anon.userId, isAnonymous: true },
        user: { id: ada?.id },
        proof: "verified",
        via: "magic_link",
      });
    await replaced(w, anon);
    // The new session reads back as Ada.
    const me = await w.handle(get("/auth/session", { cookie: `${w.config.cookieName}=${token}` }));
    expect(await me.json()).toMatchObject({ user: { email: "ada@example.com" } });
  });

  it("links nothing when the completing request has no anonymous session", async () => {
    const w = world();
    const stranger = await anonymousJar(w);
    // The stranger asks for the owner's link; the owner opens it in a browser with no session.
    const res = await magicLink(w, "owner@example.com", stranger.cookie, null);
    expect(res.status).toBe(200);
    expect(setToken(w, res)).not.toBeNull();
    await kept(w, stranger);
  });

  it("links nothing when the completing request carries another anonymous session", async () => {
    const w = world();
    const stranger = await anonymousJar(w);
    const owner = await anonymousJar(w);
    const res = await magicLink(w, "owner@example.com", stranger.cookie, owner.cookie);
    expect(res.status).toBe(200);
    await kept(w, stranger);
    await kept(w, owner);
  });

  it("links through the state row on a social callback", async () => {
    const w = world();
    const anon = await anonymousJar(w);
    // The callback carries the binding cookie only, as Apple's cross-site form post does.
    const res = await google(w, anon.cookie, null, { email_verified: true });
    expect(res.status).toBe(302);
    expect(setToken(w, res)).not.toBeNull();
    expect(w.rec.links.map((l) => [l.point, l.event.proof, l.event.via])).toEqual([
      ["before", "verified", "social"],
      ["after", "verified", "social"],
    ]);
    await replaced(w, anon);

    // The provider's flag decides the proof: an unverified address makes an unverified user.
    const v = world();
    const other = await anonymousJar(v);
    const second = await google(v, other.cookie, other.cookie, {
      sub: "g-2",
      email: "bo@example.com",
      email_verified: false,
    });
    expect(second.status).toBe(302);
    expect(v.rec.links.map((l) => l.event.proof)).toEqual(["unverified", "unverified"]);
  });

  it("links into an existing user and names the proof", async () => {
    const w = world();
    // A password sign-up with the uniform answer off: a user whose address no proof verified.
    const up = await w.handle(
      post("/auth/password/sign-up", { email: "eve@example.com", password: PASSWORD }, ip()),
    );
    expect(up.status).toBe(200);
    const eve = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "eve@example.com" },
    ]);
    expect(eve?.emailVerified).toBe(false);
    const anon = await anonymousJar(w);
    const res = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "eve@example.com", password: PASSWORD },
        jarHeaders(anon.cookie),
      ),
    );
    expect(res.status).toBe(200);
    expect(w.rec.links.map((l) => [l.point, l.event.user.id, l.event.proof])).toEqual([
      ["before", eve?.id, "unverified"],
      ["after", eve?.id, "unverified"],
    ]);
    await replaced(w, anon);
  });

  it("links at the challenge verify of a gated sign-in", async () => {
    const w = world();
    const { secret } = await enrolled(w, "ada@example.com");
    const anon = await anonymousJar(w);
    const signIn = () =>
      w.handle(
        post(
          "/auth/password/sign-in",
          { email: "ada@example.com", password: PASSWORD },
          jarHeaders(anon.cookie),
        ),
      );
    // A challenge whose sign-in carried no anonymous session links none at its verify.
    const plain = await w.handle(
      post("/auth/password/sign-in", { email: "ada@example.com", password: PASSWORD }, ip()),
    );
    const { twoFactor } = (await plain.json()) as { twoFactor: { challenge: string } };
    const unlinked = await w.handle(
      post(
        "/auth/totp/verify",
        { challenge: twoFactor.challenge, code: await codeNow(w, secret) },
        jarHeaders(anon.cookie),
      ),
    );
    expect(unlinked.status).toBe(200);
    await kept(w, anon);
    w.clock.advance(30_000);
    // An expired challenge links nothing, and the anonymous session stays.
    const first = (await (await signIn()).json()) as { twoFactor: { challenge: string } };
    expect(w.rec.links).toEqual([]);
    w.clock.advance(5 * 60_000 + 1);
    const late = await w.handle(
      post(
        "/auth/totp/verify",
        { challenge: first.twoFactor.challenge, code: await codeNow(w, secret) },
        jarHeaders(anon.cookie),
      ),
    );
    expect(late.status).toBe(400);
    await kept(w, anon);
    // A live challenge: the sign-in calls no hook, and the verify calls both.
    w.clock.advance(30_000);
    const res = await signIn();
    const body = (await res.json()) as { twoFactor: { challenge: string } };
    expect(setToken(w, res)).toBeNull();
    expect(w.rec.links).toEqual([]);
    const verified = await w.handle(
      post(
        "/auth/totp/verify",
        { challenge: body.twoFactor.challenge, code: await codeNow(w, secret) },
        jarHeaders(anon.cookie),
      ),
    );
    expect(verified.status).toBe(200);
    expect(w.rec.links.map((l) => [l.point, l.event.via, l.event.proof])).toEqual([
      ["before", "password", "verified"],
      ["after", "password", "verified"],
    ]);
    await replaced(w, anon);
  });

  it("links a gated mailed sign-in at the verify only with the same anonymous session", async () => {
    const w = world();
    const { secret } = await enrolled(w, "ada@example.com");
    const anon = await anonymousJar(w);
    const challengeOf = async (res: Response) =>
      ((await res.json()) as { twoFactor: { challenge: string } }).twoFactor.challenge;
    // The link and its challenge in the anonymous browser; the verify in another one.
    const first = await challengeOf(
      await magicLink(w, "ada@example.com", anon.cookie, anon.cookie),
    );
    const elsewhere = await w.handle(
      post("/auth/totp/verify", { challenge: first, code: await codeNow(w, secret) }, ip()),
    );
    expect(elsewhere.status).toBe(200);
    await kept(w, anon);
    // The same flow with the verify in the anonymous browser links.
    w.clock.advance(30_000);
    const second = await challengeOf(
      await magicLink(w, "ada@example.com", anon.cookie, anon.cookie),
    );
    const here = await w.handle(
      post(
        "/auth/totp/verify",
        { challenge: second, code: await codeNow(w, secret) },
        jarHeaders(anon.cookie),
      ),
    );
    expect(here.status).toBe(200);
    expect(w.rec.links.map((l) => [l.point, l.event.via])).toEqual([
      ["before", "magic_link"],
      ["after", "magic_link"],
    ]);
    await replaced(w, anon);
  });

  it("stops the sign-in on a beforeLink refusal", async () => {
    const rec = recorder();
    const { hookRefusal } = await import("../src/engine/hooks.js");
    const w = world(
      {
        hooks: rec.hooks({
          beforeLink: () => {
            throw hookRefusal("no");
          },
        }),
      },
      rec,
    );
    const anon = await anonymousJar(w);
    const before = (await w.storage.findMany("session", [])).length;
    const res = await magicLink(w, "ada@example.com", anon.cookie, anon.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "hook_refused", message: "no" });
    expect(setToken(w, res)).toBeNull();
    expect(await w.storage.findMany("session", [])).toHaveLength(before);
    await kept(w, anon);
    // The refusal undid the claim: the session can link at a later sign-in.
    const [row] = await sessionsOf(w, anon.userId);
    expect(row?.freshAt).not.toBeNull();
  });

  it("keeps the anonymous user when afterLink throws", async () => {
    const rec = recorder();
    const w = world(
      {
        hooks: rec.hooks({
          afterLink: () => {
            throw new Error("app store down");
          },
        }),
      },
      rec,
    );
    const anon = await anonymousJar(w);
    const res = await magicLink(w, "ada@example.com", anon.cookie, anon.cookie);
    expect(res.status).toBe(200);
    expect(setToken(w, res)).not.toBeNull();
    const lines = (await w.events()).filter((e) => e.name === "hook.after_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ hook: "anonymous.afterLink", rowId: anon.userId });
    expect((await userOf(w, anon.userId))?.isAnonymous).toBe(true);
    expect(w.rec.deleted).toEqual([]);
    expect(w.rec.ended.filter((e) => e.userId === anon.userId)).toEqual([]);
    const still = await w.handle(get("/auth/session", { cookie: anon.cookie }));
    expect(still.status).toBe(200);
  });

  it("keeps a committed sign-in when the clean-up after afterLink fails", async () => {
    const rec = recorder();
    let down = false;
    const w = world(
      {
        hooks: rec.hooks({
          afterLink: (e) => {
            rec.after(e);
            // The next transaction is the end of the anonymous session.
            down = true;
          },
        }),
      },
      rec,
    );
    const transaction = w.storage.transaction.bind(w.storage);
    // A store error after the commit, such as query 51 on D1 Free. It fails one call.
    w.storage.transaction = ((work) => {
      if (!down) return transaction(work);
      down = false;
      return Promise.reject(new Error("Too many API requests by single worker invocation."));
    }) as typeof w.storage.transaction;
    const anon = await anonymousJar(w);
    const res = await magicLink(w, "ada@example.com", anon.cookie, anon.cookie);
    expect(res.status).toBe(200);
    const token = setToken(w, res);
    expect(token).not.toBeNull();
    expect(w.rec.links.map((l) => l.point)).toEqual(["before", "after"]);
    const lines = (await w.events()).filter((e) => e.name === "anonymous.cleanup_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rowId: anon.userId, errorName: "Error" });
    // The anonymous user stays for the sweep. The claim spent its session, so no sign-in links it again.
    expect((await userOf(w, anon.userId))?.isAnonymous).toBe(true);
    expect(w.rec.deleted).toEqual([]);
    const [row] = await sessionsOf(w, anon.userId);
    expect(row?.freshAt).toBeNull();
    const me = await w.handle(get("/auth/session", { cookie: `${w.config.cookieName}=${token}` }));
    expect(await me.json()).toMatchObject({ user: { email: "ada@example.com" } });
  });

  it("links nothing through a row recorded before anonymous was turned off", async () => {
    const w = world();
    const { soft } = await passkeyUser(w, "ada@example.com");
    const anon = await anonymousJar(w);
    // The passkey options record the anonymous user. Then the deployment turns anonymous off.
    const options = await w.handle(
      post("/auth/passkey/authenticate/options", {}, jarHeaders(anon.cookie)),
    );
    const { challenge } = (await options.json()) as { challenge: string };
    const rec = recorder();
    // The same hooks with no anonymous points: those need anonymous on.
    const hooks = rec.hooks();
    delete hooks.anonymous;
    const off = world({ anonymous: false, hooks, storage: w.storage, clock: w.config.clock }, rec);
    const res = await off.handle(
      post(
        "/auth/passkey/authenticate/verify",
        { response: await soft.authenticate(challenge) },
        jarHeaders(anon.cookie),
      ),
    );
    expect(res.status).toBe(200);
    expect(setToken(off, res)).not.toBeNull();
    expect((await userOf(w, anon.userId))?.isAnonymous).toBe(true);
    expect(rec.deleted).toEqual([]);
    expect(rec.ended).toEqual([]);
    const [row] = await sessionsOf(w, anon.userId);
    expect(row?.freshAt).not.toBeNull();
  });

  it("upgrades on each pathway", async () => {
    const rows: [string, (w: World, jar: string) => Promise<Response>, SessionVia][] = [
      [
        "the password sign-up confirm",
        async (w, jar) => {
          const up = await w.handle(
            post(
              "/auth/password/sign-up",
              { email: "cy@example.com", password: PASSWORD },
              jarHeaders(jar),
            ),
          );
          expect(await up.json()).toEqual({ sent: true });
          const mail = w.mail.findLast((m) => m.subject.startsWith("Confirm"));
          const token = tokenFromMail(mail?.text ?? "");
          return w.handle(post("/auth/password/verify", { token }, jarHeaders(jar)));
        },
        "password",
      ],
      [
        "the password sign-in",
        async (w, jar) => {
          await signUpAndVerify(w, "di@example.com", PASSWORD);
          return w.handle(
            post(
              "/auth/password/sign-in",
              { email: "di@example.com", password: PASSWORD },
              jarHeaders(jar),
            ),
          );
        },
        "password",
      ],
      ["the magic link", (w, jar) => magicLink(w, "ed@example.com", jar, jar), "magic_link"],
      ["the email code", (w, jar) => emailCode(w, "fy@example.com", jar), "email_otp"],
      ["social", (w, jar) => google(w, jar, jar), "social"],
      ["the phone code", (w, jar) => phoneCode(w, jar), "phone"],
      [
        "passkey sign-in",
        async (w, jar) => {
          const { soft } = await passkeyUser(w, "gu@example.com");
          return passkeySignIn(w, soft, jar);
        },
        "passkey",
      ],
    ];
    for (const [name, run, via] of rows) {
      // The password sign-up confirm opens its session with the uniform answer (plan 12b).
      const w = world(name === "the password sign-up confirm" ? { password: { hash: FAST } } : {});
      const anon = await anonymousJar(w);
      const res = await run(w, anon.cookie);
      expect([200, 302], name).toContain(res.status);
      expect(setToken(w, res), name).not.toBeNull();
      expect(
        w.rec.links.map((l) => [l.point, l.event.via, l.event.proof]),
        name,
      ).toEqual([
        ["before", via, "verified"],
        ["after", via, "verified"],
      ]);
      await replaced(w, anon);
    }
  });

  it("never carries a token across the upgrade", async () => {
    const w = world();
    const anon = await anonymousJar(w);
    const res = await phoneCode(w, anon.cookie);
    expect(res.status).toBe(200);
    const token = setToken(w, res);
    const body = (await res.json()) as { token: string; user: { id: string } };
    expect(token).not.toBe(anon.token);
    expect(body.token).toBe(token);
    expect(body.user.id).not.toBe(anon.userId);
    // The anonymous token answers 401 by cookie and by bearer.
    const byCookie = await w.handle(get("/auth/session", { cookie: anon.cookie }));
    expect(byCookie.status).toBe(401);
    const byBearer = await w.handle(
      get("/auth/session", { authorization: `Bearer ${anon.token}` }),
    );
    expect(byBearer.status).toBe(401);
  });
});

describe("the anonymous upgrade under attack (plan 12i Task 7, security focus)", () => {
  it("links nothing at an email code asked from a stranger's anonymous session", async () => {
    const w = world();
    await signUpAndVerify(w, "ann@example.com", PASSWORD);
    const stranger = await anonymousJar(w);
    const asked = await w.handle(
      post("/auth/otp/request", { email: "ann@example.com" }, jarHeaders(stranger.cookie)),
    );
    expect(asked.status).toBe(200);
    const mail = w.mail.findLast((m) => m.to === "ann@example.com");
    const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
    if (!code) throw new Error("no code in the mail");
    // The owner enters the code in a browser with no session.
    const res = await w.handle(
      post(
        "/auth/otp/verify",
        { email: "ann@example.com", code: recordCredential(code) },
        jarHeaders(null),
      ),
    );
    expect(res.status).toBe(200);
    await kept(w, stranger);
  });

  it("links nothing at a phone code asked from a stranger's anonymous session", async () => {
    const w = world();
    const stranger = await anonymousJar(w);
    const asked = await w.handle(
      post("/auth/phone/request", { phone: PHONE }, jarHeaders(stranger.cookie)),
    );
    expect(asked.status).toBe(200);
    const text = w.sms.sent.findLast((s) => s.to === PHONE)?.text ?? "";
    const code = /^(\d+) is your /.exec(text)?.[1];
    if (!code) throw new Error("no code in the text");
    // The owner of the number enters the code in a browser with no session.
    const res = await w.handle(
      post("/auth/phone/verify", { phone: PHONE, code: recordCredential(code) }, jarHeaders(null)),
    );
    expect(res.status).toBe(200);
    await kept(w, stranger);
  });

  it("links nothing at a sign-up confirm asked from a stranger's anonymous session", async () => {
    const w = world({ password: { hash: FAST, uniformSignUp: true } });
    const stranger = await anonymousJar(w);
    const up = await w.handle(
      post(
        "/auth/password/sign-up",
        { email: "ann@example.com", password: PASSWORD },
        jarHeaders(stranger.cookie),
      ),
    );
    expect(up.status).toBe(200);
    const token = tokenFromMail(w.mail.findLast((m) => m.to === "ann@example.com")?.text ?? "");
    // The owner of the address opens the confirm link in a browser with no session.
    const res = await w.handle(post("/auth/password/verify", { token }, jarHeaders(null)));
    expect(res.status).toBe(200);
    await kept(w, stranger);
  });

  it("links one of two parallel upgrades of one anonymous session", async () => {
    const w = world();
    await signUpAndVerify(w, "ann@example.com", PASSWORD);
    await signUpAndVerify(w, "ben@example.com", PASSWORD);
    const anon = await anonymousJar(w);
    const signIn = (email: string) =>
      w.handle(
        post("/auth/password/sign-in", { email, password: PASSWORD }, jarHeaders(anon.cookie)),
      );
    const [a, b] = await Promise.all([signIn("ann@example.com"), signIn("ben@example.com")]);
    // Both sign in. Each may run beforeLink, and one claim wins: the data goes to one account.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const after = w.rec.links.filter((l) => l.point === "after");
    expect(after).toHaveLength(1);
    expect(["ann@example.com", "ben@example.com"]).toContain(after[0]?.event.user.email);
    await replaced(w, anon);
  });

  it("cannot replay a stolen anonymous token into a second account", async () => {
    const w = world();
    await signUpAndVerify(w, "ann@example.com", PASSWORD);
    await signUpAndVerify(w, "mal@example.com", PASSWORD);
    const anon = await anonymousJar(w);
    const first = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "ann@example.com", password: PASSWORD },
        jarHeaders(anon.cookie),
      ),
    );
    expect(first.status).toBe(200);
    // A copy of the anonymous token, sent after the upgrade, names no live session.
    const again = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "mal@example.com", password: PASSWORD },
        {
          ...ip(),
          authorization: `Bearer ${anon.token}`,
        },
      ),
    );
    expect(again.status).toBe(200);
    expect(w.rec.links.filter((l) => l.point === "after")).toHaveLength(1);
    expect(w.rec.links.every((l) => l.event.user.email === "ann@example.com")).toBe(true);
  });

  it("links nothing from a session that is not anonymous", async () => {
    const w = world();
    await signUpAndVerify(w, "ann@example.com", PASSWORD);
    const first = await magicLink(w, "bo@example.com", null, null);
    const cookie = `${w.config.cookieName}=${setToken(w, first)}`;
    const res = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "ann@example.com", password: PASSWORD },
        jarHeaders(cookie),
      ),
    );
    expect(res.status).toBe(200);
    expect(w.rec.links).toEqual([]);
    expect(w.rec.deleted).toEqual([]);
  });

  it("never links from an impersonation session, and ends it with the upgrade", async () => {
    const rec = recorder();
    const f = await operatorFixture({
      config: {
        operator: {
          secrets: [
            {
              name: "support",
              secretHash: await sha256Hex(OPERATOR_SECRETS.support),
              scopes: ["users", "sessions", "audit"],
            },
          ],
          users: true,
          impersonation: {},
        },
        anonymous: { isolateLimiter: "allow" },
        hooks: rec.hooks(),
      },
    });
    const w = {
      ...f.auth,
      handle: settled(createRouter(f.auth.config, coreRoutes(f.auth.config))),
      rec,
    } as unknown as World;
    const anon = await anonymousJar(w);
    const started = await startImpersonation(f.auth.config, {
      operator: f.operator,
      userId: anon.userId,
      reason: "A support case.",
      ip: null,
      userAgent: null,
    });
    if (!started.ok) throw new Error(started.code);
    const impersonating = `${w.config.cookieName}=${recordCredential(started.value.token)}`;
    await signUpAndVerify(f.auth, "ann@example.com", PASSWORD);
    // The operator's browser signs in to another account: the anonymous user is not theirs.
    const byOperator = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "ann@example.com", password: PASSWORD },
        jarHeaders(impersonating),
      ),
    );
    expect(byOperator.status).toBe(200);
    await kept(w, anon);
    // The person's own upgrade replaces the user, and every session of it ends.
    const own = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "ann@example.com", password: PASSWORD },
        jarHeaders(anon.cookie),
      ),
    );
    expect(own.status).toBe(200);
    expect(rec.links.map((l) => l.point)).toEqual(["before", "after"]);
    expect(await userOf(w, anon.userId)).toBeNull();
    expect(await sessionsOf(w, anon.userId)).toEqual([]);
    const ends = rec.ended.filter((e) => e.userId === anon.userId);
    expect(ends.map((e) => e.reason)).toEqual(["anonymous_upgrade", "anonymous_upgrade"]);
  });

  it("refuses an anonymous hook that is not a function, and the hooks with anonymous off", () => {
    expect(() =>
      makeAuth({
        anonymous: { isolateLimiter: "allow" },
        hooks: { anonymous: { beforeLink: "no" as never } },
      }),
    ).toThrow("hooks.anonymous.beforeLink must be a function");
    expect(() =>
      makeAuth({
        anonymous: { isolateLimiter: "allow" },
        hooks: { anonymous: { afterLink: 1 as never } },
      }),
    ).toThrow("hooks.anonymous.afterLink must be a function");
    expect(() => makeAuth({ hooks: { anonymous: { afterLink: () => {} } } })).toThrow(
      "hooks.anonymous needs anonymous: the hooks would never run",
    );
  });
});
