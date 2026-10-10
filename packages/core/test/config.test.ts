import { describe, expect, it } from "vitest";
import { isAppScheme, resolveConfig } from "../src/config.js";
import { defaultConfirmPage } from "../src/http/confirm-page.js";
import { defaultResetPage } from "../src/http/password-pages.js";
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
  it("defaults appName to the host of baseURL and accepts a set one", () => {
    expect(resolveConfig(base).appName).toBe("api.example.com");
    expect(resolveConfig({ ...base, appName: "Acme" }).appName).toBe("Acme");
    // URL.host keeps a port that is not the default for the scheme.
    expect(resolveConfig({ ...base, baseURL: "https://api.example.com:8443" }).appName).toBe(
      "api.example.com:8443",
    );
  });
  it("rejects an empty, long, or control-character appName", () => {
    // U+0000 and U+007F are the two edges of the refused set.
    for (const appName of ["", "a".repeat(81), "A\nB", "A\u0000B", "A\u007fB"]) {
      expect(() => resolveConfig({ ...base, appName })).toThrow(/appName/);
    }
    expect(resolveConfig({ ...base, appName: "a".repeat(80) }).appName).toHaveLength(80);
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
    expect(custom.magicLink.confirmPage({ action: "/x", token: "t", appName: "App" })).toBe(
      "<p>/x|t</p>",
    );
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

describe("passkey config", () => {
  it("is null by default and the simplewebauthn seam is the default webauthn", () => {
    const c = resolveConfig(base);
    expect(c.passkey).toBeNull();
    expect(typeof c.webauthn.verifyRegistration).toBe("function");
  });
  it("accepts origins whose host is the rpID or a subdomain of it", () => {
    const c = resolveConfig({
      ...base,
      trustedOrigins: ["https://example.com", "https://app.example.com:8443"],
      passkey: {
        rpID: "example.com",
        rpName: "Example",
        origins: ["https://example.com", "https://app.example.com:8443"],
      },
    });
    expect(c.passkey).toEqual({
      rpID: "example.com",
      rpName: "Example",
      origins: ["https://example.com", "https://app.example.com:8443"],
    });
  });
  it("accepts the baseURL or a trusted origin and refuses any other passkey origin", () => {
    const pk = { rpID: "example.com", rpName: "Example" };
    expect(() =>
      resolveConfig({ ...base, passkey: { ...pk, origins: ["https://api.example.com"] } }),
    ).not.toThrow();
    expect(() =>
      resolveConfig({ ...base, passkey: { ...pk, origins: ["https://app.example.com"] } }),
    ).not.toThrow();
    expect(() =>
      resolveConfig({ ...base, passkey: { ...pk, origins: ["https://other.example.com"] } }),
    ).toThrow(/trustedOrigins/);
  });
  it("refuses an origin outside the rpID, an origin with a path, an empty list, and an empty rpID", () => {
    const good = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
    expect(() =>
      resolveConfig({ ...base, passkey: { ...good, origins: ["https://evil.example"] } }),
    ).toThrow(/passkey.origins/);
    expect(() =>
      resolveConfig({ ...base, passkey: { ...good, origins: ["https://app.example.com/"] } }),
    ).toThrow(/passkey.origins/);
    expect(() => resolveConfig({ ...base, passkey: { ...good, origins: [] } })).toThrow(
      /passkey.origins/,
    );
    expect(() => resolveConfig({ ...base, passkey: { ...good, rpID: "" } })).toThrow(
      /passkey.rpID/,
    );
    expect(() =>
      resolveConfig({ ...base, passkey: { ...good, origins: ["https://notexample.com"] } }),
    ).toThrow(/passkey.origins/);
  });
});

describe("appURL, cookie, handoff config", () => {
  it("defaults appURL to baseURL, sameSite to Lax, and handoff to null", () => {
    const c = resolveConfig(base);
    expect(c.appURL).toBe("https://api.example.com");
    expect(c.cookie).toEqual({ sameSite: "Lax" });
    expect(c.handoff).toBeNull();
  });
  it("accepts appURL when it is baseURL or a trusted origin, and refuses others", () => {
    expect(resolveConfig({ ...base, appURL: "https://app.example.com" }).appURL).toBe(
      "https://app.example.com",
    );
    expect(() => resolveConfig({ ...base, appURL: "https://other.example" })).toThrow(/appURL/);
    expect(() => resolveConfig({ ...base, appURL: "https://app.example.com/" })).toThrow(/appURL/);
  });
  it("accepts sameSite None and refuses another value", () => {
    expect(resolveConfig({ ...base, cookie: { sameSite: "None" } }).cookie.sameSite).toBe("None");
    expect(() => resolveConfig({ ...base, cookie: { sameSite: "Strict" as "Lax" } })).toThrow(
      /sameSite/,
    );
  });
  it("validates handoff schemes and keeps the dev pattern", () => {
    const c = resolveConfig({
      ...base,
      handoff: {
        schemes: ["consumera://", "com.example.app://"],
        devRedirectPattern: /^exp:\/\/[\d.]+:\d+\/--\/auth$/,
      },
    });
    expect(c.handoff?.schemes).toEqual(["consumera://", "com.example.app://"]);
    expect(c.handoff?.devRedirectPattern?.test("exp://192.168.1.5:8081/--/auth")).toBe(true);
    expect(typeof c.handoff?.signInPage).toBe("function");
    expect(() => resolveConfig({ ...base, handoff: { schemes: [] } })).toThrow(/handoff.schemes/);
    // A g or y regex keeps state between test calls and alternates its answer.
    for (const devRedirectPattern of [/x/g, /x/y])
      expect(() =>
        resolveConfig({ ...base, handoff: { schemes: ["consumera://"], devRedirectPattern } }),
      ).toThrow(/devRedirectPattern/);
    expect(() => resolveConfig({ ...base, handoff: { schemes: ["https://"] } })).toThrow(
      /handoff.schemes/,
    );
    expect(() => resolveConfig({ ...base, handoff: { schemes: ["consumera"] } })).toThrow(
      /handoff.schemes/,
    );
    expect(() => resolveConfig({ ...base, handoff: { schemes: ["Notes Mine://"] } })).toThrow(
      /handoff.schemes/,
    );
  });
  it("names an app scheme with isAppScheme, the one copy of the rule (plan 9)", () => {
    expect(["reception://", "com.example.app://", "a+b.c-d://"].map(isAppScheme)).toEqual([
      true,
      true,
      true,
    ]);
    const refused = [
      "http://",
      "https://",
      "Reception://",
      "reception:",
      "https://app.example.com",
    ];
    expect(refused.map(isAppScheme)).toEqual([false, false, false, false, false]);
    expect(() => resolveConfig({ ...base, handoff: { schemes: ["http://"] } })).toThrow(
      "handoff.schemes must not hold http://",
    );
  });
});

describe("password config (plan 8)", () => {
  it("is off when absent, and on with the defaults for {}", () => {
    expect(resolveConfig(base).password).toBeNull();
    const p = resolveConfig({ ...base, password: {} }).password;
    expect(p).toMatchObject({ minLength: 8, resetTtlMinutes: 15, breachCheck: null });
    expect(p?.resetPage).toBe(defaultResetPage);
    expect(typeof p?.hash.verify).toBe("function");
  });

  it("refuses a minLength outside 8 to 128 and a resetTtlMinutes outside 1 to 1440", () => {
    for (const minLength of [7, 129, 8.5]) {
      expect(() => resolveConfig({ ...base, password: { minLength } })).toThrow(
        /password.minLength/,
      );
    }
    for (const resetTtlMinutes of [0, 1441, 2.5]) {
      expect(() => resolveConfig({ ...base, password: { resetTtlMinutes } })).toThrow(
        /password.resetTtlMinutes/,
      );
    }
  });
});
