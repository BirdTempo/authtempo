import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { bindingCookieName } from "../src/http/cookies.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { TEST_SECRET } from "../src/testing/soft-authenticator.js";

const BASE = "https://api.example.com";

function setup(extra: Partial<AuthConfig> = {}) {
  const input: AuthConfig = {
    baseURL: BASE,
    secret: TEST_SECRET,
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    clock: { now: () => new Date("2026-10-14T00:00:00.000Z") },
    ...extra,
  };
  const config = resolveConfig(input);
  return { auth: createAuth(input), config };
}

const get = (path: string, cookie: string) =>
  new Request(`${BASE}/auth${path}`, { headers: { cookie } });

describe("the session cookie name (plan 12b)", () => {
  it("is __Host-tempo_session by default, on Path=/, Secure, HttpOnly, with no Domain", async () => {
    const { auth, config } = setup();
    expect(config.cookieName).toBe("__Host-tempo_session");
    await config.storage.create("user", {
      id: "u2",
      email: "a@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: new Date("2026-10-14T00:00:00.000Z"),
      updatedAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    const s = await createSession(config, { userId: "u2", ip: null, userAgent: null });
    const res = await auth.handle(get("/session", `tempo_session=${s.token}`));
    const set = res.headers.getSetCookie();
    const moved = set.find((c) => c.startsWith("__Host-tempo_session="));
    expect(moved).toBe(
      `__Host-tempo_session=${s.token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(moved).not.toMatch(/Domain=/i);
  });

  it("reads the old cookie once and replaces it (Review Focus 5)", async () => {
    const { auth, config } = setup();
    await config.storage.create("user", {
      id: "u1",
      email: "a@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: new Date("2026-10-14T00:00:00.000Z"),
      updatedAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    const s = await createSession(config, { userId: "u1", ip: null, userAgent: null });
    const first = await auth.handle(get("/session", `tempo_session=${s.token}`));
    expect(first.status).toBe(200);
    expect(first.headers.getSetCookie()).toEqual([
      `__Host-tempo_session=${s.token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
    const second = await auth.handle(get("/session", `__Host-tempo_session=${s.token}`));
    expect(second.status).toBe(200);
    expect(second.headers.getSetCookie()).toEqual([]);
    // In process, auth.session reads the old cookie too; it sets nothing.
    expect((await auth.session(get("/session", `tempo_session=${s.token}`)))?.user.id).toBe("u1");
  });

  it("lets auth.caller read the old cookie, so an app route keeps the session for one release", async () => {
    const { auth, config } = setup();
    await config.storage.create("user", {
      id: "u3",
      email: "c@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: new Date("2026-10-14T00:00:00.000Z"),
      updatedAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    const s = await createSession(config, { userId: "u3", ip: null, userAgent: null });
    const caller = await auth.caller(get("/x", `tempo_session=${s.token}`));
    expect(caller?.kind).toBe("session");
    expect(caller?.kind === "session" ? caller.user.id : null).toBe("u3");
  });

  it("clears a dead old cookie and sets no new one", async () => {
    const { auth } = setup();
    const res = await auth.handle(get("/session", `tempo_session=ts_${"a".repeat(43)}`));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("moves no session that is past the absolute cap, also on a route that reads no session", async () => {
    const storage = createMemoryAdapter();
    const { config } = setup({ storage });
    const s = await createSession(config, { userId: "u1", ip: null, userAgent: null });
    // Two days later, with a cap of one day: the row's expiresAt is still 28 days out.
    const { auth } = setup({
      storage,
      session: { absoluteDays: 1 },
      clock: { now: () => new Date("2026-10-16T00:00:00.000Z") },
    });
    const res = await auth.handle(get("/no-such-route", `tempo_session=${s.token}`));
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("gives the moved cookie a Max-Age that never passes the absolute cap", async () => {
    const storage = createMemoryAdapter();
    const { config } = setup({ storage });
    const s = await createSession(config, { userId: "u1", ip: null, userAgent: null });
    // One day later, with a cap of ten days: expiresAt is 29 days out, the cap 9.
    const { auth } = setup({
      storage,
      session: { absoluteDays: 10 },
      clock: { now: () => new Date("2026-10-15T00:00:00.000Z") },
    });
    const res = await auth.handle(get("/no-such-route", `tempo_session=${s.token}`));
    expect(res.headers.getSetCookie()[0]).toBe(
      `__Host-tempo_session=${s.token}; Path=/; Max-Age=${9 * 86_400}; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("signs out a browser that holds the old cookie and clears both names", async () => {
    const { auth, config } = setup();
    const s = await createSession(config, { userId: "u1", ip: null, userAgent: null });
    const res = await auth.handle(
      new Request(`${BASE}/auth/sign-out`, {
        method: "POST",
        headers: { cookie: `tempo_session=${s.token}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.headers.getSetCookie()).toEqual([
      "__Host-tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(await resolveSession(config, s.token)).toBeNull();
  });

  it("signs out both sessions when the two names hold different tokens", async () => {
    const { auth, config } = setup();
    for (const id of ["u1", "u2"])
      await config.storage.create("user", {
        id,
        email: `${id}@example.com`,
        emailVerified: true,
        name: null,
        image: null,
        createdAt: new Date("2026-10-14T00:00:00.000Z"),
        updatedAt: new Date("2026-10-14T00:00:00.000Z"),
      });
    const fresh = await createSession(config, { userId: "u1", ip: null, userAgent: null });
    // An old session of the same browser, or one a sibling subdomain planted.
    const old = await createSession(config, { userId: "u2", ip: null, userAgent: null });
    // Both live before the sign-out, so the checks after it can fail.
    expect(await resolveSession(config, fresh.token)).not.toBeNull();
    expect(await resolveSession(config, old.token)).not.toBeNull();
    const res = await auth.handle(
      new Request(`${BASE}/auth/sign-out`, {
        method: "POST",
        headers: {
          cookie: `__Host-tempo_session=${fresh.token}; tempo_session=${old.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      "__Host-tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(await resolveSession(config, fresh.token)).toBeNull();
    expect(await resolveSession(config, old.token)).toBeNull();
    // The next request with the old cookie alone signs in as nobody.
    const next = await auth.handle(get("/session", `tempo_session=${old.token}`));
    expect(next.status).toBe(401);
  });

  it("reads no old cookie for an app that names its own cookie", async () => {
    const { auth, config } = setup({ cookieName: "sid" });
    expect(config.legacyCookieName).toBeNull();
    const s = await createSession(config, { userId: "u1", ip: null, userAgent: null });
    const res = await auth.handle(get("/session", `tempo_session=${s.token}`));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("moves the old cookie for an app that names __Host-tempo_session itself", () => {
    expect(setup({ cookieName: "__Host-tempo_session" }).config.legacyCookieName).toBe(
      "tempo_session",
    );
  });
});

describe("the binding cookie name (plan 12b)", () => {
  it("drops a __Host- or __Secure- prefix and takes __Secure-, so its path may be the social path", () => {
    expect(bindingCookieName("__Host-tempo_session")).toBe("__Secure-tempo_session_oauth");
    expect(bindingCookieName("__Secure-sid")).toBe("__Secure-sid_oauth");
    expect(bindingCookieName("sid")).toBe("__Secure-sid_oauth");
  });

  it("never writes a __Host- cookie with a path other than /", async () => {
    const { auth } = setup({ social: { google: { clientId: "g", clientSecret: "s" } } });
    const res = await auth.handle(new Request(`${BASE}/auth/social/google/start`, { headers: {} }));
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^__Secure-tempo_session_oauth=[^;]+; Path=\/auth\/social;/);
    for (const c of set) if (c.startsWith("__Host-")) expect(c).toContain("; Path=/;");
  });
});
