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

  it("takes the basePath option of the gate over auth.basePath, for a proxy prefix", async () => {
    const { auth, signIn } = setup();
    expect(auth.basePath).toBe("/auth");
    const cookie = await signIn();
    let reads = 0;
    const counting = {
      ...auth,
      session: async (r: Request) => {
        reads++;
        return auth.session(r);
      },
    };
    const options = { auth: counting, basePath: "/api/auth" };
    // The proxy path of core's routes: the gate reads nothing and passes it on.
    const proxied = await readGate(options, page("/api/auth/session", cookie));
    expect(proxied).toEqual({ session: null, redirect: null, cookie: null });
    expect(reads).toBe(0);
    // Core's own path is a page to this gate, so the gate reads the session.
    const own = await readGate(options, page("/auth/session", cookie));
    expect(reads).toBe(1);
    expect(own.session?.user.email).toBe("ada@example.com");
  });

  it("judges the URL that the router matched, when the binding gives it", async () => {
    const { auth } = setup();
    let reads = 0;
    const counting = {
      ...auth,
      session: async (r: Request) => {
        reads++;
        return auth.session(r);
      },
    };
    const options = {
      auth: counting,
      protect: (p: string) => p === "/account",
      signInPath: "/sign-in",
    };
    // A router decodes "/%61ccount" to "/account": the gate judges the routed path.
    const g = await readGate(options, page("/%61ccount"), new URL(`${BASE}/account`));
    expect(g.session).toBeNull();
    expect(g.redirect?.status).toBe(307);
    expect(g.redirect?.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
    // A routed string is judged; next comes from the request URL, not from the string.
    const s = await readGate(options, page("/%61ccount?tab=2"), "/account?tab=2");
    expect(s.redirect?.headers.get("location")).toBe(
      `${BASE}/sign-in?next=${encodeURIComponent("/%61ccount?tab=2")}`,
    );
    // "//x" stays a path, not a host.
    const seen: string[] = [];
    const recording = { ...options, protect: (p: string) => seen.push(p) < 0 };
    await readGate(recording, page("/x"), "//account");
    expect(seen).toEqual(["//account"]);
    expect(reads).toBe(3);
  });

  it("takes only the path and the query of the routed URL, on the origin of the request", async () => {
    const { auth } = setup();
    const options = { auth, protect: () => true, signInPath: "/sign-in" };
    const where = async (url: URL | string) =>
      (await readGate(options, page("/raw"), url)).redirect?.headers.get("location");
    // A string with no leading "/" gets one, so no request throws.
    const seen: string[] = [];
    const recording = { ...options, protect: (p: string) => seen.push(p) < 0 };
    await readGate(recording, page("/raw"), "account");
    await readGate(recording, page("/raw"), "");
    expect(seen).toEqual(["/account", "/"]);
    // The origin of a routed URL object is not read: the redirect stays on the app.
    expect(await where(new URL("https://evil.example/x"))).toBe(`${BASE}/sign-in?next=%2Fx`);
    // The fragment goes; the query stays.
    expect(await where(new URL(`${BASE}/x?a=1#frag`))).toBe(`${BASE}/sign-in?next=%2Fx%3Fa%3D1`);
    // An absolute string is a path too, on the origin of the request.
    expect((await where("https://evil.example/x"))?.startsWith(`${BASE}/sign-in?next=`)).toBe(true);
  });

  // A router that matches the raw path matched "/account/:id" with id "..", or
  // "/account/*rest". No case may reach isAuthPath as "/auth/session".
  it.each([
    "/account/..",
    "/account/../auth/session",
    "/account/%2e%2e",
    "/account/%2e%2e/auth/session",
  ])("judges the routed path %s as given, with no resolution of dot segments", async (routed) => {
    const { auth } = setup();
    const seen: string[] = [];
    let reads = 0;
    const options = {
      auth: {
        ...auth,
        session: async (r: Request) => {
          reads++;
          return auth.session(r);
        },
      },
      protect: (p: string) => {
        seen.push(p);
        return p.startsWith("/account");
      },
      signInPath: "/sign-in",
    };
    const g = await readGate(options, page("/raw"), routed);
    expect(seen).toEqual([routed]);
    // The gate reads the session once to know that there is none.
    expect(reads).toBe(1);
    expect(g.redirect?.status).toBe(307);
    // next comes from the request URL: a routed string is never a next.
    expect(g.redirect?.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Fraw`);
  });

  it("gives the rule the path that the framework gave, with the query in next", async () => {
    const { auth } = setup();
    const seen: string[] = [];
    const options = {
      auth,
      protect: (p: string) => {
        seen.push(p);
        return p === "/account" || p.startsWith("/caf");
      },
      signInPath: "/sign-in",
    };
    // A string is not encoded again; a URL object keeps the pathname the framework parsed.
    const fromString = await readGate(options, page("/raw"), "/café");
    const fromURL = await readGate(options, page("/raw"), new URL(`${BASE}/caf%C3%A9`));
    // next of a string comes from the request; of a URL object, from the object.
    expect(fromString.redirect?.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Fraw`);
    expect(fromURL.redirect?.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Fcaf%25C3%25A9`);
    // The query splits at the first "?", so the rule gets "/account"; the fragment goes.
    const q = await readGate(options, page("/account?tab=2&x=?"), "/account?tab=2&x=?#frag");
    expect(q.redirect?.headers.get("location")).toBe(
      `${BASE}/sign-in?next=${encodeURIComponent("/account?tab=2&x=?")}`,
    );
    // "//account" stays "//account", with no merge of slashes.
    await readGate(options, page("/raw"), "//account");
    expect(seen).toEqual(["/café", "/caf%C3%A9", "/account", "//account"]);
  });

  it("takes next from returnTo, else from a routed URL object, else from the request", async () => {
    const { auth } = setup();
    const options = { auth, protect: () => true, signInPath: "/sign-in" };
    const at = async (raw: string, routed?: URL | string, returnTo?: URL) =>
      (await readGate(options, page(raw), routed, returnTo)).redirect?.headers.get("location");
    // A data request: the router judged "/account", the person returns to the page.
    expect(await at("/account.data", "/account", new URL(`${BASE}/account?tab=2`))).toBe(
      `${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`,
    );
    // A routed string and no returnTo: the raw request path, not the decoded text.
    expect(await at("/%2561ccount", "/%61ccount")).toBe(
      `${BASE}/sign-in?next=${encodeURIComponent("/%2561ccount")}`,
    );
    // A routed URL object and no returnTo: the object.
    expect(await at("/raw", new URL(`${BASE}/account?x=1`))).toBe(
      `${BASE}/sign-in?next=%2Faccount%3Fx%3D1`,
    );
  });

  it("gives no next that names another origin, from any source of next", async () => {
    const { auth } = setup();
    const seen: string[] = [];
    const options = {
      auth,
      protect: (p: string) => seen.push(p) > 0,
      signInPath: "/sign-in",
    };
    const at = async (raw: string, routed?: URL | string, returnTo?: URL) =>
      (await readGate(options, page(raw), routed, returnTo)).redirect?.headers.get("location");
    // Through a URL, a backslash is "/" and a tab goes: the one-slash rule then holds.
    expect(await at("/\\evil.example/a")).toBe(`${BASE}/sign-in?next=%2Fevil.example%2Fa`);
    expect(await at("/raw", new URL(`${BASE}/\t/evil.example`))).toBe(
      `${BASE}/sign-in?next=%2Fevil.example`,
    );
    // The raw path returns as itself; one router decode gives the routed path.
    expect(await at("/%5Cevil.example", "/\\evil.example")).toBe(
      `${BASE}/sign-in?next=${encodeURIComponent("/%5Cevil.example")}`,
    );
    expect(seen.at(-1)).toBe("/\\evil.example");
    // A JavaScript binding with no types can pass any object with pathname and
    // search. The safeNext rule of core's own flows then answers "/".
    const loose = (pathname: string) => ({ pathname, search: "" }) as unknown as URL;
    expect(await at("/raw", "/a", loose("/\\evil.example/a"))).toBe(`${BASE}/sign-in?next=%2F`);
    expect(await at("/raw", "/a", loose("/\t/evil.example"))).toBe(`${BASE}/sign-in?next=%2F`);
    // A lone surrogate makes encodeURIComponent throw: the gate answers next "/", not a throw.
    expect(await at("/raw", "/a", loose("/a\uD800b"))).toBe(`${BASE}/sign-in?next=%2F`);
  });

  it("judges the object form of a routed path as given, with no split at ? and no drop of #", async () => {
    const { auth } = setup();
    const seen: string[] = [];
    const options = {
      auth,
      protect: (p: string) => {
        seen.push(p);
        return p.startsWith("/a");
      },
      signInPath: "/sign-in",
    };
    // A router decoded "/a%3F/secret%23x" into the path text "/a?/secret#x".
    const routed = { pathname: "/a?/secret#x", search: "?tab=1" };
    const raw = "/a%3F/secret%23x?tab=1";
    const g = await readGate(options, page(raw), routed);
    expect(g.redirect?.status).toBe(307);
    // next comes from request.url, never from the decoded text.
    expect(g.redirect?.headers.get("location")).toBe(
      `${BASE}/sign-in?next=${encodeURIComponent(raw)}`,
    );
    const r = await readGate(options, page(raw), routed, new URL(`${BASE}/a?tab=1`));
    expect(r.redirect?.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Fa%3Ftab%3D1`);
    // The string form keeps its split: the rule gets the path before "?".
    await readGate(options, page(raw), "/a?/secret#x");
    expect(seen).toEqual(["/a?/secret#x", "/a?/secret#x", "/a"]);
  });

  it("exposes the baseURL of the config, for a binding whose Host header does not parse", () => {
    const { auth } = setup();
    expect(auth.baseURL).toBe(BASE);
  });

  it("reads no session when the raw path and the routed path are both under the base path", async () => {
    const { auth, signIn } = setup();
    const cookie = await signIn();
    let reads = 0;
    const counting = {
      ...auth,
      session: async (r: Request) => {
        reads++;
        return auth.session(r);
      },
    };
    const g = await readGate(
      { auth: counting },
      page("/auth/session", cookie),
      new URL(`${BASE}/auth/session`),
    );
    expect(g).toEqual({ session: null, redirect: null, cookie: null });
    expect(reads).toBe(0);
  });

  // Core's router reads the raw path; the app's router matched the routed one.
  // When only one form is a path of core, the request is a page to the gate.
  it.each([
    ["/%61uth/x", "a routed string", "/auth/x", () => true],
    ["/%61uth/x", "a routed URL object", new URL(`${BASE}/auth/x`), () => true],
    ["/%61uth/x", "a RoutedPath", { pathname: "/auth/x" }, () => true],
    ["/auth/x", "a routed string", "/account", (p: string) => p === "/account"],
    ["/auth/x", "a RoutedPath", { pathname: "/account" }, (p: string) => p === "/account"],
  ] as const)(
    "judges raw %s with %s as a page, because only one form is a path of core",
    async (raw, _form, routed, protect) => {
      const { auth } = setup();
      let reads = 0;
      const counting = {
        ...auth,
        session: async (r: Request) => {
          reads++;
          return auth.session(r);
        },
      };
      const g = await readGate(
        { auth: counting, protect, signInPath: "/sign-in" },
        page(raw),
        routed,
      );
      expect(reads).toBe(1);
      expect(g.redirect?.status).toBe(307);
    },
  );

  it("judges the raw request URL with two arguments, as before", async () => {
    const { auth } = setup();
    const options = { auth, protect: (p: string) => p === "/account", signInPath: "/sign-in" };
    // The raw "/%61ccount" is not "/account": the binding must give the routed URL.
    expect(await readGate(options, page("/%61ccount"))).toEqual({
      session: null,
      redirect: null,
      cookie: null,
    });
    const g = await readGate(options, page("/account?tab=2"));
    expect(g.redirect?.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`);
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
