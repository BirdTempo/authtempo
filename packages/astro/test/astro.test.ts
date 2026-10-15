import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { authMiddleware, authRoute } from "../src/index.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const mail: MailMessage[] = [];
  const auth: Auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock: { now: () => now },
  });
  const route = authRoute(auth);
  /**
   * The two fields of APIContext that the binding reads. The real pipeline of
   * Astro runs in the example's proof; this test holds the binding's own rule.
   */
  const context = (request: Request) =>
    ({ request, url: new URL(request.url), locals: {} }) as unknown as APIContext;
  async function signIn(): Promise<string> {
    const post = (path: string, body: unknown) =>
      route(
        context(
          new Request(`${BASE}/auth${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE },
            body: JSON.stringify(body),
          }),
        ),
      );
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await post("/magic-link/verify", { token });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
  const middleware = authMiddleware({
    auth,
    protect: (p) => p.startsWith("/account"),
    signInPath: "/sign-in",
  });
  return {
    auth,
    context,
    signIn,
    middleware,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/astro (plan 11d2)", () => {
  it("serves the routes of core from one endpoint", async () => {
    const { signIn } = setup();
    expect((await signIn()).startsWith("__Host-tempo_session=ts_")).toBe(true);
  });

  it("puts the session in locals, and runs the page", async () => {
    const { signIn, context, middleware } = setup();
    const cookie = await signIn();
    const ctx = context(new Request(`${BASE}/`, { headers: { cookie } }));
    const res = await middleware(ctx, async () => new Response("page"));
    expect(await (res as Response).text()).toBe("page");
    expect(ctx.locals.session?.user.email).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { context, middleware } = setup();
    let ran = false;
    const res = (await middleware(context(new Request(`${BASE}/account`)), async () => {
      ran = true;
      return new Response("page");
    })) as Response;
    expect(ran).toBe(false);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { signIn, context, middleware, advance } = setup();
    const cookie = await signIn();
    advance(8 * DAY);
    const res = (await middleware(
      context(new Request(`${BASE}/account`, { headers: { cookie } })),
      async () => new Response("page"),
    )) as Response;
    expect(res.headers.getSetCookie().some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(
      true,
    );
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = setup();
    expect(() => authMiddleware({ auth, protect: () => true })).toThrow(/signInPath/);
  });
});
