import { createAuth } from "@authtempo/core";
import { DEFAULT_COOKIE_NAME } from "@authtempo/core/credentials";
import { describe, expect, it } from "vitest";
import { API, call, harness, signIn } from "../support/harness.ts";
import { createFilesServer } from "./verify-caller.ts";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function setup(wrap: (inner: Fetch) => Fetch = (inner) => inner) {
  const h = harness();
  const auth = createAuth({
    baseURL: API,
    trustedOrigins: [],
    secret: h.secret,
    storage: h.storage,
    mail: h.mail,
    jwtMint: { audience: "https://files.example.com" },
  });
  // The files server reads the key set and the live check of the API in process.
  const files = createFilesServer(wrap((input, init) => auth.handle(new Request(input, init))));
  const at = (bearer?: string) =>
    files.fetch(
      new Request("https://files.example.com/doc", {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      }),
    );
  return { h, auth, at };
}

async function sessionJwt(auth: ReturnType<typeof setup>["auth"], cookie: string): Promise<string> {
  const res = await call(auth, "GET", "/auth/token", undefined, { cookie });
  return ((await res.json()) as { token: string }).token;
}

describe("verify a caller on another server", () => {
  it("knows the person of a session JWT and of an API token, and refuses no credential", async () => {
    const { h, auth, at } = setup();
    const cookie = await signIn(auth, h, "ada@example.com");
    expect(await (await at(await sessionJwt(auth, cookie))).json()).toEqual({
      owner: "ada@example.com",
    });
    const created = (await (
      await call(auth, "POST", "/auth/tokens", { name: "ci" }, { cookie })
    ).json()) as { token: string };
    expect(await (await at(created.token)).json()).toEqual({ owner: "ada@example.com" });
    const none = await at();
    expect(none.status).toBe(401);
  });

  it("refuses a session JWT after the sign-out", async () => {
    const { h, auth, at } = setup();
    const cookie = await signIn(auth, h, "ada@example.com");
    const jwt = await sessionJwt(auth, cookie);
    await call(auth, "POST", "/auth/sign-out", {}, { cookie });
    const refused = await at(jwt);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("names invalid_token only for a bearer with no session cookie", async () => {
    const { at } = setup();
    const files = createFilesServer();
    const challenge = async (headers: Record<string, string>) =>
      (await files.fetch(new Request("https://files.example.com/doc", { headers }))).headers.get(
        "www-authenticate",
      );
    // A bearer that the verifier refuses: no call reaches the auth app for a bad shape.
    expect((await at("nope")).headers.get("www-authenticate")).toContain('error="invalid_token"');
    // Basic is no bearer, and a cookie beside the bearer is a browser: neither is named invalid.
    expect(await challenge({ authorization: "Basic YTpi" })).toBe("Bearer");
    expect(
      await challenge({ authorization: "Bearer nope", cookie: `${DEFAULT_COOKIE_NAME}=ts_x` }),
    ).toBe("Bearer");
  });

  it("answers 429 when the live check is over its limit, and 503 when the auth app does not answer", async () => {
    let live: "limited" | "down" = "limited";
    const { h, auth, at } = setup((inner) => async (input, init) => {
      if (!String(input instanceof Request ? input.url : input).endsWith("/token/live"))
        return inner(input, init);
      if (live === "down") throw new TypeError("fetch failed");
      return Response.json({ error: "rate_limited" }, { status: 429 });
    });
    const jwt = await sessionJwt(auth, await signIn(auth, h, "ada@example.com"));
    expect((await at(jwt)).status).toBe(429);
    live = "down";
    expect((await at(jwt)).status).toBe(503);
  });
});
