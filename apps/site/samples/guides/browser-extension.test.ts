import { describe, expect, it } from "vitest";
import { call, codeIn, harness } from "../support/harness.ts";
import { createExtensionAuth, EXTENSION_ORIGIN } from "./browser-extension.ts";
import { createExtensionClient, signInByCode, type TokenBox } from "./browser-extension-client.ts";

function memoryBox(): TokenBox & { value(): string | null } {
  let token: string | null = null;
  return {
    get: async () => token,
    set: async (t) => {
      token = t;
    },
    clear: async () => {
      token = null;
    },
    value: () => token,
  };
}

describe("sign in from a browser extension", () => {
  it("signs in by email code in token mode: the bearer, no cookie, and the sign-out clears the token", async () => {
    const h = harness();
    const auth = createExtensionAuth(h);
    const seen: {
      credentials: RequestCredentials;
      cookie: string | null;
      authorization: string | null;
    }[] = [];
    // The extension's fetch: the browser sends the extension's origin.
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("origin", EXTENSION_ORIGIN);
      seen.push({
        credentials: req.credentials,
        cookie: headers.get("cookie"),
        authorization: headers.get("authorization"),
      });
      return auth.handle(new Request(req, { headers }));
    }) as typeof globalThis.fetch;
    const box = memoryBox();
    const client = createExtensionClient(box, fetch);
    const r = await signInByCode(client, box, "ada@example.com", async () =>
      codeIn(h, "ada@example.com"),
    );
    expect(r.ok).toBe(true);
    expect(box.value()).toMatch(/^ts_/);
    const s = await client.session();
    expect(s.ok && s.value?.user.email).toBe("ada@example.com");
    expect(seen.at(-1)).toEqual({
      credentials: "omit",
      cookie: null,
      authorization: `Bearer ${box.value()}`,
    });
    await client.signOut();
    expect((await client.session()).ok).toBe(true);
    expect(box.value()).toBeNull();
  });

  it("answers the extension's preflight, and refuses an origin of another extension", async () => {
    const auth = createExtensionAuth(harness());
    const ok = await call(auth, "OPTIONS", "/auth/session", undefined, {
      origin: EXTENSION_ORIGIN,
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    // Firefox: a random UUID per browser instance, which trustedOrigins cannot name.
    const firefox = await call(
      auth,
      "POST",
      "/auth/otp/request",
      { email: "a@example.com" },
      {
        origin: "moz-extension://944cfddf-7a95-3c47-bd9a-663b3ce8d699",
      },
    );
    expect(firefox.status).toBe(403);
    expect(await firefox.json()).toEqual({ error: "origin_not_trusted" });
  });

  it("sets a SameSite=None cookie in cookie mode", async () => {
    const h = harness();
    const auth = createExtensionAuth(h, "cookie");
    await call(
      auth,
      "POST",
      "/auth/otp/request",
      { email: "ada@example.com" },
      { origin: EXTENSION_ORIGIN },
    );
    const res = await call(
      auth,
      "POST",
      "/auth/otp/verify",
      { email: "ada@example.com", code: codeIn(h, "ada@example.com") },
      { origin: EXTENSION_ORIGIN },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("SameSite=None");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
