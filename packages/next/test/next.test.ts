import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { DEFAULT_COOKIE_NAME, LEGACY_COOKIE_NAME } from "@authtempo/core/credentials";
import { describe, expect, it } from "vitest";
import { authProxy, authRouteHandlers, authSession } from "../src/index.js";

const BASE = "https://app.example.com";

function makeAuth(): { auth: Auth; mail: MailMessage[] } {
  const mail: MailMessage[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
  });
  return { auth, mail };
}

async function signedIn(auth: Auth, mail: MailMessage[]) {
  const { POST } = authRouteHandlers(auth);
  const json = (path: string, body: unknown) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    });
  await POST(json("/auth/magic-link/request", { email: "ada@example.com" }));
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
  const verify = await POST(json("/auth/magic-link/verify", { token }));
  return (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("@authtempo/next (plan 11d)", () => {
  it("serves the routes of core through GET, POST, and OPTIONS", async () => {
    const { auth, mail } = makeAuth();
    const { GET, OPTIONS } = authRouteHandlers(auth);
    expect((await GET(new Request(`${BASE}/auth/session`))).status).toBe(401);
    const cookie = await signedIn(auth, mail);
    // The cookie rule (plan 12b): the name comes from core, never a literal.
    expect(cookie.startsWith(`${DEFAULT_COOKIE_NAME}=ts_`)).toBe(true);
    const me = await GET(new Request(`${BASE}/auth/session`, { headers: { cookie } }));
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("ada@example.com");
    const pre = await OPTIONS(
      new Request(`${BASE}/auth/session`, { method: "OPTIONS", headers: { origin: BASE } }),
    );
    expect(pre.status).toBe(204);
  });

  it("takes a function that makes the auth instance at the first request", async () => {
    const { auth } = makeAuth();
    let made = 0;
    const { GET } = authRouteHandlers(() => {
      made++;
      return auth;
    });
    expect(made).toBe(0);
    await GET(new Request(`${BASE}/auth/session`));
    expect(made).toBe(1);
  });

  it("reads the session of a server component from its headers", async () => {
    const { auth, mail } = makeAuth();
    expect(await authSession(auth, new Headers())).toBeNull();
    const cookie = await signedIn(auth, mail);
    const s = await authSession(() => auth, new Headers({ cookie }));
    expect(s?.user.email).toBe("ada@example.com");
  });

  it("sends a request with no session cookie on a protected path to the sign-in page, with next", async () => {
    const proxy = authProxy({ protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" });
    expect(await proxy(new Request(`${BASE}/`))).toBeUndefined();
    const out = await proxy(new Request(`${BASE}/account/billing?tab=2`));
    expect(out?.status).toBe(307);
    expect(out?.headers.get("location")).toBe(
      `${BASE}/sign-in?next=%2Faccount%2Fbilling%3Ftab%3D2`,
    );
    const withCookie = await proxy(
      new Request(`${BASE}/account`, { headers: { cookie: `${DEFAULT_COOKIE_NAME}=ts_any` } }),
    );
    expect(withCookie).toBeUndefined();
    // The name before plan 12b counts for one release, as core reads it.
    const legacy = await proxy(
      new Request(`${BASE}/account`, { headers: { cookie: `${LEGACY_COOKIE_NAME}=ts_any` } }),
    );
    expect(legacy).toBeUndefined();
    // A custom cookie name reads no old name.
    const custom = authProxy({ protect: () => true, signInPath: "/sign-in", cookieName: "app_s" });
    expect(
      (
        await custom(
          new Request(`${BASE}/account`, { headers: { cookie: `${LEGACY_COOKIE_NAME}=ts_any` } }),
        )
      )?.status,
    ).toBe(307);
  });

  it("asks core for the session when the proxy has the auth instance", async () => {
    const { auth, mail } = makeAuth();
    const cookie = await signedIn(auth, mail);
    const proxy = authProxy({ protect: () => true, signInPath: "/sign-in", auth });
    expect(await proxy(new Request(`${BASE}/account`, { headers: { cookie } }))).toBeUndefined();
    const dead = await proxy(
      new Request(`${BASE}/account`, { headers: { cookie: `${DEFAULT_COOKIE_NAME}=ts_dead` } }),
    );
    expect(dead?.status).toBe(307);
  });
});
