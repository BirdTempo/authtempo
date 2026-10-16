import { createMemoryAdapter, createMemoryLimiter, systemClock } from "@authtempo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { magicLink } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { COOKIE_NAME } from "../src/server/shapes.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";

// The gaps of the plan 12a audit, one block per task (Tasks 17 to 20).

const BASE = "https://api.example.com";
const PATH = `${BASE}/api/auth`;
const SECRET = "0123456789abcdef0123456789abcdef";
const DAY_MS = 86_400_000;

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

/** The session cookie a response sets, as `name=value`, or "". */
const sessionPair = (res: Response) =>
  (res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "").split(";")[0] ??
  "";

/** A shim on a memory database, with the magic link to sign in. */
function instance(extra: Partial<BetterAuthOptions> = {}) {
  const links: string[] = [];
  const database = memoryDatabase();
  const options: BetterAuthOptions = {
    baseURL: BASE,
    secret: SECRET,
    database,
    trustedOrigins: [BASE],
    plugins: [magicLink({ sendMagicLink: async ({ url }) => void links.push(url) })],
    ...extra,
  };
  const auth = betterAuth(options);
  /** A verified user and the cookie of its session, by the magic link. */
  async function signedIn(email: string) {
    await auth.api.signInMagicLink({ body: { email } });
    const token = new URL(links.at(-1) ?? "").searchParams.get("token") ?? "";
    const res = await auth.handler(
      new Request(`${PATH}/magic-link/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ token }),
      }),
    );
    const cookie = sessionPair(res);
    if (!cookie) throw new Error(`the magic link answered ${res.status}`);
    return { cookie, token: cookie.slice(COOKIE_NAME.length + 1) };
  }
  const get = (path: string, cookie: string) =>
    auth.handler(new Request(`${PATH}${path}`, { headers: { cookie } }));
  const post = (path: string, cookie: string) =>
    auth.handler(
      new Request(`${PATH}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: "{}",
      }),
    );
  /** The expiry of the one session row, in ms. */
  async function expiry(): Promise<number> {
    const rows = await database.storage.findMany("session", []);
    if (rows.length !== 1 || !rows[0])
      throw new Error(`expected one session, found ${rows.length}`);
    return rows[0].expiresAt.getTime();
  }
  return { auth, signedIn, get, post, expiry };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Task 17 deferSessionRefresh", () => {
  it("maps deferSessionRefresh, and answers needsRefresh on GET /get-session", async () => {
    const options = { baseURL: BASE, secret: SECRET, database: memoryDatabase() };
    expect(
      mapOptions({ ...options, session: { deferSessionRefresh: true } }).config.session,
    ).toEqual({ ttlDays: 7, slidingRefreshDays: 1, freshMinutes: 1440, deferRefresh: true });
    expect(
      checkOptions({
        ...options,
        session: { deferSessionRefresh: "yes" as unknown as boolean },
      }).refusals,
    ).toEqual(["session.deferSessionRefresh: expected a boolean"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = instance({ session: { deferSessionRefresh: true } });
    const me = await s.signedIn("ada@example.com");
    const first = await s.get("/get-session", me.cookie);
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      needsRefresh: unknown;
      session: { token: string };
      user: { email: string };
    };
    expect(body.needsRefresh).toBe(false);
    expect(body.session.token).toBe(me.token);
    expect(body.user.email).toBe("ada@example.com");
    const before = await s.expiry();
    // Past Better Auth's default updateAge of one day.
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const due = await s.get("/get-session", me.cookie);
    expect(due.status).toBe(200);
    expect(due.headers.getSetCookie()).toEqual([]);
    expect(((await due.json()) as { needsRefresh: unknown }).needsRefresh).toBe(true);
    const viaApi = await s.auth.api.getSession({ headers: new Headers({ cookie: me.cookie }) });
    expect(viaApi?.needsRefresh).toBe(true);
    expect(await s.expiry()).toBe(before);
  });

  it("answers POST /get-session as Better Auth does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const on = instance({ session: { deferSessionRefresh: true } });
    const me = await on.signedIn("ada@example.com");
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const refreshed = await on.post("/get-session", me.cookie);
    expect(refreshed.status).toBe(200);
    expect(sessionPair(refreshed)).toBe(me.cookie);
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["session", "user"]);
    expect(await on.expiry()).toBe(Date.now() + 7 * DAY_MS);
    const after = await on.get("/get-session", me.cookie);
    expect(((await after.json()) as { needsRefresh: unknown }).needsRefresh).toBe(false);
    // With no session, Better Auth answers null with 200.
    expect(await (await on.post("/get-session", "")).json()).toBeNull();

    const off = instance();
    const you = await off.signedIn("bob@example.com");
    const refused = await off.post("/get-session", you.cookie);
    expect(refused.status).toBe(405);
    expect(await refused.json()).toEqual({
      code: "METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED",
      message: "POST method requires deferSessionRefresh to be enabled in session config",
    });
    // With the option off, a GET refreshes as before and answers no needsRefresh.
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const read = await off.get("/get-session", you.cookie);
    expect(sessionPair(read)).toBe(you.cookie);
    expect(Object.keys((await read.json()) as object).sort()).toEqual(["session", "user"]);
    expect(await off.expiry()).toBe(Date.now() + 7 * DAY_MS);
    expect(await (await off.get("/get-session", "")).json()).toBeNull();
  });
});
