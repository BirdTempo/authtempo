import { describe, expect, it } from "vitest";
import { call, type Harness, harness, linkIn, sessionCookieOf } from "../support/harness.ts";
import { createMultiSessionAuth } from "./multi-session.ts";

type Auth = ReturnType<typeof createMultiSessionAuth>;

/** A cookie jar of one browser: each Set-Cookie replaces or clears its name. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    // The bag cookie holds its tokens joined by dots.
    values: () => [...cookies.values()].flatMap((v) => v.split(".")),
    take(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const at = pair.indexOf("=");
        const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
        if (value === "" || /max-age=0/i.test(line)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
  };
}

/** A magic link sign-in in the browser of the jar. */
async function signIn(auth: Auth, h: Harness, browser: ReturnType<typeof jar>, email: string) {
  await call(auth, "POST", "/auth/magic-link/request", { email });
  const token = linkIn(h, email).searchParams.get("token") ?? "";
  const res = await call(
    auth,
    "POST",
    "/auth/magic-link/verify",
    { token },
    {
      cookie: browser.header(),
    },
  );
  browser.take(res);
}

describe("multi-session", () => {
  it("keeps two users in one browser, and answers no token", async () => {
    const h = harness();
    const auth = createMultiSessionAuth(h);
    const browser = jar();
    await signIn(auth, h, browser, "ada@example.com");
    await signIn(auth, h, browser, "bo@example.com");
    expect(browser.header()).toContain("__Host-tempo_sessions=");

    const res = await call(auth, "GET", "/auth/multi-session", undefined, {
      cookie: browser.header(),
    });
    const text = await res.text();
    const { sessions } = JSON.parse(text) as {
      sessions: { sessionId: string; active: boolean; user: { email: string } }[];
    };
    expect(sessions.map((s) => [s.user.email, s.active])).toEqual([
      ["bo@example.com", true],
      ["ada@example.com", false],
    ]);
    // The tokens stay in the HttpOnly cookies.
    for (const value of browser.values()) expect(text).not.toContain(value);

    const other = sessions.find((s) => !s.active)?.sessionId;
    const switched = await call(
      auth,
      "POST",
      "/auth/multi-session/switch",
      { sessionId: other },
      {
        cookie: browser.header(),
      },
    );
    expect(switched.status).toBe(200);
  });

  it("answers 401 to a bearer client: it has no bag", async () => {
    const h = harness();
    const auth = createMultiSessionAuth(h);
    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" });
    const link = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const verified = await call(auth, "POST", "/auth/magic-link/verify", { token: link });
    // A native app keeps the token of the answer and sends it as a bearer token.
    // The Bearer scheme refuses the request, also with the session cookie beside it.
    const { token } = (await verified.json()) as { token: string };
    const res = await call(auth, "GET", "/auth/multi-session", undefined, {
      authorization: `Bearer ${token}`,
      cookie: sessionCookieOf(verified),
    });
    expect(res.status).toBe(401);
  });
});
