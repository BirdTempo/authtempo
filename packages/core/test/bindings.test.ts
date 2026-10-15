import { describe, expect, it } from "vitest";
import {
  checkGateOptions,
  DEFAULT_BASE_PATH,
  isAuthPath,
  readGate,
  signInRedirect,
  withSetCookie,
} from "../src/bindings.js";
import type { MailMessage } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { DEFAULT_COOKIE_NAME } from "../src/credentials.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;

function setup(basePath?: string) {
  const base = basePath ?? "/auth";
  let now = new Date("2026-01-01T00:00:00.000Z");
  const mail: MailMessage[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    ...(basePath ? { basePath } : {}),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock: { now: () => now },
  });
  async function signIn(): Promise<string> {
    const post = (path: string, body: unknown) =>
      auth.handle(
        new Request(`${BASE}${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify(body),
        }),
      );
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await post("/magic-link/verify", { token });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
  return { auth, signIn, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const page = (path: string, cookie = "") =>
  new Request(`${BASE}${path}`, cookie ? { headers: { cookie } } : {});

describe("the gate of the server bindings (plan 11d2)", () => {
  it("knows the paths of core under the base path, and no other", () => {
    expect(DEFAULT_BASE_PATH).toBe("/auth");
    expect(isAuthPath("/auth/session")).toBe(true);
    expect(isAuthPath("/auth")).toBe(false);
    expect(isAuthPath("/authors")).toBe(false);
    expect(isAuthPath("/api/auth/session", "/api/auth")).toBe(true);
  });

  it("refuses protect without signInPath at construction", () => {
    expect(() => checkGateOptions({ protect: () => true })).toThrow(/signInPath/);
    expect(() => checkGateOptions({ signInPath: "sign-in" })).toThrow(/signInPath/);
    expect(() => checkGateOptions({})).not.toThrow();
  });

  it("refuses a signInPath of another origin and a basePath with a trailing slash", () => {
    // A browser reads "//host" and "/\host" as links to another origin.
    expect(() => checkGateOptions({ signInPath: "//evil.example/in" })).toThrow(/signInPath/);
    expect(() => checkGateOptions({ signInPath: "/\\evil.example/in" })).toThrow(/signInPath/);
    expect(() => checkGateOptions({ signInPath: "/in" })).not.toThrow();
    expect(() => checkGateOptions({ basePath: "/api/auth/" })).toThrow(/basePath/);
    expect(() => checkGateOptions({ basePath: "api/auth" })).toThrow(/basePath/);
    expect(() => checkGateOptions({ basePath: "/api/auth" })).not.toThrow();
  });

  it("answers the session of a signed-in person, and no redirect", async () => {
    const { auth, signIn } = setup();
    const cookie = await signIn();
    const g = await readGate(
      { auth, protect: () => true, signInPath: "/sign-in" },
      page("/account", cookie),
    );
    expect(g.session?.user.email).toBe("ada@example.com");
    expect(g.redirect).toBeNull();
    expect(g.cookie).toBeNull();
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { auth } = setup();
    const options = {
      auth,
      protect: (p: string) => p.startsWith("/account"),
      signInPath: "/sign-in",
    };
    const free = await readGate(options, page("/"));
    expect(free).toEqual({ session: null, redirect: null, cookie: null });
    const g = await readGate(options, page("/account/billing?tab=2"));
    expect(g.redirect?.status).toBe(307);
    expect(g.redirect?.headers.get("location")).toBe(
      `${BASE}/sign-in?next=%2Faccount%2Fbilling%3Ftab%3D2`,
    );
  });

  it("gives the renewed cookie after the sliding refresh", async () => {
    const { auth, signIn, advance } = setup();
    const cookie = await signIn();
    advance(8 * DAY);
    const g = await readGate({ auth }, page("/", cookie));
    expect(g.session?.user.email).toBe("ada@example.com");
    expect(g.cookie?.startsWith(`${DEFAULT_COOKIE_NAME}=ts_`)).toBe(true);
  });

  it("reads no session for a path of core", async () => {
    const { auth } = setup();
    let reads = 0;
    const counting = {
      ...auth,
      session: async (r: Request) => {
        reads++;
        return auth.session(r);
      },
    };
    const g = await readGate({ auth: counting }, page("/auth/session"));
    expect(g).toEqual({ session: null, redirect: null, cookie: null });
    expect(reads).toBe(0);
  });

  it("reads the base path of core from the auth object when the gate has no basePath", async () => {
    const { auth, signIn, advance } = setup("/api/auth");
    expect(auth.basePath).toBe("/api/auth");
    const cookie = await signIn();
    advance(8 * DAY);
    let reads = 0;
    const counting = {
      ...auth,
      session: async (r: Request) => {
        reads++;
        return auth.session(r);
      },
    };
    const request = page("/api/auth/session", cookie);
    const g = await readGate({ auth: counting }, request);
    expect(g).toEqual({ session: null, redirect: null, cookie: null });
    expect(reads).toBe(0);
    // The binding then answers core's own answer: the gate adds no line to it.
    const answer = await auth.handle(request);
    const lines = answer.headers.getSetCookie();
    expect(lines.length).toBe(1);
    expect(withSetCookie(answer, g.cookie)).toBe(answer);
    expect(answer.headers.getSetCookie()).toEqual(lines);
  });

  it("adds a Set-Cookie line to an answer, and copies an answer whose headers are fixed", async () => {
    expect(withSetCookie(new Response("x"), null).headers.get("set-cookie")).toBeNull();
    const open = withSetCookie(new Response("x"), "a=1");
    expect(open.headers.getSetCookie()).toEqual(["a=1"]);
    // Response.redirect answers fixed headers: an append throws, so the gate copies the answer.
    const fixed = withSetCookie(Response.redirect(`${BASE}/x`, 302), "b=2");
    expect(fixed.status).toBe(302);
    expect(fixed.headers.getSetCookie()).toEqual(["b=2"]);
    expect(signInRedirect(new URL(`${BASE}/a?b=c`), "/in").headers.get("location")).toBe(
      `${BASE}/in?next=%2Fa%3Fb%3Dc`,
    );
  });

  it("puts only a path of this origin in next, and keeps the query of the sign-in path", () => {
    // "//host/x" in next would be a link to another origin on the sign-in page.
    expect(
      signInRedirect(new URL(`${BASE}//evil.example/a?q=1`), "/in").headers.get("location"),
    ).toBe(`${BASE}/in?next=${encodeURIComponent("/evil.example/a?q=1")}`);
    expect(signInRedirect(new URL(`${BASE}/a`), "/in?lang=en").headers.get("location")).toBe(
      `${BASE}/in?lang=en&next=%2Fa`,
    );
  });
});
