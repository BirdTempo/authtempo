import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { bindingCookieName, sessionCookie } from "../src/http/cookies.js";
import { sessionCookieNames } from "../src/primitives/credentials.js";
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

const USER = {
  email: "a@example.com",
  emailVerified: true,
  name: null,
  image: null,
  bannedAt: null,
  banReason: null,
  banUntil: null,
  username: null,
  displayUsername: null,
  phone: null,
  isAnonymous: false,
  createdAt: new Date("2026-10-14T00:00:00.000Z"),
  updatedAt: new Date("2026-10-14T00:00:00.000Z"),
};

/** A live session of a new user `id`. */
async function live(config: ReturnType<typeof setup>["config"], id: string) {
  await config.storage.create("user", { ...USER, id, email: `${id}@example.com` });
  return createSession(config, { userId: id, ip: null, userAgent: null, proved: true });
}

describe("the session cookie name (plan 12b)", () => {
  it("is __Host-tempo_session by default, on Path=/, Secure, HttpOnly, with no Domain", async () => {
    const { auth, config } = setup();
    expect(config.cookieName).toBe("__Host-tempo_session");
    const s = await live(config, "u2");
    const set = sessionCookie(config.cookieName, s.token, 2_592_000, config.cookie.sameSite);
    expect(set).toBe(
      `__Host-tempo_session=${s.token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(set).not.toMatch(/Domain=/i);
    // The cookie of that name is the session of the request.
    const res = await auth.handle(get("/session", `__Host-tempo_session=${s.token}`));
    expect(res.status).toBe(200);
  });
});

// Until 0.2.0 core read the old cookie `tempo_session` when a request had no
// `__Host-tempo_session`, and moved it to the new name (the register entry
// tempo-session-read). 0.2.0 removes the read. Each test holds a live session
// in the old cookie, so a read that comes back answers 200 and fails here.
describe("the old cookie tempo_session, which core reads no more", () => {
  it("answers 401 to a live token in the old cookie, and sets and clears no cookie", async () => {
    const { auth, config } = setup();
    const s = await live(config, "u1");
    const res = await auth.handle(get("/session", `tempo_session=${s.token}`));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    // The token itself is live: the same value in the new cookie is a session.
    expect((await auth.handle(get("/session", `__Host-tempo_session=${s.token}`))).status).toBe(
      200,
    );
  });

  it("gives no session and no caller in process", async () => {
    const { auth, config } = setup();
    const s = await live(config, "u3");
    const old = get("/x", `tempo_session=${s.token}`);
    expect(await auth.session(old)).toBeNull();
    expect(await auth.caller(get("/x", `tempo_session=${s.token}`))).toBeNull();
    const now = await auth.caller(get("/x", `__Host-tempo_session=${s.token}`));
    expect(now?.kind === "session" ? now.user.id : null).toBe("u3");
  });

  it("writes no cookie on a route that reads no session", async () => {
    const { auth, config } = setup();
    const s = await live(config, "u1");
    const res = await auth.handle(get("/no-such-route", `tempo_session=${s.token}`));
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("signs out by the new name only: one clear, and the old name is not a way back in", async () => {
    const { auth, config } = setup();
    const fresh = await live(config, "u1");
    const old = await live(config, "u4");
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
    ]);
    expect(await resolveSession(config, fresh.token)).toBeNull();
    // The browser sends the old cookie alone next: core signs in nobody.
    const next = await auth.handle(get("/session", `tempo_session=${old.token}`));
    expect(next.status).toBe(401);
  });

  it("has one cookie name in the resolved config, for the default and for a name of the app", () => {
    expect(Object.keys(sessionCookieNames())).toEqual(["cookieName"]);
    expect(sessionCookieNames()).toEqual({ cookieName: "__Host-tempo_session" });
    expect(sessionCookieNames("sid")).toEqual({ cookieName: "sid" });
    expect("legacyCookieName" in setup().config).toBe(false);
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
