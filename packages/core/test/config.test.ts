import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { defaultConfirmPage } from "../src/http/confirm-page.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

const base = {
  baseURL: "https://api.example.com",
  secret: "0123456789abcdef0123456789abcdef",
  trustedOrigins: ["https://app.example.com"],
  storage: createMemoryAdapter(),
  mail: { send: async () => {} },
};

describe("resolveConfig", () => {
  it("fills defaults", () => {
    const c = resolveConfig(base);
    expect(c.basePath).toBe("/auth");
    expect(c.cookieName).toBe("tempo_session");
    expect(c.session).toEqual({ ttlDays: 30, slidingRefreshDays: 7 });
    expect(c.magicLink.ttlMinutes).toBe(15);
    expect(c.magicLink.linkBuilder("tok", "/x")).toBe(
      "https://api.example.com/auth/magic-link/verify?token=tok",
    );
    expect(c.magicLink.linkBuilder("a+b/c=&d", "/x")).toBe(
      "https://api.example.com/auth/magic-link/verify?token=a%2Bb%2Fc%3D%26d",
    );
  });
  it("rejects a short secret", () => {
    expect(() => resolveConfig({ ...base, secret: "short" })).toThrow(/secret/);
  });
  it("rejects a baseURL with a trailing slash or a path", () => {
    expect(() => resolveConfig({ ...base, baseURL: "https://api.example.com/" })).toThrow(
      /baseURL/,
    );
  });
  it("rejects a wildcard trusted origin", () => {
    expect(() => resolveConfig({ ...base, trustedOrigins: ["https://*.example.com"] })).toThrow(
      /trustedOrigins/,
    );
  });
});

describe("magicLink.confirmPage", () => {
  it("defaults to the core page and accepts an override", () => {
    const defaults = resolveConfig(base);
    expect(defaults.magicLink.confirmPage).toBe(defaultConfirmPage);
    const custom = resolveConfig({
      ...base,
      magicLink: { confirmPage: (i) => `<p>${i.action}|${i.token}</p>` },
    });
    expect(custom.magicLink.confirmPage({ action: "/x", token: "t" })).toBe("<p>/x|t</p>");
    expect(custom.magicLink.ttlMinutes).toBe(15);
  });
});

describe("social config", () => {
  it("has no providers and the global fetch by default, and the jose seam", () => {
    const c = resolveConfig(base);
    expect(c.social.providers).toEqual([]);
    expect(typeof c.social.fetch).toBe("function");
    expect(typeof c.jwt.verifyIdToken).toBe("function");
    expect(typeof c.jwt.signES256).toBe("function");
  });
  it("builds the configured providers in order google, apple", () => {
    const c = resolveConfig({
      ...base,
      social: {
        apple: { clientId: "com.x.web", teamId: "T", keyId: "K", privateKey: "pem" },
        google: { clientId: "g", clientSecret: "s" },
      },
    });
    expect(c.social.providers.map((p) => p.name)).toEqual(["google", "apple"]);
  });
  it("refuses a provider with an empty field", () => {
    expect(() =>
      resolveConfig({ ...base, social: { google: { clientId: "", clientSecret: "s" } } }),
    ).toThrow(/social.google.clientId/);
    expect(() =>
      resolveConfig({
        ...base,
        social: { apple: { clientId: "c", teamId: "T", keyId: "", privateKey: "pem" } },
      }),
    ).toThrow(/social.apple.keyId/);
  });
});
