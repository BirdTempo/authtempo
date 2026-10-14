import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { LIVE_PER_SESSION, signToken } from "../src/engine/jwt.js";
import { createSession, destroySession } from "../src/engine/sessions.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import {
  ACCESS_TOKEN_TYPE,
  DEFAULT_COOKIE_NAME,
  LEGACY_COOKIE_NAME,
} from "../src/primitives/credentials.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth } from "./helpers.js";

/** One storage, clock, and limiter for the engine view and the routes. */
function liveHandle(extra: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const limiter = createMemoryLimiter(base.clock);
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter,
    ...extra,
  };
  return { ...base, auth: createAuth(input), input };
}

type Live = ReturnType<typeof liveHandle>;

/** A user with a session, and a session JWT that GET /token minted for it. */
async function withJwt(h: Live, email = "ada@example.com") {
  const user = await h.seedUser(email);
  const { token, session } = await createSession(h.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
  });
  const res = await h.auth.handle(
    get("/auth/token", { cookie: `${DEFAULT_COOKIE_NAME}=${token}` }),
  );
  if (res.status !== 200) throw new Error(`GET /token answered ${res.status}`);
  const { token: jwt } = (await res.json()) as { token: string };
  return { user, session, sessionToken: token, jwt };
}

/** The live check as a resource server sends it: a POST with the JWT as the bearer and no Origin. */
function live(bearer: string | null, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}/auth/token/live`, {
    method: "POST",
    headers: { ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
  });
}

describe("POST /token/live (plan 11d)", () => {
  it("answers live true while the session exists, and false after the sign-out", async () => {
    const h = liveHandle();
    const s = await withJwt(h);
    const res = await h.auth.handle(live(s.jwt));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ live: true });
    await destroySession(h.config, s.sessionToken);
    expect(await (await h.auth.handle(live(s.jwt))).json()).toEqual({ live: false });
  });

  it("answers live false when the session expired, while the JWT still verifies", async () => {
    const h = liveHandle();
    const s = await withJwt(h);
    // The JWT lives 15 minutes; move the session row's expiry into the past.
    await h.storage.update("session", [{ field: "id", op: "eq", value: s.session.id }], {
      expiresAt: new Date(h.clock.now().getTime() - 1),
    });
    expect(await (await h.auth.handle(live(s.jwt))).json()).toEqual({ live: false });
  });

  it("answers 401 for no bearer, a session token, a cookie alone, a changed JWT, an access token, and an expired JWT", async () => {
    const h = liveHandle();
    const s = await withJwt(h);
    const changed = `${s.jwt.slice(0, -2)}${s.jwt.endsWith("AA") ? "BB" : "AA"}`;
    // An access token: the same claims under the same key, with the header typ at+jwt.
    const claims = decodeJws(s.jwt)?.payload;
    if (!claims) throw new Error("the session JWT does not decode");
    const access = await signToken(h.config, ACCESS_TOKEN_TYPE, claims);
    for (const req of [
      live(null),
      live(s.sessionToken),
      live(null, { cookie: `${DEFAULT_COOKIE_NAME}=${s.sessionToken}` }),
      live(null, { cookie: `${LEGACY_COOKIE_NAME}=${s.sessionToken}` }),
      live("not-a-token"),
      live(changed),
      live(access),
    ]) {
      const res = await h.auth.handle(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    h.clock.advance(15 * 60_000 + 1);
    expect((await h.auth.handle(live(s.jwt))).status).toBe(401);
  });

  it("answers 401 for a JWT of another audience on the same keys", async () => {
    const h = liveHandle();
    const s = await withJwt(h);
    // A second instance on the same storage and secret mints for another audience.
    const other = createAuth({ ...h.input, jwtMint: { audience: "https://files.example.com" } });
    const res = await other.handle(
      get("/auth/token", { cookie: `${DEFAULT_COOKIE_NAME}=${s.sessionToken}` }),
    );
    const { token: foreign } = (await res.json()) as { token: string };
    expect((await h.auth.handle(live(foreign))).status).toBe(401);
    expect(await (await other.handle(live(foreign))).json()).toEqual({ live: true });
  });

  it("counts 120 checks per session per minute, and a second session has its own count", async () => {
    const h = liveHandle();
    const s = await withJwt(h);
    const t = await withJwt(h, "grace@example.com");
    expect(LIVE_PER_SESSION).toEqual({ seconds: 60, max: 120 });
    for (let i = 0; i < 120; i++) expect((await h.auth.handle(live(s.jwt))).status).toBe(200);
    const limited = await h.auth.handle(live(s.jwt));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await h.auth.handle(live(t.jwt))).status).toBe(200);
    h.clock.advance(60_000);
    expect((await h.auth.handle(live(s.jwt))).status).toBe(200);
  });

  it("spends no count for a bearer that is not a session JWT", async () => {
    const h = liveHandle();
    const s = await withJwt(h);
    for (let i = 0; i < 200; i++) await h.auth.handle(live(s.sessionToken));
    expect((await h.auth.handle(live(s.jwt))).status).toBe(200);
  });

  it("answers live false, and mints nothing, when the absolute cap ended the session", async () => {
    const DAY = 86_400_000;
    const h = liveHandle({ session: { absoluteDays: 1 } });
    const user = await h.seedUser("ada@example.com");
    const { token, session } = await createSession(h.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    // Mint 5 minutes before the cap; the JWT lives 15 minutes, so it outlives the cap.
    h.clock.advance(DAY - 5 * 60_000);
    const minted = await h.auth.handle(
      get("/auth/token", { cookie: `${DEFAULT_COOKIE_NAME}=${token}` }),
    );
    const { token: jwt } = (await minted.json()) as { token: string };
    expect(await (await h.auth.handle(live(jwt))).json()).toEqual({ live: true });
    h.clock.advance(6 * 60_000);
    // The row still exists here. The live check and the mint run before the session
    // route, because a session read deletes a capped row and would hide a gap.
    expect(await (await h.auth.handle(live(jwt))).json()).toEqual({ live: false });
    const r = await h.auth.api.jwt?.mint({ userId: user.id, sessionId: session.id });
    expect(r).toEqual({ ok: false, code: "unauthorized", status: 401 });
    // The session route agrees: the cap ended the session.
    const s = await h.auth.handle(
      get("/auth/session", { cookie: `${DEFAULT_COOKIE_NAME}=${token}` }),
    );
    expect(s.status).toBe(401);
  });

  it("does not exist with jwtMint off", async () => {
    const h = liveHandle({ jwtMint: false });
    expect((await h.auth.handle(live("x"))).status).toBe(404);
  });
});
