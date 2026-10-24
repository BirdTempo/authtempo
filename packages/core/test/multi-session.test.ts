import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import type { SessionEndReason } from "../src/engine/hooks.js";
import { requestMagicLink } from "../src/engine/magic-link.js";
import { banUser } from "../src/engine/operator/ban.js";
import { bagCookie } from "../src/http/cookies.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { SessionRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import {
  APP_ORIGIN,
  BASE_URL,
  get,
  makeAuth,
  post,
  recordAddress,
  settled,
  tokenFromMail,
} from "./helpers.js";
import {
  OPERATOR_EMAIL,
  OPERATOR_SECRETS,
  operatorFixture,
  secretActor,
} from "./operator-helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";
import { PASSWORD } from "./totp-helpers.js";

// Multi-session (plan 12i Task 11, spec 32 item 11, owner decision 4). Every
// session comes from a real sign-in through the router, in one cookie jar per
// browser. The bag cookie holds the other tokens of the browser. Each read
// resolves each token through resolveSession. The joins with Tasks 5 and 6
// (a phone user with no address, an anonymous user) are at the end.

const SESSION = "__Host-tempo_session";
const BAG = "__Host-tempo_sessions";
const DAY_MS = 86_400_000;

/** A browser: the cookies that the answers set, sent back on each request. */
function browser() {
  const cookies = new Map<string, string>();
  return {
    cookies,
    header(): Record<string, string> {
      if (cookies.size === 0) return {};
      return { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
    },
    take(res: Response): Response {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value === "" || /Max-Age=0(;|$)/.test(line)) cookies.delete(name);
        else cookies.set(name, value);
      }
      return res;
    },
    bag(): string[] {
      const value = cookies.get(BAG);
      return value === undefined ? [] : value.split(".");
    },
  };
}
type Browser = ReturnType<typeof browser>;

function world(extra: Partial<AuthConfig> = {}) {
  // The ends after the sign-ups: the confirm link of a sign-up ends the
  // sign-up's own session as a claim, which is no act of this test.
  const all: { session: SessionRow; reason: SessionEndReason }[] = [];
  const ends = {
    push: (e: (typeof all)[number]) => all.push(e),
    get list() {
      return all.filter((e) => e.reason !== "claim");
    },
  };
  const auth = makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    multiSession: {},
    hooks: { session: { afterEnd: (e) => void ends.push(e) } },
    ...extra,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  return { auth, handle, ends };
}
type World = ReturnType<typeof world>;

/** The user of `email`, signed up and verified once by the real flow. */
async function user(w: Pick<World, "auth">, email: string) {
  recordAddress(email);
  const found = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (found) return found;
  await signUpAndVerify(w.auth, email, PASSWORD);
  const made = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!made) throw new Error("no user");
  return made;
}

/** A password sign-in of `email` in browser `b`: the token of the new session cookie. */
async function signIn(w: Pick<World, "auth" | "handle">, b: Browser, email: string) {
  await user(w, email);
  const res = b.take(
    await w.handle(post("/auth/password/sign-in", { email, password: PASSWORD }, b.header())),
  );
  expect(res.status).toBe(200);
  const token = b.cookies.get(SESSION);
  if (token === undefined) throw new Error("no session cookie");
  return token;
}

/** The session row of `token`, or null. */
async function rowOf(w: Pick<World, "auth">, token: string) {
  return w.auth.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
}

async function idOf(w: Pick<World, "auth">, token: string): Promise<string> {
  const row = await rowOf(w, token);
  if (!row) throw new Error("no session row");
  return row.id;
}

type Listed = {
  sessionId: string;
  active: boolean;
  user: { id: string; name: string | null; email: string | null; username: string | null };
};

async function list(w: Pick<World, "handle">, b: Browser) {
  const res = b.take(await w.handle(get("/auth/multi-session", b.header())));
  return { res, body: (await res.clone().json()) as { sessions: Listed[] } };
}

describe("multi-session (plan 12i Task 11)", () => {
  it("moves the old token into the bag at a sign-in of another user", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    expect(b.cookies.get(SESSION)).toBe(bob);
    expect(b.bag()).toEqual([a]);
    // Both sessions live: the bag ends nothing.
    expect(await rowOf(w, a)).not.toBeNull();
    const { body } = await list(w, b);
    expect(body.sessions.map((s) => [s.user.email, s.active])).toEqual([
      ["bob@example.com", true],
      ["ada@example.com", false],
    ]);
    expect(w.ends.list).toEqual([]);
  });

  it("writes the bag at a magic link sign-in too: the router step covers every route", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    await user(w, "bob@example.com");
    const sent = await requestMagicLink(w.auth.config, { email: "bob@example.com", ip: null });
    if (!sent.ok) throw new Error(sent.code);
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const res = b.take(
      await w.handle(
        new Request(`${BASE_URL}/auth/magic-link/verify`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: BASE_URL,
            ...b.header(),
          },
          body: new URLSearchParams({ token }).toString(),
        }),
      ),
    );
    expect(res.status).toBe(302);
    expect(b.cookies.get(SESSION)).not.toBe(a);
    expect(b.bag()).toEqual([a]);
  });

  it("keeps one session per user", async () => {
    const w = world();
    const b = browser();
    const a1 = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const a1Id = await idOf(w, a1);
    const a2 = await signIn(w, b, "ada@example.com");
    // A's first session ended with sign_out; the bag holds B only.
    expect(await rowOf(w, a1)).toBeNull();
    expect(w.ends.list.map((e) => [e.session.id, e.reason])).toEqual([[a1Id, "sign_out"]]);
    expect(b.cookies.get(SESSION)).toBe(a2);
    expect(b.bag()).toEqual([bob]);
    // A sign-in of the active user again ends the old active session.
    const a3 = await signIn(w, b, "ada@example.com");
    expect(await rowOf(w, a2)).toBeNull();
    expect(b.cookies.get(SESSION)).toBe(a3);
    expect(b.bag()).toEqual([bob]);
  });

  it("never answers a token", async () => {
    const w = world();
    const b = browser();
    await signIn(w, b, "ada@example.com");
    await signIn(w, b, "bob@example.com");
    const { res, body } = await list(w, b);
    expect(res.status).toBe(200);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/ts_/);
    for (const s of body.sessions) {
      expect(Object.keys(s).sort()).toEqual(["active", "sessionId", "user"]);
      expect(Object.keys(s.user).sort()).toEqual(["email", "id", "image", "name", "username"]);
    }
  });

  it("switches the active session and makes no session fresh", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const freshBefore = [(await rowOf(w, a))?.freshAt, (await rowOf(w, bob))?.freshAt];
    w.auth.clock.advance(60 * 60_000);
    const res = b.take(
      await w.handle(
        post("/auth/multi-session/switch", { sessionId: await idOf(w, a) }, b.header()),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe("ada@example.com");
    expect(JSON.stringify(body)).not.toMatch(/ts_/);
    expect(b.cookies.get(SESSION)).toBe(a);
    expect(b.bag()).toEqual([bob]);
    expect([(await rowOf(w, a))?.freshAt, (await rowOf(w, bob))?.freshAt]).toEqual(freshBefore);
    // The session route now answers A.
    const now = (await (await w.handle(get("/auth/session", b.header()))).json()) as {
      user: { email: string };
    };
    expect(now.user.email).toBe("ada@example.com");
  });

  it("answers not_found to a switch to a session outside the bag and drops a revoked token", async () => {
    const w = world();
    const b = browser();
    await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    await signIn(w, b, "ada@example.com");
    // Another browser of Carol: her session id is not in this bag.
    const other = browser();
    const carol = await signIn(w, other, "carol@example.com");
    const outside = await w.handle(
      post("/auth/multi-session/switch", { sessionId: await idOf(w, carol) }, b.header()),
    );
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: "not_found" });
    // Bob revokes the session of this browser from another device.
    const phone = browser();
    await signIn(w, phone, "bob@example.com");
    const bobId = await idOf(w, bob);
    const revoked = await w.handle(post("/auth/sessions/revoke", { id: bobId }, phone.header()));
    expect(revoked.status).toBe(200);
    const res = b.take(
      await w.handle(post("/auth/multi-session/switch", { sessionId: bobId }, b.header())),
    );
    expect(res.status).toBe(404);
    expect(b.cookies.get(SESSION)).not.toBe(bob);
  });

  it("signs out one session", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const res = b.take(
      await w.handle(
        post("/auth/multi-session/sign-out", { sessionId: await idOf(w, a) }, b.header()),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rowOf(w, a)).toBeNull();
    expect(await rowOf(w, bob)).not.toBeNull();
    expect(b.cookies.get(SESSION)).toBe(bob);
    expect(b.cookies.has(BAG)).toBe(false);
    expect(res.headers.getSetCookie()).toContain(
      `${BAG}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("signs out the active session and makes the next bag session active", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const res = b.take(
      await w.handle(
        post("/auth/multi-session/sign-out", { sessionId: await idOf(w, bob) }, b.header()),
      ),
    );
    expect(res.status).toBe(200);
    expect(await rowOf(w, bob)).toBeNull();
    expect(b.cookies.get(SESSION)).toBe(a);
    expect(b.cookies.has(BAG)).toBe(false);
    // The last one: the session cookie goes too.
    const last = b.take(
      await w.handle(
        post("/auth/multi-session/sign-out", { sessionId: await idOf(w, a) }, b.header()),
      ),
    );
    expect(last.status).toBe(200);
    expect(b.cookies.size).toBe(0);
    expect(await rowOf(w, a)).toBeNull();
  });

  it("signs out every session of the browser", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const res = await w.handle(post("/auth/sign-out", {}, b.header()));
    expect(res.status).toBe(200);
    expect(await rowOf(w, a)).toBeNull();
    expect(await rowOf(w, bob)).toBeNull();
    expect(w.ends.list.map((e) => e.reason).sort()).toEqual(["sign_out", "sign_out"]);
    const sets = res.headers.getSetCookie();
    expect(sets).toContain(`${SESSION}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    expect(sets).toContain(`${BAG}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  });

  it("drops a banned user's token at the next read", async () => {
    const f = await operatorFixture({
      config: { multiSession: {}, password: { hash: FAST, uniformSignUp: false } },
    });
    const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
    const v = { auth: f.auth, handle };
    const b = browser();
    const bob = await signIn(v, b, "bob@example.com");
    await signIn(v, b, "ada@example.com");
    expect(b.bag()).toEqual([bob]);
    const bobRow = await rowOf(v, bob);
    const ban = await banUser(f.auth.config, {
      actor: await secretActor(f.auth, OPERATOR_SECRETS.support),
      userId: bobRow?.userId ?? "",
      reason: "abuse report 7",
      ip: null,
      userAgent: null,
    });
    expect(ban.ok).toBe(true);
    const { res, body } = await list(v, b);
    expect(body.sessions.map((s) => s.user.email)).toEqual(["ada@example.com"]);
    // The dead token leaves the cookie in the same answer.
    expect(res.headers.getSetCookie()).toContain(
      `${BAG}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(b.cookies.has(BAG)).toBe(false);
  });

  it("drops an expired token at the next read", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    // Bob signs in one day before A's session ends; then two days pass.
    const ttlMs = w.auth.config.session.ttlDays * DAY_MS;
    w.auth.clock.advance(ttlMs - DAY_MS);
    await signIn(w, b, "bob@example.com");
    expect(b.bag()).toEqual([a]);
    w.auth.clock.advance(2 * DAY_MS);
    const { body } = await list(w, b);
    expect(body.sessions.map((s) => s.user.email)).toEqual(["bob@example.com"]);
    expect(b.cookies.has(BAG)).toBe(false);
    // The read ended the row that it found expired.
    expect(await rowOf(w, a)).toBeNull();
  });

  it("drops an expired bag token at the next sign-in", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const ttlMs = w.auth.config.session.ttlDays * DAY_MS;
    w.auth.clock.advance(ttlMs - DAY_MS);
    const bob = await signIn(w, b, "bob@example.com");
    expect(b.bag()).toEqual([a]);
    w.auth.clock.advance(2 * DAY_MS);
    await signIn(w, b, "carol@example.com");
    // A's session ended by its expiry: only Bob's live token moves on.
    expect(b.bag()).toEqual([bob]);
  });

  it("ends the oldest session as displaced at a full bag", async () => {
    const w = world({ multiSession: { max: 2 } });
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    w.auth.clock.advance(1000);
    const bob = await signIn(w, b, "bob@example.com");
    w.auth.clock.advance(1000);
    await signIn(w, b, "carol@example.com");
    expect(await rowOf(w, a)).toBeNull();
    expect(await rowOf(w, bob)).not.toBeNull();
    expect(w.ends.list.map((e) => e.reason)).toEqual(["displaced"]);
    expect(b.bag()).toEqual([bob]);
  });

  it("answers 401 to a bearer", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    await signIn(w, b, "bob@example.com");
    const bearer = { authorization: `Bearer ${a}` };
    // The scheme name in any case (ruling 34 L2).
    const lower = { authorization: `bearer ${a}` };
    // A bearer with the cookies too: the header alone refuses.
    for (const headers of [bearer, { ...b.header(), ...bearer }, { ...b.header(), ...lower }]) {
      expect((await w.handle(get("/auth/multi-session", headers))).status).toBe(401);
      const id = await idOf(w, a);
      for (const path of ["/auth/multi-session/switch", "/auth/multi-session/sign-out"])
        expect((await w.handle(post(path, { sessionId: id }, headers))).status).toBe(401);
    }
    expect(await rowOf(w, a)).not.toBeNull();
  });

  it("slides no bag session at a list, so an idle bag session ends at its ttl", async () => {
    // Ruling 34 H1 (probe P1 of the Task 11 review): a list once slid each due bag session.
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const before = { a: (await rowOf(w, a))?.expiresAt, bob: (await rowOf(w, bob))?.expiresAt };
    const slideMs = w.auth.config.session.slidingRefreshDays * DAY_MS;
    w.auth.clock.advance(slideMs + DAY_MS);
    expect((await list(w, b)).body.sessions).toHaveLength(2);
    // The idle bag session keeps its expiry; the active session of the request slides.
    expect((await rowOf(w, a))?.expiresAt).toEqual(before.a);
    expect((await rowOf(w, bob))?.expiresAt.getTime()).toBeGreaterThan(before.bob?.getTime() ?? 0);
    // A list every slide period: A ends at its ttl, and the list drops it.
    while (w.auth.clock.now().getTime() <= (before.a?.getTime() ?? 0)) {
      w.auth.clock.advance(slideMs + DAY_MS);
      await list(w, b);
    }
    const { body } = await list(w, b);
    expect(body.sessions.map((s) => s.user.email)).toEqual(["bob@example.com"]);
    expect(await rowOf(w, a)).toBeNull();
    expect(b.cookies.has(BAG)).toBe(false);
    expect(w.ends.list.map((e) => e.reason)).toEqual(["expired"]);
  });

  it("slides the session that a switch makes active, and no other bag session", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const carol = await signIn(w, b, "carol@example.com");
    const before = { a: (await rowOf(w, a))?.expiresAt, bob: (await rowOf(w, bob))?.expiresAt };
    w.auth.clock.advance((w.auth.config.session.slidingRefreshDays + 1) * DAY_MS);
    const res = b.take(
      await w.handle(
        post("/auth/multi-session/switch", { sessionId: await idOf(w, a) }, b.header()),
      ),
    );
    expect(res.status).toBe(200);
    expect(b.cookies.get(SESSION)).toBe(a);
    expect(b.bag()).toEqual([bob, carol]);
    // The new active session gets the normal read of a request: its due refresh slides it.
    const slid = (await rowOf(w, a))?.expiresAt;
    expect(slid?.getTime()).toBeGreaterThan(before.a?.getTime() ?? 0);
    expect((await res.json()) as { session: { expiresAt: string } }).toMatchObject({
      session: { expiresAt: slid?.toISOString() },
    });
    // Bob stays idle in the bag: the switch does not move his expiry.
    expect((await rowOf(w, bob))?.expiresAt).toEqual(before.bob);
  });

  it("leaves the bag as it is at a sign-in with the Bearer scheme", async () => {
    // Ruling 34 L1: break R1 of the Task 11 review removed this rule, and no test failed.
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    await user(w, "carol@example.com");
    const res = await w.handle(
      post(
        "/auth/password/sign-in",
        { email: "carol@example.com", password: PASSWORD },
        { ...b.header(), authorization: `Bearer ${bob}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().filter((c) => c.startsWith(`${BAG}=`))).toEqual([]);
    expect(b.bag()).toEqual([a]);
    // Bob's session neither moved into the bag nor ended.
    expect(await rowOf(w, bob)).not.toBeNull();
    expect(w.ends.list).toEqual([]);
  });

  it("treats HTTP Basic as a browser: the bag moves and the routes serve", async () => {
    // Ruling 34 L2 (probe P2): only the Bearer scheme marks a bearer client.
    const w = world();
    const b = browser();
    const basic = { authorization: "Basic dXNlcjpwYXNz" };
    const a = await signIn(w, b, "ada@example.com");
    await user(w, "bob@example.com");
    const res = b.take(
      await w.handle(
        post(
          "/auth/password/sign-in",
          { email: "bob@example.com", password: PASSWORD },
          { ...b.header(), ...basic },
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(b.bag()).toEqual([a]);
    const listed = await w.handle(get("/auth/multi-session", { ...b.header(), ...basic }));
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { sessions: Listed[] }).sessions.map((s) => s.user.email),
    ).toEqual(["bob@example.com", "ada@example.com"]);
  });

  it("displaces the bag session used least recently, not the oldest one", async () => {
    // Ruling 34 L3 (probe P3): A, then B; a switch back to A; then C signs in.
    const w = world({ multiSession: { max: 2 } });
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    w.auth.clock.advance(1000);
    const bob = await signIn(w, b, "bob@example.com");
    w.auth.clock.advance(1000);
    const switched = await w.handle(
      post("/auth/multi-session/switch", { sessionId: await idOf(w, a) }, b.header()),
    );
    expect(b.take(switched).status).toBe(200);
    w.auth.clock.advance(1000);
    const bobId = await idOf(w, bob);
    const carol = await signIn(w, b, "carol@example.com");
    // A was in use one second ago, so idle Bob ends.
    expect(await rowOf(w, bob)).toBeNull();
    expect(await rowOf(w, a)).not.toBeNull();
    expect(w.ends.list.map((e) => [e.session.id, e.reason])).toEqual([[bobId, "displaced"]]);
    expect(b.cookies.get(SESSION)).toBe(carol);
    expect(b.bag()).toEqual([a]);
  });

  it("signs no request in with a bag token alone", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    await signIn(w, b, "bob@example.com");
    const bagOnly = { cookie: `${BAG}=${a}` };
    expect((await w.handle(get("/auth/session", bagOnly))).status).toBe(401);
    expect((await w.handle(get("/auth/multi-session", bagOnly))).status).toBe(401);
    const switched = await w.handle(
      post("/auth/multi-session/switch", { sessionId: await idOf(w, a) }, bagOnly),
    );
    expect(switched.status).toBe(401);
    // A bag token sent as the session cookie of another browser is that one session, and no more.
    const stolen = browser();
    stolen.cookies.set(SESSION, a);
    const { body } = await list(w, stolen);
    expect(body.sessions.map((s) => s.user.email)).toEqual(["ada@example.com"]);
  });

  it("refuses a cross-site switch", async () => {
    const w = world();
    const b = browser();
    const a = await signIn(w, b, "ada@example.com");
    const bob = await signIn(w, b, "bob@example.com");
    const id = await idOf(w, a);
    const foreign = await w.handle(
      post(
        "/auth/multi-session/switch",
        { sessionId: id },
        { ...b.header(), origin: "https://evil.example" },
      ),
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "origin_not_trusted" });
    // A form post of another site, with no Origin: the Fetch Metadata rule.
    const form = await w.handle(
      new Request(`${BASE_URL}/auth/multi-session/switch`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
          ...b.header(),
        },
        body: new URLSearchParams({ sessionId: id }).toString(),
      }),
    );
    expect(form.status).toBe(403);
    // A form post from the app's own origin is no JSON body: the route refuses it.
    const own = await w.handle(
      new Request(`${BASE_URL}/auth/multi-session/switch`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: APP_ORIGIN,
          ...b.header(),
        },
        body: new URLSearchParams({ sessionId: id }).toString(),
      }),
    );
    expect(own.status).toBe(400);
    expect(b.cookies.get(SESSION)).toBe(bob);
  });

  it("keeps the bag cookie HttpOnly, Secure, Path=/, __Host-, and under 600 bytes at 10 tokens", async () => {
    const w = world({ multiSession: { max: 10 } });
    const b = browser();
    let last: Response | null = null;
    for (let i = 0; i < 10; i++) {
      const email = `user${i}@example.com`;
      await user(w, email);
      last = b.take(
        await w.handle(post("/auth/password/sign-in", { email, password: PASSWORD }, b.header())),
      );
    }
    expect(b.bag()).toHaveLength(9);
    const line = last?.headers.getSetCookie().find((c) => c.startsWith(`${BAG}=`)) ?? "";
    expect(line).toMatch(
      /^__Host-tempo_sessions=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(line).not.toMatch(/Domain=/i);
    expect(new TextEncoder().encode(line).length).toBeLessThan(600);
    // Ten tokens, one more than the bag can hold, stay under 600 bytes too.
    const ten = [...b.bag(), b.cookies.get(SESSION) ?? ""];
    const full = bagCookie(BAG, ten, w.auth.config.session.ttlDays * 86_400, "Lax");
    expect(new TextEncoder().encode(full).length).toBeLessThan(600);
  });

  it("reads at most max - 1 bag tokens and no bag value over 512 characters", async () => {
    const w = world({ multiSession: { max: 2 } });
    // Three sessions of three browsers; a fourth browser carries their tokens in its own bag.
    const tokens: string[] = [];
    for (const email of ["ada@example.com", "bob@example.com", "carol@example.com"])
      tokens.push(await signIn(w, browser(), email));
    const b = browser();
    await signIn(w, b, "dan@example.com");
    b.cookies.set(BAG, tokens.join("."));
    const { body } = await list(w, b);
    expect(body.sessions.map((s) => s.user.email)).toEqual(["dan@example.com", "ada@example.com"]);
    expect(b.bag()).toEqual([tokens[0]]);
    // A value past 512 characters is no bag of core: none of it is read.
    b.cookies.set(BAG, [...tokens, ...tokens, ...tokens, ...tokens].join("."));
    const long = await list(w, b);
    expect(long.body.sessions.map((s) => s.user.email)).toEqual(["dan@example.com"]);
  });

  it("keeps the bag out of an impersonation", async () => {
    // The operator signs in with the second factor (the fixture), then Bob
    // signs in in the same browser, and the operator switches back.
    const f = await operatorFixture({
      config: {
        multiSession: {},
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
      },
    });
    const v = { auth: f.auth, handle: createRouter(f.auth.config, coreRoutes(f.auth.config)) };
    const b = browser();
    const op = f.operator.token;
    b.cookies.set(SESSION, op);
    const bob = await signIn(v, b, "bob@example.com");
    expect(b.bag()).toEqual([op]);
    const back = b.take(
      await v.handle(
        post("/auth/multi-session/switch", { sessionId: f.operator.session.id }, b.header()),
      ),
    );
    expect(back.status).toBe(200);
    expect(b.cookies.get(SESSION)).toBe(op);
    expect(b.bag()).toEqual([bob]);
    const carol = await user(v, "carol@example.com");
    const start = b.take(
      await v.handle(
        post(
          "/auth/operator/impersonate",
          { userId: carol.id, reason: "Ticket 4711: the user cannot see the invoices" },
          b.header(),
        ),
      ),
    );
    expect(start.status).toBe(200);
    // The actor cookie keeps the operator's token; the bag is as it was.
    expect(start.headers.getSetCookie().some((c) => c.startsWith(`${BAG}=`))).toBe(false);
    expect(b.cookies.get(`${SESSION}_actor`)).toBe(op);
    expect(b.bag()).toEqual([bob]);
    // An impersonation session reaches no multi-session route.
    const refused = [
      await v.handle(get("/auth/multi-session", b.header())),
      await v.handle(
        post("/auth/multi-session/switch", { sessionId: await idOf(v, bob) }, b.header()),
      ),
      await v.handle(
        post("/auth/multi-session/sign-out", { sessionId: await idOf(v, bob) }, b.header()),
      ),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "impersonation_session" });
    }
    const stop = b.take(await v.handle(post("/auth/operator/impersonate/stop", {}, b.header())));
    expect(stop.status).toBe(200);
    expect(stop.headers.getSetCookie().some((c) => c.startsWith(`${BAG}=`))).toBe(false);
    expect(b.cookies.get(SESSION)).toBe(op);
    expect(b.bag()).toEqual([bob]);
    const { body } = await list(v, b);
    expect(body.sessions.map((s) => [s.user.email, s.active])).toEqual([
      [OPERATOR_EMAIL, true],
      ["bob@example.com", false],
    ]);
  });

  it("refuses a bad multiSession config", () => {
    const make = (extra: Partial<AuthConfig>) => () => world(extra);
    expect(make({ multiSession: { max: 1 } })).toThrow(
      "multiSession.max must be an integer from 2 to 10",
    );
    expect(make({ multiSession: { max: 11 } })).toThrow(
      "multiSession.max must be an integer from 2 to 10",
    );
    expect(make({ multiSession: { size: 3 } as never })).toThrow(
      "multiSession.size is not an option",
    );
    // The bag takes the session cookie name with s; no other cookie of core may hold it.
    expect(make({ multiSession: {}, lastMethod: { cookieName: BAG } })).toThrow(
      "multiSession needs the cookie name __Host-tempo_sessions",
    );
    expect(make({ multiSession: {}, totp: { trustCookieName: BAG } })).toThrow(
      "multiSession needs the cookie name __Host-tempo_sessions",
    );
    expect(world({ cookieName: "app_session" }).auth.config.multiSession).toEqual({
      max: 5,
      cookieName: "app_sessions",
    });
  });

  it("refuses multi-session off: no route and no bag", async () => {
    const w = world({ multiSession: false });
    const b = browser();
    await signIn(w, b, "ada@example.com");
    await signIn(w, b, "bob@example.com");
    expect(b.cookies.has(BAG)).toBe(false);
    expect((await w.handle(get("/auth/multi-session", b.header()))).status).toBe(404);
  });
});

describe("multi-session with the phone and anonymous users (plan 12i Tasks 5, 6, and 11)", () => {
  const PHONE = "+14155550100";
  let ip = 0;
  const fromNewIp = () => ({ "cf-connecting-ip": `198.51.100.${++ip}` });

  /**
   * The multi-session world with phone and anonymous on, and a router that
   * waits for the SMS. `ends` and `links` record the session ends and the
   * upgrade hooks (Task 7). `afterLink` may throw.
   */
  function joinWorld(extra: { max?: number; afterLinkThrows?: boolean } = {}) {
    const sms = createRecordingSms();
    const ends: [string, SessionEndReason][] = [];
    const links: string[] = [];
    const auth = makeAuth({
      password: { hash: FAST, uniformSignUp: false },
      multiSession: extra.max === undefined ? {} : { max: extra.max },
      phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
      anonymous: { isolateLimiter: "allow" },
      hooks: {
        session: { afterEnd: (e) => void ends.push([e.session.id, e.reason]) },
        anonymous: {
          beforeLink: (e) => void links.push(`before ${e.via}`),
          afterLink: (e) => {
            links.push(`after ${e.via}`);
            if (extra.afterLinkThrows) throw new Error("the app's move failed");
          },
        },
      },
    });
    const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
    return { auth, handle, sms, ends, links };
  }
  type JoinWorld = ReturnType<typeof joinWorld>;

  /** A sign-up by the phone code in browser `b`: a user with no address (Task 5). */
  async function phoneSignIn(w: JoinWorld, b: Browser) {
    const sent = await w.handle(post("/auth/phone/request", { phone: PHONE }, fromNewIp()));
    expect(await sent.json()).toEqual({ sent: true });
    const text = w.sms.sent.findLast((m) => m.to === PHONE)?.text ?? "";
    const code = /^(\d+) is your /.exec(text)?.[1] ?? "";
    const res = b.take(
      await w.handle(
        post("/auth/phone/verify", { phone: PHONE, code }, { ...b.header(), ...fromNewIp() }),
      ),
    );
    expect(res.status).toBe(200);
    return b.cookies.get(SESSION) ?? "";
  }

  /** An anonymous sign-in in browser `b` (Task 6). */
  async function anonymousSignIn(w: JoinWorld, b: Browser) {
    const res = b.take(
      await w.handle(post("/auth/anonymous/sign-in", {}, { ...b.header(), ...fromNewIp() })),
    );
    expect(res.status).toBe(200);
    return b.cookies.get(SESSION) ?? "";
  }

  it("lists and switches to a phone user with no address (Task 5)", async () => {
    const w = joinWorld();
    const b = browser();
    const phone = await phoneSignIn(w, b);
    await signIn(w, b, "ada@example.com");
    expect(b.bag()).toEqual([phone]);
    const { body } = await list(w, b);
    expect(body.sessions.map((s) => s.user.email)).toEqual(["ada@example.com", null]);
    const res = b.take(
      await w.handle(
        post("/auth/multi-session/switch", { sessionId: await idOf(w, phone) }, b.header()),
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string | null } }).user.email).toBeNull();
    expect(b.cookies.get(SESSION)).toBe(phone);
  });

  /**
   * A full bag of max 3 (bob, cy) under an anonymous active session: the
   * stranded bag, the one reachable way (see the test below). `guest` is
   * the anonymous token. dee@example.com exists. `ends` and `links` start empty.
   */
  async function strandedFullBag(w: JoinWorld, b: Browser) {
    const bob = await signIn(w, b, "bob@example.com");
    const cy = await signIn(w, b, "cy@example.com");
    const ada = await signIn(w, b, "ada@example.com");
    expect(b.bag()).toEqual([bob, cy]);
    const other = browser();
    await signIn(w, other, "ada@example.com");
    const revoked = await w.handle(
      post("/auth/sessions/revoke", { id: await idOf(w, ada) }, other.header()),
    );
    expect(revoked.status).toBe(200);
    const guest = await anonymousSignIn(w, b);
    expect(b.bag()).toEqual([bob, cy]);
    const guestId = await idOf(w, guest);
    const guestUser = (await rowOf(w, guest))?.userId ?? "";
    // The user of the upgrade, made now: its sign-up ends would land in `ends`.
    await user(w, "dee@example.com");
    w.ends.length = 0;
    w.links.length = 0;
    return { bob, cy, guest, guestId, guestUser };
  }

  it("upgrades an anonymous session with a full bag: it ends as anonymous_upgrade and never enters the bag (Tasks 7 and 11)", async () => {
    const w = joinWorld({ max: 3 });
    const b = browser();
    const { bob, cy, guest, guestId, guestUser } = await strandedFullBag(w, b);
    const dee = await signIn(w, b, "dee@example.com");
    expect(w.links).toEqual(["before password", "after password"]);
    expect(b.cookies.get(SESSION)).toBe(dee);
    // The anonymous session takes no bag place, so no bag session is displaced.
    expect(b.bag()).toEqual([bob, cy]);
    expect(w.ends).toEqual([[guestId, "anonymous_upgrade"]]);
    expect(await rowOf(w, guest)).toBeNull();
    expect(
      await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: guestUser }]),
    ).toBeNull();
    // The new session enters the bag at the next sign-in, as any session does.
    const bobId = await idOf(w, bob);
    await user(w, "eve@example.com");
    w.ends.length = 0;
    const eve = await signIn(w, b, "eve@example.com");
    expect(b.cookies.get(SESSION)).toBe(eve);
    expect(b.bag()).toEqual([cy, dee]);
    expect(w.ends).toEqual([[bobId, "displaced"]]);
  });

  it("keeps an anonymous session out of the bag when afterLink throws, and displaces nobody (Tasks 7 and 11)", async () => {
    const w = joinWorld({ max: 3, afterLinkThrows: true });
    const b = browser();
    const { bob, cy, guest } = await strandedFullBag(w, b);
    const dee = await signIn(w, b, "dee@example.com");
    expect(w.links).toEqual(["before password", "after password"]);
    expect(b.cookies.get(SESSION)).toBe(dee);
    // The anonymous session stays live, for the sweep, but it never takes a bag place.
    expect(await rowOf(w, guest)).not.toBeNull();
    expect(b.bag()).toEqual([bob, cy]);
    expect(w.ends).toEqual([]);
  });

  it("serves the three routes to an anonymous session, which never enters the bag (Task 6)", async () => {
    // The reachable way to an anonymous session with a bag: the active
    // session ends on another device, and the browser then signs in anonymously.
    const w = joinWorld();
    const b = browser();
    const bob = await signIn(w, b, "bob@example.com");
    const ada = await signIn(w, b, "ada@example.com");
    expect(b.bag()).toEqual([bob]);
    const other = browser();
    await signIn(w, other, "ada@example.com");
    const revoked = await w.handle(
      post("/auth/sessions/revoke", { id: await idOf(w, ada) }, other.header()),
    );
    expect(revoked.status).toBe(200);
    const guest = await anonymousSignIn(w, b);
    expect(b.bag()).toEqual([bob]);
    // The list answers the anonymous active session with no address.
    const { res, body } = await list(w, b);
    expect(res.status).toBe(200);
    expect(body.sessions.map((s) => [s.active, s.user.email])).toEqual([
      [true, null],
      [false, "bob@example.com"],
    ]);
    // A switch is no sign-in (Task 7): it links nothing and ends nothing. The token stays out of the bag.
    const switched = b.take(
      await w.handle(
        post("/auth/multi-session/switch", { sessionId: await idOf(w, bob) }, b.header()),
      ),
    );
    expect(switched.status).toBe(200);
    expect(b.cookies.get(SESSION)).toBe(bob);
    expect(b.bag()).toEqual([]);
    expect(await rowOf(w, guest)).not.toBeNull();
    expect(w.links).toEqual([]);
    expect(w.ends.map(([, reason]) => reason).filter((r) => r !== "claim")).toEqual(["revoked"]);
    // The sign-out of one ends the anonymous user's own session.
    const again = browser();
    const guest2 = await anonymousSignIn(w, again);
    const out = again.take(
      await w.handle(
        post("/auth/multi-session/sign-out", { sessionId: await idOf(w, guest2) }, again.header()),
      ),
    );
    expect(out.status).toBe(200);
    expect(await rowOf(w, guest2)).toBeNull();
    expect(again.cookies.size).toBe(0);
  });
});
