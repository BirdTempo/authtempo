import { describe, expect, it } from "vitest";
import { createAuth, createMemoryAdapter } from "../src/index.js";
import { APP_ORIGIN, BASE_URL, get, post, tokenFromMail } from "./helpers.js";

function setup() {
  const sent: { to: string; text: string }[] = [];
  const auth = createAuth({
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
  return { auth, sent };
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
    const verify = await auth.handle(
      get(`/auth/magic-link/verify?token=${encodeURIComponent(token)}`),
    );
    expect(verify.status).toBe(302);
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
    expect((await auth.api.getSession(r.value.token))?.user.email).toBe("ada@example.com");
    await auth.api.signOut(r.value.token);
    expect(await auth.api.getSession(r.value.token)).toBeNull();
    expect(auth.errors.rate_limited).toBe(429);
  });

  it("session returns null with no credentials", async () => {
    const { auth } = setup();
    expect(await auth.session(get("/anything"))).toBeNull();
  });
});
