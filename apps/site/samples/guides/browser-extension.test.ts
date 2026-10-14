import { describe, expect, it, vi } from "vitest";
import { call, codeIn, harness } from "../support/harness.ts";
import { createExtensionAuth, EXTENSION_ORIGIN } from "./browser-extension.ts";
import {
  createExtensionClient,
  signInByCode,
  signOut,
  type TokenBox,
} from "./browser-extension-client.ts";

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

/** The extension's fetch: the browser sends the extension's origin. */
function extensionFetch(auth: ReturnType<typeof createExtensionAuth>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("origin", EXTENSION_ORIGIN);
    return auth.handle(new Request(req, { headers }));
  }) as typeof globalThis.fetch;
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
    // The sign-out helper clears the box itself, with no later read.
    expect(await signOut(client, box)).toEqual({ ok: true, value: { ok: true } });
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
    // Token mode keeps the default: the API's cookie stays SameSite=Lax for every other site.
    const t = harness();
    const tokenAuth = createExtensionAuth(t);
    await call(
      tokenAuth,
      "POST",
      "/auth/otp/request",
      { email: "ada@example.com" },
      {
        origin: EXTENSION_ORIGIN,
      },
    );
    const tokenRes = await call(
      tokenAuth,
      "POST",
      "/auth/otp/verify",
      { email: "ada@example.com", code: codeIn(t, "ada@example.com") },
      { origin: EXTENSION_ORIGIN },
    );
    expect(tokenRes.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("shows the person in a subscribed store after the sign-in", async () => {
    const h = harness();
    const box = memoryBox();
    const client = createExtensionClient(box, extensionFetch(createExtensionAuth(h)));
    // A popup renders from client.store: it subscribes before the sign-in.
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().isPending).toBe(false));
    await signInByCode(client, box, "ada@example.com", async () => codeIn(h, "ada@example.com"));
    await vi.waitFor(() => expect(client.store.get().data?.user.email).toBe("ada@example.com"));
    stop();
  });

  it("keeps a newer token when the session read of an older token ends", async () => {
    const h = harness();
    const auth = createExtensionAuth(h);
    const box = memoryBox();
    let during: (() => Promise<void>) | null = null;
    const base = extensionFetch(auth);
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await base(input, init);
      // A newer sign-in writes its token while the read of the older token is on its way back.
      if (during && new URL(new Request(input, init).url).pathname.endsWith("/session"))
        await during();
      return res;
    }) as typeof globalThis.fetch;
    const client = createExtensionClient(box, fetch);
    await signInByCode(client, box, "ada@example.com", async () => codeIn(h, "ada@example.com"));
    // The server ends the older session.
    for (const row of await h.storage.findMany("session", []))
      await h.storage.delete("session", [{ field: "id", op: "eq", value: row.id }]);
    during = () => box.set("ts_newer");
    expect(await client.session()).toEqual({ ok: true, value: null });
    expect(box.value()).toBe("ts_newer");
  });
});
