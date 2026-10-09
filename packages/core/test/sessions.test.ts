import { describe, expect, it } from "vitest";
import {
  createSession,
  destroySession,
  readSessionToken,
  resolveSession,
} from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { sessionRoutes } from "../src/http/routes/sessions.js";
import { get, makeAuth, post } from "./helpers.js";

const DAY = 86_400_000;

describe("sessions engine", () => {
  it("creates a session, stores only the hash, and resolves it", async () => {
    const { config, storage, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token, session } = await createSession(config, {
      userId: user.id,
      ip: "1.2.3.4",
      userAgent: "ua",
    });
    expect(token.startsWith("ts_")).toBe(true);
    expect(session.tokenHash).not.toContain(token);
    const rows = await storage.findMany("session", []);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token.slice(3));
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(30 * DAY);
    const resolved = await resolveSession(config, token);
    expect(resolved?.user.email).toBe("a@example.com");
    expect(resolved?.refreshed).toBe(false);
    expect(resolved?.session.id).toBe(session.id);
  });

  it("returns null and does not throw for an unknown or malformed token", async () => {
    const { config } = makeAuth();
    expect(await resolveSession(config, "ts_" + "A".repeat(43))).toBeNull();
    expect(await resolveSession(config, "garbage")).toBeNull();
    expect(await resolveSession(config, "")).toBeNull();
  });

  it("returns null for an expired session and deletes the row", async () => {
    const { config, storage, clock, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    clock.advance(31 * DAY);
    expect(await resolveSession(config, token)).toBeNull();
    expect(await storage.findMany("session", [])).toHaveLength(0);
  });

  it("expires at exactly the ttl", async () => {
    const { config, storage, clock, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    clock.advance(30 * DAY);
    expect(await resolveSession(config, token)).toBeNull();
    expect(await storage.findMany("session", [])).toHaveLength(0);
  });

  it("still resolves one millisecond before the ttl", async () => {
    const { config, clock, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    clock.advance(30 * DAY - 1);
    expect(await resolveSession(config, token)).not.toBeNull();
  });

  it("refreshes at exactly slidingRefreshDays and not one millisecond before", async () => {
    const { config, storage, clock, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token, session } = await createSession(config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    const where = [{ field: "id" as const, op: "eq" as const, value: session.id }];
    clock.advance(7 * DAY - 1);
    const before = await resolveSession(config, token);
    expect(before?.refreshed).toBe(false);
    expect(before?.session.expiresAt.getTime()).toBe(session.expiresAt.getTime());
    const storedBefore = await storage.findOne("session", where);
    expect(storedBefore?.lastSeenAt.getTime()).toBe(session.lastSeenAt.getTime());
    clock.advance(1);
    const at = await resolveSession(config, token);
    expect(at?.refreshed).toBe(true);
    expect(at?.session.expiresAt.getTime()).toBe(clock.now().getTime() + 30 * DAY);
    const stored = await storage.findOne("session", where);
    expect(stored?.expiresAt.getTime()).toBe(at?.session.expiresAt.getTime());
    expect(stored?.lastSeenAt.getTime()).toBe(at?.session.lastSeenAt.getTime());
    expect(stored?.lastSeenAt.getTime()).toBe(clock.now().getTime());
  });

  it("slides the expiry after slidingRefreshDays", async () => {
    const { config, clock, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token, session } = await createSession(config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    clock.advance(3 * DAY);
    const early = await resolveSession(config, token);
    expect(early?.session.expiresAt.getTime()).toBe(session.expiresAt.getTime());
    clock.advance(5 * DAY);
    const late = await resolveSession(config, token);
    expect(late?.session.expiresAt.getTime()).toBe(clock.now().getTime() + 30 * DAY);
    expect(late?.session.lastSeenAt.getTime()).toBe(clock.now().getTime());
  });

  it("returns null when the user row is gone", async () => {
    const { config, storage, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    await storage.delete("user", [{ field: "id", op: "eq", value: user.id }]);
    expect(await resolveSession(config, token)).toBeNull();
  });

  it("destroys a session", async () => {
    const { config, seedUser } = makeAuth();
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    await destroySession(config, token);
    expect(await resolveSession(config, token)).toBeNull();
    await expect(destroySession(config, token)).resolves.toBeUndefined();
  });

  it("reads the cookie first, then the bearer header", () => {
    const { config } = makeAuth();
    expect(readSessionToken(config, get("/x", { cookie: "tempo_session=ts_c" }))).toBe("ts_c");
    expect(readSessionToken(config, get("/x", { authorization: "Bearer ts_b" }))).toBe("ts_b");
    expect(
      readSessionToken(
        config,
        get("/x", { cookie: "tempo_session=ts_c", authorization: "Bearer ts_b" }),
      ),
    ).toBe("ts_c");
    expect(readSessionToken(config, get("/x", { authorization: "Basic abc" }))).toBeNull();
    expect(readSessionToken(config, get("/x"))).toBeNull();
  });
});

describe("session routes", () => {
  it("GET /session returns the user for a cookie and 401 otherwise", async () => {
    const { config, seedUser } = makeAuth();
    const handle = createRouter(config, sessionRoutes(config));
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    const ok = await handle(get("/auth/session", { cookie: `tempo_session=${token}` }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { user: { email: string }; session: { expiresAt: string } };
    expect(body.user.email).toBe("a@example.com");
    expect(typeof body.session.expiresAt).toBe("string");
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect((await handle(get("/auth/session"))).status).toBe(401);
  });

  it("POST /sign-out deletes the session and clears the cookie", async () => {
    const { config, seedUser } = makeAuth();
    const handle = createRouter(config, sessionRoutes(config));
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    const res = await handle(post("/auth/sign-out", {}, { cookie: `tempo_session=${token}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await resolveSession(config, token)).toBeNull();
    expect((await handle(post("/auth/sign-out", {}))).status).toBe(200);
  });

  it("GET /session renews the cookie after a sliding refresh and not before", async () => {
    const { config, clock, seedUser } = makeAuth();
    const handle = createRouter(config, sessionRoutes(config));
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    const cookie = `tempo_session=${token}`;
    clock.advance(7 * DAY - 1);
    const before = await handle(get("/auth/session", { cookie }));
    expect(before.status).toBe(200);
    expect(before.headers.get("set-cookie")).toBeNull();
    clock.advance(1);
    const at = await handle(get("/auth/session", { cookie }));
    expect(at.status).toBe(200);
    const set = at.headers.get("set-cookie") ?? "";
    expect(set).toContain(`tempo_session=${token};`);
    expect(set).toContain(`Max-Age=${30 * 86_400};`);
    expect(set).toContain("HttpOnly");
  });

  it("GET /session never sets a cookie for a bearer request, even after a refresh", async () => {
    const { config, clock, seedUser } = makeAuth();
    const handle = createRouter(config, sessionRoutes(config));
    const user = await seedUser("a@example.com");
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    clock.advance(7 * DAY);
    const res = await handle(get("/auth/session", { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("GET /session clears a dead cookie on 401, and sets nothing without one", async () => {
    const { config } = makeAuth();
    const handle = createRouter(config, sessionRoutes(config));
    const dead = await handle(
      get("/auth/session", { cookie: `tempo_session=ts_${"A".repeat(43)}` }),
    );
    expect(dead.status).toBe(401);
    expect(dead.headers.get("set-cookie")).toContain("tempo_session=; ");
    expect(dead.headers.get("set-cookie")).toContain("Max-Age=0");
    const none = await handle(
      get("/auth/session", { authorization: `Bearer ts_${"A".repeat(43)}` }),
    );
    expect(none.status).toBe(401);
    expect(none.headers.get("set-cookie")).toBeNull();
  });
});
