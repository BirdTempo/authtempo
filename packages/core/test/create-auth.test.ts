import { describe, expect, it } from "vitest";
import { createAuth, createMemoryAdapter } from "../src/index.js";
import { APP_ORIGIN, BASE_URL, get, post, tokenFromMail } from "./helpers.js";

function setup() {
  const sent: { to: string; text: string }[] = [];
  let current = new Date("2026-01-01T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const auth = createAuth({
    clock,
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
  });
  return { auth, sent, clock };
}

describe("createAuth", () => {
  it("runs the full magic link round trip through handle and session", async () => {
    const { auth, sent } = setup();
    expect(
      (
        await auth.handle(
          post("/auth/magic-link/request", { email: "ada@example.com", next: "/dash" }),
        )
      ).status,
    ).toBe(200);
    const token = tokenFromMail(sent[0]?.text ?? "");
    const verify = await auth.handle(post("/auth/magic-link/verify", { token }));
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie")?.split(";")[0] ?? "";
    const me = await auth.session(get("/anything", { cookie }));
    expect(me?.user.email).toBe("ada@example.com");
    const bearer = cookie.split("=")[1] ?? "";
    expect(
      (await auth.session(get("/anything", { authorization: `Bearer ${bearer}` })))?.user.email,
    ).toBe("ada@example.com");
    expect((await auth.handle(post("/auth/sign-out", {}, { cookie }))).status).toBe(200);
    expect(await auth.session(get("/anything", { cookie }))).toBeNull();
  });

  it("exposes the same operations on api", async () => {
    const { auth, sent } = setup();
    expect(await auth.api.requestMagicLink({ email: "ada@example.com", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const r = await auth.api.verifyMagicLink({
      token: tokenFromMail(sent[0]?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!("token" in r.value)) throw new Error("the sign-in answered a challenge");
    expect((await auth.api.getSession(r.value.token))?.user.email).toBe("ada@example.com");
    await auth.api.signOut(r.value.token);
    expect(await auth.api.getSession(r.value.token)).toBeNull();
    expect(auth.errors.rate_limited).toBe(429);
  });

  it("session returns null with no credentials", async () => {
    const { auth } = setup();
    expect(await auth.session(get("/anything"))).toBeNull();
  });

  it("sessionCookie renews the cookie after a sliding refresh, for a cookie request only", async () => {
    const { auth, sent, clock } = setup();
    await auth.handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(sent[0]?.text ?? "");
    const verify = await auth.handle(post("/auth/magic-link/verify", { token }));
    const cookie = verify.headers.get("set-cookie")?.split(";")[0] ?? "";
    const withCookie = get("/anything", { cookie });
    const fresh = await auth.session(withCookie);
    expect(fresh && auth.sessionCookie(withCookie, fresh)).toBeNull();
    clock.advance(7 * 86_400_000);
    const refreshed = await auth.session(withCookie);
    expect(refreshed?.refreshed).toBe(true);
    const set = refreshed ? auth.sessionCookie(withCookie, refreshed) : null;
    expect(set).toContain(`${cookie};`);
    expect(set).toContain(`Max-Age=${30 * 86_400};`);
    const bearer = get("/anything", { authorization: `Bearer ${cookie.split("=")[1]}` });
    expect(refreshed && auth.sessionCookie(bearer, refreshed)).toBeNull();
  });

  it("mounts the social routes and exposes the social api", async () => {
    const { auth } = setup();
    expect((await auth.handle(get("/auth/social/google/start"))).status).toBe(404);
    expect(typeof auth.api.startSocial).toBe("function");
    expect(await auth.api.startSocial({ provider: "google", ip: null })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const withGoogle = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      social: { google: { clientId: "g", clientSecret: "s" } },
    });
    expect((await withGoogle.handle(get("/auth/social/google/start"))).status).toBe(302);
  });
  it("exposes the handoff api", async () => {
    const { auth } = setup();
    expect(typeof auth.api.startHandoff).toBe("function");
    expect(await auth.api.startHandoff({ challenge: "x", redirect: "y", ip: null })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});
