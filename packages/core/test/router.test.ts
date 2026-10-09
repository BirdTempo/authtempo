import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { json } from "../src/http/json.js";
import { createRouter, type Route } from "../src/http/router.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

const config = resolveConfig({
  baseURL: "https://api.example.com",
  secret: "0123456789abcdef0123456789abcdef",
  trustedOrigins: ["https://app.example.com", "consumera://"],
  storage: createMemoryAdapter(),
  mail: { send: async () => {} },
});

const routes: Route[] = [
  {
    method: "GET",
    path: "/ping",
    handler: async (ctx) => json({ ip: ctx.ip, path: ctx.url.pathname }),
  },
  { method: "POST", path: "/echo", handler: async () => json({ echoed: true }) },
];
const handle = createRouter(config, routes);

describe("router", () => {
  it("matches method and path under basePath", async () => {
    const res = await handle(
      new Request("https://api.example.com/auth/ping", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ip: "1.2.3.4", path: "/auth/ping" });
  });
  it("404s an unknown path and a wrong method", async () => {
    expect((await handle(new Request("https://api.example.com/auth/nope"))).status).toBe(404);
    expect(
      (await handle(new Request("https://api.example.com/auth/ping", { method: "POST" }))).status,
    ).toBe(404);
    expect((await handle(new Request("https://api.example.com/other/ping"))).status).toBe(404);
  });
  it("allows a POST with no Origin, a trusted Origin, and an app scheme", async () => {
    const noOrigin = await handle(
      new Request("https://api.example.com/auth/echo", { method: "POST" }),
    );
    expect(noOrigin.status).toBe(200);
    const trusted = await handle(
      new Request("https://api.example.com/auth/echo", {
        method: "POST",
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect(trusted.status).toBe(200);
    const scheme = await handle(
      new Request("https://api.example.com/auth/echo", {
        method: "POST",
        headers: { origin: "consumera://" },
      }),
    );
    expect(scheme.status).toBe(200);
  });
  it("403s a POST with an untrusted Origin, and the baseURL itself is trusted", async () => {
    const bad = await handle(
      new Request("https://api.example.com/auth/echo", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ error: "origin_not_trusted" });
    const self = await handle(
      new Request("https://api.example.com/auth/echo", {
        method: "POST",
        headers: { origin: "https://api.example.com" },
      }),
    );
    expect(self.status).toBe(200);
  });
  it("reads the ip from cf-connecting-ip only", async () => {
    const xff = await handle(
      new Request("https://api.example.com/auth/ping", {
        headers: { "x-forwarded-for": "5.5.5.5" },
      }),
    );
    expect(await xff.json()).toEqual({ ip: null, path: "/auth/ping" });
    const cf = await handle(
      new Request("https://api.example.com/auth/ping", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );
    expect(await cf.json()).toEqual({ ip: "1.2.3.4", path: "/auth/ping" });
  });
  it("reads the ip from a custom clientIp", async () => {
    const custom = createRouter(
      resolveConfig({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: createMemoryAdapter(),
        mail: { send: async () => {} },
        clientIp: (r) => r.headers.get("x-real-ip"),
      }),
      routes,
    );
    const res = await custom(
      new Request("https://api.example.com/auth/ping", {
        headers: { "x-real-ip": "9.9.9.9", "cf-connecting-ip": "1.2.3.4" },
      }),
    );
    expect(await res.json()).toEqual({ ip: "9.9.9.9", path: "/auth/ping" });
  });
  it("403s a POST with the literal Origin null", async () => {
    const res = await handle(
      new Request("https://api.example.com/auth/echo", {
        method: "POST",
        headers: { origin: "null" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin_not_trusted" });
  });
  it("turns a thrown error into a 500 without the message", async () => {
    const boom = createRouter(config, [
      {
        method: "GET",
        path: "/boom",
        handler: async () => {
          throw new Error("secret detail");
        },
      },
    ]);
    const res = await boom(new Request("https://api.example.com/auth/boom"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret detail");
  });

  it("skips the Origin check only on a route that allows a cross-site form", async () => {
    const r = createRouter(config, [
      {
        method: "POST",
        path: "/apple",
        allowCrossSiteForm: true,
        handler: async () => json({ ok: 1 }),
      },
      { method: "POST", path: "/plain", handler: async () => json({ ok: 1 }) },
    ]);
    const foreign = { method: "POST", headers: { origin: "https://appleid.apple.com" } };
    expect((await r(new Request("https://api.example.com/auth/apple", foreign))).status).toBe(200);
    expect((await r(new Request("https://api.example.com/auth/plain", foreign))).status).toBe(403);
  });
  it("answers a preflight from a trusted origin and marks its responses (CORS)", async () => {
    const pre = await handle(
      new Request("https://api.example.com/auth/echo", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type, authorization");
    expect(pre.headers.get("access-control-max-age")).toBe("600");
    expect(pre.headers.get("vary")).toBe("Origin");
    const res = await handle(
      new Request("https://api.example.com/auth/ping", {
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toBe("Origin");
    const missing = await handle(
      new Request("https://api.example.com/auth/nope", {
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });
  it("refuses a preflight from an untrusted origin and marks nothing for it (Review Focus 1)", async () => {
    const pre = await handle(
      new Request("https://api.example.com/auth/echo", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      }),
    );
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const res = await handle(
      new Request("https://api.example.com/auth/ping", {
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    const noOrigin = await handle(new Request("https://api.example.com/auth/ping"));
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
    const noOriginPre = await handle(
      new Request("https://api.example.com/auth/ping", { method: "OPTIONS" }),
    );
    expect(noOriginPre.status).toBe(403);
  });
  it("marks the baseURL origin and an app scheme as trusted for CORS", async () => {
    const self = await handle(
      new Request("https://api.example.com/auth/ping", {
        headers: { origin: "https://api.example.com" },
      }),
    );
    expect(self.headers.get("access-control-allow-origin")).toBe("https://api.example.com");
    const scheme = await handle(
      new Request("https://api.example.com/auth/ping", { headers: { origin: "consumera://" } }),
    );
    expect(scheme.headers.get("access-control-allow-origin")).toBe("consumera://");
  });
});
