import { describe, expect, it } from "vitest";
import { createHandoff } from "../src/handoff.js";
import { BASE_URL, makeServer, scriptedOpener } from "./harness.js";

const REDIRECT = "consumera://auth";

describe("createHandoff", () => {
  it("signs in through the browser and redeems a bearer session; a second sign-in uses a fresh pair", async () => {
    const server = makeServer();
    const opener = scriptedOpener(server);
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener,
      fetch: server.fetch,
    });
    const r = await handoff.signIn();
    expect(r.ok && r.value.user.email).toBe("ada@example.com");
    expect(r.ok && r.value.token).toMatch(/^ts_/);
    const first = opener.opened[0] ?? "";
    expect(first).toMatch(
      new RegExp(
        `^${BASE_URL}/auth/handoff/start\\?challenge=[A-Za-z0-9_-]{43}&redirect=consumera%3A%2F%2Fauth$`,
      ),
    );
    const r2 = await handoff.signIn();
    expect(r2.ok).toBe(true);
    expect(opener.opened[1]).not.toBe(first);
    expect(r2.ok && r2.value.token).not.toBe(r.ok && r.value.token);
    // Each sign-in leaves two sessions: the browser's cookie session and the app's bearer session.
    const sessions = await server.storage.findMany("session", []);
    expect(sessions).toHaveLength(4);
  });

  it("answers cancelled when the opener returns null, and makes no redeem call", async () => {
    const server = makeServer();
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init).url);
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: { open: async () => null },
      fetch,
    });
    expect(await handoff.signIn()).toEqual({ ok: false, code: "cancelled", status: 0 });
    expect(calls).toEqual([]);
  });

  it("answers redirect_mismatch for a URL off the redirect, and makes no redeem call (Review Focus 3)", async () => {
    const server = makeServer();
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init).url);
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    for (const returned of [
      "consumera://evil?code=hc_1",
      "consumera://auth.example?code=hc_1",
      "https://evil.example/?code=hc_1",
    ]) {
      const handoff = createHandoff({
        baseURL: BASE_URL,
        redirect: REDIRECT,
        opener: { open: async () => returned },
        fetch,
      });
      expect(await handoff.signIn()).toEqual({ ok: false, code: "redirect_mismatch", status: 0 });
    }
    expect(calls).toEqual([]);
  });

  it("answers unexpected when the redirect carries no code", async () => {
    const server = makeServer();
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: { open: async () => REDIRECT },
      fetch: server.fetch,
    });
    expect(await handoff.signIn()).toEqual({ ok: false, code: "unexpected", status: 0 });
  });

  it("passes the server's answer through: a tampered code is invalid_token, a late redeem is token_expired (Review Focus 4)", async () => {
    const server = makeServer();
    const real = scriptedOpener(server);
    const tampered = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: { open: async (url, redirect) => `${await real.open(url, redirect)}x` },
      fetch: server.fetch,
    });
    expect(await tampered.signIn()).toEqual({ ok: false, code: "invalid_token", status: 400 });
    let slow = true;
    const late = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: {
        open: async (url, redirect) => {
          const location = await real.open(url, redirect);
          if (slow) server.clock.advance(3 * 60_000);
          slow = false;
          return location;
        },
      },
      fetch: server.fetch,
    });
    expect(await late.signIn()).toEqual({ ok: false, code: "token_expired", status: 400 });
    expect((await late.signIn()).ok).toBe(true);
  });

  it("works with a dev redirect that has its own query", async () => {
    const server = makeServer();
    const redirect = "http://127.0.0.1:5000/auth?x=1";
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect,
      opener: scriptedOpener(server),
      fetch: server.fetch,
    });
    const r = await handoff.signIn();
    expect(r.ok).toBe(true);
  });

  it("answers network when the redeem fetch rejects", async () => {
    const server = makeServer();
    const real = scriptedOpener(server);
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: real,
      fetch: (async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
    });
    expect(await handoff.signIn()).toEqual({ ok: false, code: "network", status: 0 });
  });
});
