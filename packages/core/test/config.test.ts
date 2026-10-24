import { describe, expect, it } from "vitest";
import { DEFAULT_RESERVED_SLUGS, isAppScheme, resolveConfig } from "../src/config.js";
import {
  defaultEmailOtpMail,
  defaultResetOtpMail,
  defaultSecondFactorMail,
} from "../src/engine/email-otp-mail.js";
import { defaultConfirmPage } from "../src/http/confirm-page.js";
import { defaultConsentPage } from "../src/http/consent-page.js";
import { defaultResetPage } from "../src/http/password-pages.js";
import { defaultTotpPage } from "../src/http/totp-page.js";
import type { OAuth2Entry } from "../src/social/oauth2.js";
import type { OidcEntry } from "../src/social/oidc.js";
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
    expect(c.cookieName).toBe("__Host-tempo_session");
    expect(c.legacyCookieName).toBe("tempo_session");
    expect(c.session).toEqual({
      ttlDays: 30,
      slidingRefreshDays: 7,
      absoluteDays: null,
      freshMinutes: 1440,
      deferRefresh: false,
    });
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
  it("builds the github preset after google and apple, and refuses an empty field (plan 9c)", () => {
    const c = resolveConfig({
      ...base,
      social: {
        github: { clientId: "h", clientSecret: "hs" },
        google: { clientId: "g", clientSecret: "s" },
      },
    });
    expect(c.social.providers.map((p) => [p.name, p.kind])).toEqual([
      ["google", "oidc"],
      ["github", "oauth2"],
    ]);
    expect(() =>
      resolveConfig({ ...base, social: { github: { clientId: "h", clientSecret: "" } } }),
    ).toThrow(/social\.github\.clientSecret must be a non-empty string/);
  });
  it("builds the linkedin preset after github, and refuses an empty field (plan 9c)", () => {
    const c = resolveConfig({
      ...base,
      social: {
        linkedin: { clientId: "l", clientSecret: "ls" },
        github: { clientId: "h", clientSecret: "hs" },
      },
    });
    expect(c.social.providers.map((p) => [p.name, p.kind])).toEqual([
      ["github", "oauth2"],
      ["linkedin", "oauth2"],
    ]);
    expect(() =>
      resolveConfig({ ...base, social: { linkedin: { clientId: "", clientSecret: "ls" } } }),
    ).toThrow(/social\.linkedin\.clientId must be a non-empty string/);
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

describe("social.oauth2 (plan 9c)", () => {
  const userinfo = async () => ({
    subject: "s",
    email: null,
    emailVerified: false,
    name: null,
    image: null,
  });
  const entry = (over: Partial<OAuth2Entry> = {}): OAuth2Entry => ({
    name: "acme",
    label: "Continue with Acme",
    authorizeUrl: "https://id.acme.example/authorize",
    tokenUrl: "https://id.acme.example/token",
    clientId: "c",
    clientSecret: "s",
    scope: "user",
    userinfo,
    ...over,
  });
  const build = (oauth2: OAuth2Entry[]) =>
    resolveConfig({ ...base, social: { google: { clientId: "g", clientSecret: "s" }, oauth2 } });

  it("builds google first, then the entries in order, each with its kind and label", () => {
    const c = build([entry(), entry({ name: "beta-2", label: "Beta" })]);
    expect(c.social.providers.map((p) => [p.name, p.kind, p.label])).toEqual([
      ["google", "oidc", "Continue with Google"],
      ["acme", "oauth2", "Continue with Acme"],
      ["beta-2", "oauth2", "Beta"],
    ]);
  });

  it("refuses a name that fails the rule (Review Focus 2)", () => {
    for (const name of ["Acme", "1acme", "a_b", "a/b", "", "a".repeat(33)])
      expect(() => build([entry({ name })])).toThrow(/social\.oauth2\[0\]\.name must match/);
    expect(build([entry({ name: "a".repeat(32) })]).social.providers).toHaveLength(2);
  });

  it("refuses a preset name, email, credential, and a name given twice (Review Focus 2)", () => {
    for (const name of ["google", "apple", "github", "linkedin", "email", "credential"])
      expect(() => build([entry({ name })])).toThrow(
        new RegExp(`social\\.oauth2\\[0\\]\\.name ${name} is reserved`),
      );
    expect(() => build([entry(), entry()])).toThrow(
      /social\.oauth2\[1\]\.name acme is given twice/,
    );
  });

  it("refuses a bad label, scope, URL, secret, userinfo, or authorize parameter", () => {
    for (const label of ["", "x".repeat(81), "a\nb"])
      expect(() => build([entry({ label })])).toThrow(
        /social\.oauth2\[0\]\.label must be 1 to 80 characters with no control character/,
      );
    for (const scope of [" ", "user\r\nx"])
      expect(() => build([entry({ scope })])).toThrow(
        /social\.oauth2\[0\]\.scope must be a non-empty string with no control character/,
      );
    expect(() => build([entry({ authorizeUrl: "http://id.acme.example/authorize" })])).toThrow(
      /social\.oauth2\[0\]\.authorizeUrl must be an https URL/,
    );
    expect(() => build([entry({ tokenUrl: "not a url" })])).toThrow(
      /social\.oauth2\[0\]\.tokenUrl must be an https URL/,
    );
    expect(() => build([entry({ clientSecret: "" })])).toThrow(
      /social\.oauth2\[0\]\.clientSecret must be a non-empty string/,
    );
    expect(() => build([{ ...entry(), userinfo: undefined } as unknown as OAuth2Entry])).toThrow(
      /social\.oauth2\[0\]\.userinfo must be a function/,
    );
    for (const key of [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "nonce",
      "code_challenge",
      "code_challenge_method",
    ])
      expect(() => build([entry({ authorizeParams: { [key]: "x" } })])).toThrow(
        new RegExp(`social\\.oauth2\\[0\\]\\.authorizeParams\\.${key} is set by core`),
      );
    expect(() => build([entry({ authorizeParams: { prompt: "a\nb" } })])).toThrow(
      /social\.oauth2\[0\]\.authorizeParams\.prompt must be a string with no control character/,
    );
    expect(() =>
      resolveConfig({ ...base, social: { oauth2: {} as unknown as OAuth2Entry[] } }),
    ).toThrow(/social\.oauth2 must be a list/);
    for (const bad of [null, "acme", []])
      expect(() => build([bad as unknown as OAuth2Entry])).toThrow(
        /social\.oauth2\[0\] must be an object/,
      );
    for (const authorizeParams of ["prompt=consent", null, ["x"]])
      expect(() =>
        build([entry({ authorizeParams: authorizeParams as unknown as Record<string, string> })]),
      ).toThrow(/social\.oauth2\[0\]\.authorizeParams must be an object/);
  });
});

describe("social.oidc (plan 9c)", () => {
  const oidc = (over: Partial<OidcEntry> = {}): OidcEntry => ({
    name: "entra",
    label: "Continue with Microsoft",
    issuer: "https://login.acme.example/tenant-1/v2.0",
    clientId: "c",
    clientSecret: "s",
    ...over,
  });
  const build = (list: OidcEntry[]) => resolveConfig({ ...base, social: { oidc: list } });
  const endpoints = {
    authorizeUrl: "https://login.acme.example/authorize",
    tokenUrl: "https://login.acme.example/token",
    jwksUrl: "https://login.acme.example/keys",
  };

  it("takes an issuer with a path or a trailing slash, and reads the kind from endpoints", () => {
    const c = build([
      oidc(),
      oidc({ name: "auth0", issuer: "https://tenant.acme.example/" }),
      oidc({ name: "fixed", endpoints }),
    ]);
    expect(c.social.providers.map((p) => [p.name, p.kind, p.scope])).toEqual([
      ["entra", "oidc-discovery", "openid email profile"],
      ["auth0", "oidc-discovery", "openid email profile"],
      ["fixed", "oidc", "openid email profile"],
    ]);
  });

  it("refuses endpoints that is null or not an object with a ConfigError, not a TypeError", () => {
    for (const bad of [null, "https://x.example", 7, []])
      expect(() => build([oidc({ endpoints: bad as never })])).toThrow(
        /social\.oidc\[0\]\.endpoints must be an object/,
      );
  });

  it("refuses an issuer that is not an https URL with no query, fragment, or credentials", () => {
    for (const issuer of [
      "http://login.acme.example",
      "https://login.acme.example/?tenant=1",
      "https://login.acme.example/#x",
      "https://user:pass@login.acme.example",
      "login.acme.example",
    ])
      expect(() => build([oidc({ issuer })])).toThrow(
        /social\.oidc\[0\]\.issuer must be an https URL with no query, fragment, or credentials/,
      );
  });

  it("refuses a scope without openid, an endpoint that is not https, and the name rule (Review Focus 2)", () => {
    expect(() => build([oidc({ scope: "email profile" })])).toThrow(
      /social\.oidc\[0\]\.scope must hold openid/,
    );
    expect(() =>
      build([oidc({ endpoints: { ...endpoints, jwksUrl: "http://x.example/keys" } })]),
    ).toThrow(/social\.oidc\[0\]\.endpoints\.jwksUrl must be an https URL/);
    expect(() => build([oidc({ name: "linkedin" })])).toThrow(
      /social\.oidc\[0\]\.name linkedin is reserved/,
    );
    expect(() => build([oidc({ label: "" })])).toThrow(/social\.oidc\[0\]\.label/);
    expect(() =>
      resolveConfig({
        ...base,
        social: {
          oidc: [oidc()],
          oauth2: [
            {
              name: "entra",
              label: "Entra again",
              authorizeUrl: "https://a.example/authorize",
              tokenUrl: "https://a.example/token",
              clientId: "c",
              clientSecret: "s",
              scope: "x",
              userinfo: async () => ({
                subject: "s",
                email: null,
                emailVerified: false,
                name: null,
                image: null,
              }),
            },
          ],
        },
      }),
    ).toThrow(/social\.oauth2\[0\]\.name entra is given twice/);
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

describe("DEFAULT_RESERVED_SLUGS", () => {
  it("is frozen, so no caller can empty core's default", () => {
    const list = DEFAULT_RESERVED_SLUGS as string[];
    expect(() => list.push("x")).toThrow(TypeError);
    expect(() => {
      list.length = 0;
    }).toThrow(TypeError);
    expect(DEFAULT_RESERVED_SLUGS).toContain("admin");
  });
});

describe("emailOtp (plan 9e)", () => {
  it("is on with the defaults when absent, and off with false", () => {
    const on = resolveConfig(base).emailOtp;
    expect(on).toMatchObject({ ttlMinutes: 10, length: 6, maxAttempts: 5 });
    expect(on?.mail).toBe(defaultEmailOtpMail);
    expect(on?.resetMail).toBe(defaultResetOtpMail);
    expect(resolveConfig({ ...base, emailOtp: false }).emailOtp).toBeNull();
    expect(
      resolveConfig({ ...base, emailOtp: { ttlMinutes: 60, length: 8, maxAttempts: 10 } }).emailOtp,
    ).toMatchObject({ ttlMinutes: 60, length: 8, maxAttempts: 10 });
    expect(
      resolveConfig({ ...base, emailOtp: { ttlMinutes: 1, maxAttempts: 3 } }).emailOtp,
    ).toMatchObject({ ttlMinutes: 1, maxAttempts: 3 });
  });

  it("refuses a value out of range, a key core does not have, and a mail that is not a function", () => {
    const TTL = "emailOtp.ttlMinutes must be an integer from 1 to 60";
    const ATTEMPTS = "emailOtp.maxAttempts must be an integer from 3 to 10";
    const bad: [unknown, string][] = [
      [{ ttlMinutes: 0 }, TTL],
      [{ ttlMinutes: 61 }, TTL],
      [{ ttlMinutes: 1.5 }, TTL],
      [{ length: 7 }, "emailOtp.length must be 6 or 8"],
      [{ maxAttempts: 2 }, ATTEMPTS],
      [{ maxAttempts: 11 }, ATTEMPTS],
      [{ mail: "text" }, "emailOtp.mail must be a function"],
      [{ resetMail: 1 }, "emailOtp.resetMail must be a function"],
      [
        { ttl: 5 },
        "emailOtp.ttl is not an option; core has ttlMinutes, length, maxAttempts, mail, and resetMail",
      ],
      [true, "emailOtp must be an object or false"],
      [null, "emailOtp must be an object or false"],
      [[], "emailOtp must be an object or false"],
    ];
    for (const [emailOtp, message] of bad)
      expect(() => resolveConfig({ ...base, emailOtp: emailOtp as never })).toThrowError(message);
  });

  it("writes the default mails with the code, the lifetime, and the app name", () => {
    const input = { email: "a@example.com", code: "123456", ttlMinutes: 10, appName: "Acme" };
    expect(defaultEmailOtpMail(input)).toEqual({
      to: "a@example.com",
      subject: "Your sign-in code for Acme",
      text: "Your code is 123456. It is valid for 10 minutes. If you did not ask for it, ignore this message.",
    });
    expect(defaultResetOtpMail(input)).toEqual({
      to: "a@example.com",
      subject: "Your password reset code for Acme",
      text: "Your password reset code for Acme is 123456. It is valid for 10 minutes.",
    });
  });
});

describe("totp (plan 9f)", () => {
  const pw = { ...base, password: {} };

  it("is on with the defaults when password is set, off with false, and off without password", () => {
    const on = resolveConfig(pw).totp;
    expect(on).toMatchObject({
      issuer: "api.example.com",
      backupCodes: 10,
      backupCodeLength: 23,
      trustDays: 30,
      trustCookieName: "tempo_totp_trust",
    });
    expect(on?.challengePage).toBe(defaultTotpPage);
    expect(resolveConfig({ ...pw, totp: false }).totp).toBeNull();
    expect(resolveConfig(base).totp).toBeNull();
    expect(
      resolveConfig({
        ...pw,
        totp: {
          issuer: "Acme",
          backupCodes: 20,
          backupCodeLength: 32,
          trustDays: 365,
          trustCookieName: "better-auth.trust_device",
        },
      }).totp,
    ).toMatchObject({
      issuer: "Acme",
      backupCodes: 20,
      backupCodeLength: 32,
      trustDays: 365,
      trustCookieName: "better-auth.trust_device",
    });
    expect(resolveConfig({ ...pw, totp: { backupCodes: 5, trustDays: 1 } }).totp).toMatchObject({
      backupCodes: 5,
      trustDays: 1,
    });
  });

  it("drops the port of baseURL from the default issuer, and takes appName as it is (review M-2)", () => {
    const local = { ...pw, baseURL: "http://localhost:8787" };
    expect(resolveConfig(local).appName).toBe("localhost:8787");
    expect(resolveConfig(local).totp?.issuer).toBe("localhost");
    expect(resolveConfig({ ...local, appName: "Acme" }).totp?.issuer).toBe("Acme");
    expect(resolveConfig({ ...local, totp: { issuer: "Acme Dev" } }).totp?.issuer).toBe("Acme Dev");
  });

  it("refuses a default issuer that holds a colon, from an IPv6 host or from appName, and takes an issuer set beside it (plan 9h)", () => {
    const required = (issuer: string) =>
      `totp.issuer is required: the default issuer ${issuer} holds a colon, which the key URI reads as the split between the issuer and the account; set totp.issuer to a name with no colon, or set totp to false`;
    const ipv6 = { ...pw, baseURL: "http://[::1]:8787" };
    expect(() => resolveConfig(ipv6)).toThrowError(required("[::1]"));
    expect(() => resolveConfig({ ...pw, appName: "Acme: Notes" })).toThrowError(
      required("Acme: Notes"),
    );
    expect(resolveConfig({ ...ipv6, totp: { issuer: "Acme Dev" } }).totp?.issuer).toBe("Acme Dev");
    expect(resolveConfig({ ...ipv6, totp: false }).totp).toBeNull();
    // Without password the factor is off, so no issuer is needed.
    expect(resolveConfig({ ...base, baseURL: "http://[::1]:8787" }).totp).toBeNull();
  });

  it("refuses a value out of range, a key core does not have, a page that is not a function, and totp without password", () => {
    const ISSUER = "totp.issuer must be 1 to 80 characters with no control character and no colon";
    const CODES = "totp.backupCodes must be an integer from 5 to 20";
    const LENGTH =
      "totp.backupCodeLength must be an integer from 23 to 32: a backup code holds 112 bits or more (ASVS 5.0 6.5.2)";
    const DAYS = "totp.trustDays must be an integer from 1 to 365";
    const COOKIE =
      "totp.trustCookieName must be 1 to 64 letters, digits, dots, underscores, or dashes, and not the session cookie's name or tempo_session";
    const bad: [unknown, string][] = [
      [{ issuer: "" }, ISSUER],
      [{ issuer: "a".repeat(81) }, ISSUER],
      [{ issuer: "Acme:Co" }, ISSUER],
      [{ issuer: "Acme\u0007" }, ISSUER],
      [{ backupCodes: 4 }, CODES],
      [{ backupCodes: 21 }, CODES],
      [{ backupCodes: 10.5 }, CODES],
      [{ backupCodeLength: 22 }, LENGTH],
      [{ backupCodeLength: 33 }, LENGTH],
      [{ backupCodeLength: 8 }, LENGTH],
      [{ trustDays: 0 }, DAYS],
      [{ trustDays: 366 }, DAYS],
      [{ trustCookieName: "has space" }, COOKIE],
      [{ trustCookieName: "__Host-tempo_session" }, COOKIE],
      // The old session cookie name (plan 12b): the router reads and clears it for one release.
      [{ trustCookieName: "tempo_session" }, COOKIE],
      [{ trustCookieName: "" }, COOKIE],
      [{ challengePage: "html" }, "totp.challengePage must be a function"],
      [
        { digits: 8 },
        "totp.digits is not an option; core has issuer, backupCodes, backupCodeLength, trustDays, trustCookieName, challengePage, gate, and emailMail",
      ],
      [true, "totp must be an object or false"],
    ];
    for (const [totp, message] of bad)
      expect(() => resolveConfig({ ...pw, totp: totp as never })).toThrowError(message);
    expect(() => resolveConfig({ ...base, totp: {} })).toThrowError(
      "totp needs a password config: the enable of each method proves the password",
    );
  });

  it("turns the gate on for the magic link, the email code, and social by default, takes false per method, and refuses another key (plan 12c)", () => {
    // Plan 12d Task 5 adds the key sso, on by default.
    expect(resolveConfig(pw).totp?.gate).toEqual({
      magicLink: true,
      emailOtp: true,
      social: true,
      sso: true,
    });
    expect(resolveConfig({ ...pw, totp: { gate: { social: false } } }).totp?.gate).toEqual({
      magicLink: true,
      emailOtp: true,
      social: false,
      sso: true,
    });
    expect(resolveConfig({ ...pw, totp: { gate: { sso: false } } }).totp?.gate).toEqual({
      magicLink: true,
      emailOtp: true,
      social: true,
      sso: false,
    });
    expect(() =>
      resolveConfig({ ...pw, totp: { gate: { handoff: false } as never } }),
    ).toThrowError(
      "totp.gate.handoff is not an option; core has magicLink, emailOtp, social, and sso. The handoff has no key: it continues a browser session that passed the gate",
    );
    expect(() => resolveConfig({ ...pw, totp: { gate: { social: "no" } as never } })).toThrowError(
      "totp.gate.social must be true or false",
    );
    expect(() => resolveConfig({ ...pw, totp: { gate: { sso: 1 } as never } })).toThrowError(
      "totp.gate.sso must be true or false",
    );
    expect(() => resolveConfig({ ...pw, totp: { gate: true as never } })).toThrowError(
      "totp.gate must be an object",
    );
  });

  it("takes emailMail as a function and refuses another value (plan 12c)", () => {
    expect(resolveConfig(pw).totp?.emailMail).toBe(defaultSecondFactorMail);
    expect(() => resolveConfig({ ...pw, totp: { emailMail: "x" as never } })).toThrowError(
      "totp.emailMail must be a function",
    );
  });
});

describe("jwtMint (plan 9g)", () => {
  it("is on with the defaults, off with false, and takes each option", () => {
    expect(resolveConfig(base).jwtMint).toEqual({
      alg: "EdDSA",
      audience: ["https://api.example.com"],
      ttlMinutes: 15,
      claims: null,
      rotateEvery: null,
    });
    expect(resolveConfig({ ...base, jwtMint: false }).jwtMint).toBeNull();
    const claims = () => ({ role: "admin" });
    expect(
      resolveConfig({
        ...base,
        jwtMint: { alg: "ES256", audience: "https://rs.example.com", ttlMinutes: 60, claims },
      }).jwtMint,
    ).toEqual({
      alg: "ES256",
      audience: ["https://rs.example.com"],
      ttlMinutes: 60,
      claims,
      rotateEvery: null,
    });
    expect(resolveConfig({ ...base, jwtMint: { rotateEvery: 1 } }).jwtMint?.rotateEvery).toBe(1);
    expect(resolveConfig({ ...base, jwtMint: { rotateEvery: 365 } }).jwtMint?.rotateEvery).toBe(
      365,
    );
    expect(
      resolveConfig({ ...base, jwtMint: { audience: ["a", "b"], ttlMinutes: 1 } }).jwtMint,
    ).toMatchObject({ audience: ["a", "b"], ttlMinutes: 1 });
  });

  it("refuses a value out of range, a key core does not have, and a value that is not an object", () => {
    const AUD =
      "jwtMint.audience must be 1 to 10 strings of 1 to 2048 characters with no control character";
    const ROTATE = "jwtMint.rotateEvery must be a whole number of days from 1 to 365";
    const bad: [unknown, string][] = [
      [{ alg: "RS512" }, "jwtMint.alg must be EdDSA, ES256, or RS256"],
      [{ ttlMinutes: 0 }, "jwtMint.ttlMinutes must be an integer from 1 to 60"],
      [{ ttlMinutes: 61 }, "jwtMint.ttlMinutes must be an integer from 1 to 60"],
      [{ ttlMinutes: 1.5 }, "jwtMint.ttlMinutes must be an integer from 1 to 60"],
      [{ audience: [] }, AUD],
      [{ audience: [""] }, AUD],
      [{ audience: Array.from({ length: 11 }, (_, i) => `a${i}`) }, AUD],
      [{ audience: ["a\nb"] }, AUD],
      [{ claims: "x" }, "jwtMint.claims must be a function"],
      [{ rotateEvery: 0 }, ROTATE],
      [{ rotateEvery: 366 }, ROTATE],
      [{ rotateEvery: 1.5 }, ROTATE],
      [{ rotateEvery: "30" }, ROTATE],
      [
        { issuer: "x" },
        "jwtMint.issuer is not an option; core has alg, audience, ttlMinutes, claims, and rotateEvery",
      ],
      [true, "jwtMint must be an object or false"],
    ];
    for (const [jwtMint, message] of bad)
      expect(() => resolveConfig({ ...base, jwtMint: jwtMint as never })).toThrowError(message);
  });
});

describe("oauth (plan 9g)", () => {
  const R = "https://api.example.com/mcp";
  const fetch = (async () => new Response()) as typeof globalThis.fetch;

  it("is off when absent or false, and on with the defaults when resources is set", () => {
    expect(resolveConfig(base).oauth).toBeNull();
    expect(resolveConfig({ ...base, oauth: false }).oauth).toBeNull();
    const on = resolveConfig({ ...base, oauth: { resources: [R], fetch } }).oauth;
    expect(on).toMatchObject({
      resources: [R],
      // Plan 12e ruling 52: no default resource, so an absent resource answers invalid_target.
      defaultResource: null,
      // Off by default since plan 12e: MCP 2026-07-28 calls dynamic registration deprecated.
      dynamic: false,
      cimd: true,
      initialAccessTokenHash: null,
      fetch,
      accessTtlMinutes: 15,
      refreshTtlDays: 30,
      codeTtlMinutes: 5,
      introspection: null,
      // Plan 12e Task 9: every proof alg, and a window of 60 s.
      dpop: { algs: ["EdDSA", "Ed25519", "ES256", "RS256", "PS256"], windowSeconds: 60 },
      // Plan 12e Task 13: the reuse window is off.
      refreshReuseSeconds: 0,
    });
    expect([...(on?.scopes.keys() ?? [])]).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
    ]);
    expect(on?.consentPage).toBe(defaultConsentPage);
    const custom = resolveConfig({
      ...base,
      jwtMint: { ttlMinutes: 30 },
      oauth: {
        resources: [R, "http://localhost:8787/mcp"],
        scopes: { "mcp:read": "Read" },
        registration: { cimd: false, dynamic: true },
        refreshTtlDays: 365,
        codeTtlMinutes: 10,
        refreshReuseSeconds: 60,
      },
    }).oauth;
    expect(custom).toMatchObject({
      cimd: false,
      fetch: null,
      accessTtlMinutes: 30,
      refreshTtlDays: 365,
      codeTtlMinutes: 10,
      refreshReuseSeconds: 60,
    });
    expect(custom?.scopes.get("mcp:read")).toBe("Read");
  });

  it("refuses a bad resource list, scope, registration, fetch, lifetime, page, and key, and refuses oauth without jwtMint", () => {
    const RES =
      "oauth.resources must be 1 to 20 distinct absolute http or https URLs with no query, fragment, or credentials";
    const bad: [unknown, string][] = [
      [{ fetch }, RES],
      [{ resources: [], fetch }, RES],
      [{ resources: ["/mcp"], fetch }, RES],
      [{ resources: ["ftp://a.example.com/x"], fetch }, RES],
      [{ resources: [`${R}?x=1`], fetch }, RES],
      [{ resources: [`${R}#a`], fetch }, RES],
      [{ resources: ["https://u:p@api.example.com/mcp"], fetch }, RES],
      [{ resources: [R, R], fetch }, RES],
      [
        { resources: [R], fetch, scopes: { "bad scope": "x" } },
        "oauth.scopes has a name that is not a scope token: 1 to 64 printable ASCII characters with no space, quote, or backslash",
      ],
      [{ resources: [R], fetch, scopes: { openid: "x" } }, "oauth.scopes.openid is built in"],
      [
        { resources: [R], fetch, scopes: { a: "" } },
        "oauth.scopes.a must be 1 to 200 characters with no control character",
      ],
      [{ resources: [R], fetch, registration: null }, "oauth.registration must be an object"],
      [
        { resources: [R], fetch, registration: { cimd: "yes" } },
        "oauth.registration.cimd must be a boolean",
      ],
      [
        { resources: [R], fetch, registration: { open: true } },
        "oauth.registration.open is not an option; core has dynamic, cimd, and initialAccessTokenHash",
      ],
      [
        { resources: [R] },
        "oauth.fetch is required while registration.cimd is on: pass the app's guarded fetch for client metadata documents, or set registration.cimd to false",
      ],
      [{ resources: [R], fetch: "x" }, "oauth.fetch must be a function"],
      [
        { resources: [R], fetch, accessTtlMinutes: 61 },
        "oauth.accessTtlMinutes must be an integer from 1 to 60",
      ],
      [
        { resources: [R], fetch, refreshTtlDays: 0 },
        "oauth.refreshTtlDays must be an integer from 1 to 365",
      ],
      [
        { resources: [R], fetch, codeTtlMinutes: 11 },
        "oauth.codeTtlMinutes must be an integer from 1 to 10",
      ],
      [
        { resources: [R], fetch, refreshReuseSeconds: 61 },
        "oauth.refreshReuseSeconds must be an integer from 0 to 60",
      ],
      [
        { resources: [R], fetch, refreshReuseSeconds: -1 },
        "oauth.refreshReuseSeconds must be an integer from 0 to 60",
      ],
      [
        { resources: [R], fetch, refreshReuseSeconds: 1.5 },
        "oauth.refreshReuseSeconds must be an integer from 0 to 60",
      ],
      [{ resources: [R], fetch, consentPage: "html" }, "oauth.consentPage must be a function"],
      [
        { resources: [R], fetch, defaultResource: "https://api.example.com/other" },
        "oauth.defaultResource must be one entry of oauth.resources",
      ],
      [
        { resources: [R], fetch, defaultResource: 7 },
        "oauth.defaultResource must be one entry of oauth.resources",
      ],
      [
        { resources: [R], fetch, loginPage: "/login" },
        "oauth.loginPage is not an option; core has resources, defaultResource, scopes, registration, fetch, consentPage, accessTtlMinutes, refreshTtlDays, codeTtlMinutes, introspection, dpop, signInURL, refreshReuseSeconds, device, and devicePage",
      ],
      [true, "oauth must be an object or false"],
    ];
    for (const [oauth, message] of bad)
      expect(() => resolveConfig({ ...base, oauth: oauth as never })).toThrowError(message);
    expect(() =>
      resolveConfig({ ...base, jwtMint: false, oauth: { resources: [R], fetch } }),
    ).toThrowError("oauth needs jwtMint: an access token is a JWT that core signs");
  });

  it("reads oauth.introspection and refuses a resource outside oauth.resources (ruling 29 of plan 12e)", () => {
    const R2 = "https://api.example.com/files";
    const on = resolveConfig({
      ...base,
      oauth: { resources: [R, R2], fetch, introspection: { cl_rs: [R2], cl_two: [R, R2] } },
    }).oauth;
    expect(on?.introspection).toEqual(
      new Map([
        ["cl_rs", [R2]],
        ["cl_two", [R, R2]],
      ]),
    );
    const LIST = "must be a list of distinct entries of oauth.resources";
    const bad: [unknown, string][] = [
      [[], "oauth.introspection must be an object of client ids to resource lists"],
      [null, "oauth.introspection must be an object of client ids to resource lists"],
      [{ cl_rs: ["https://other.example.com/mcp"] }, `oauth.introspection.cl_rs ${LIST}`],
      [{ cl_rs: [] }, `oauth.introspection.cl_rs ${LIST}`],
      [{ cl_rs: [R, R] }, `oauth.introspection.cl_rs ${LIST}`],
      [{ cl_rs: R }, `oauth.introspection.cl_rs ${LIST}`],
      [
        { "": [R] },
        "oauth.introspection has a client id that is not 1 to 2048 characters with no control character",
      ],
    ];
    for (const [introspection, message] of bad)
      expect(() =>
        resolveConfig({
          ...base,
          oauth: { resources: [R, R2], fetch, introspection: introspection as never },
        }),
      ).toThrowError(message);
  });

  it("reads oauth.dpop and refuses a bad alg list or window (plan 12e Task 9)", () => {
    const on = resolveConfig({
      ...base,
      oauth: { resources: [R], fetch, dpop: { algs: ["ES256", "EdDSA"], windowSeconds: 300 } },
    }).oauth;
    expect(on?.dpop).toEqual({ algs: ["ES256", "EdDSA"], windowSeconds: 300 });
    expect(
      resolveConfig({ ...base, oauth: { resources: [R], fetch, dpop: { windowSeconds: 10 } } })
        .oauth?.dpop.windowSeconds,
    ).toBe(10);
    const ALGS =
      "oauth.dpop.algs must be a list of distinct values of EdDSA, Ed25519, ES256, RS256, and PS256";
    const WINDOW = "oauth.dpop.windowSeconds must be an integer from 10 to 300";
    const bad: [unknown, string][] = [
      [null, "oauth.dpop must be an object"],
      [[], "oauth.dpop must be an object"],
      [{ nonce: true }, "oauth.dpop.nonce is not an option; core has algs and windowSeconds"],
      [{ algs: [] }, ALGS],
      [{ algs: ["ES256", "ES256"] }, ALGS],
      [{ algs: ["HS256"] }, ALGS],
      [{ algs: ["none"] }, ALGS],
      [{ algs: "ES256" }, ALGS],
      [{ windowSeconds: 9 }, WINDOW],
      [{ windowSeconds: 301 }, WINDOW],
      [{ windowSeconds: 60.5 }, WINDOW],
      [{ windowSeconds: "60" }, WINDOW],
    ];
    for (const [dpop, message] of bad)
      expect(() =>
        resolveConfig({ ...base, oauth: { resources: [R], fetch, dpop: dpop as never } }),
      ).toThrowError(message);
  });

  it("reads oauth.device and refuses a value outside its bounds (spec 8.16 item 13)", () => {
    const device = (value: unknown) =>
      resolveConfig({ ...base, oauth: { resources: [R], fetch, device: value as never } }).oauth
        ?.device;
    expect(device(undefined)).toBeNull();
    expect(device(false)).toBeNull();
    expect(device({})).toEqual({ codeTtlMinutes: 10, interval: 5 });
    expect(device({ codeTtlMinutes: 1, interval: 60 })).toEqual({
      codeTtlMinutes: 1,
      interval: 60,
    });
    expect(device({ codeTtlMinutes: 30, interval: 5 })).toEqual({
      codeTtlMinutes: 30,
      interval: 5,
    });
    const TTL = "oauth.device.codeTtlMinutes must be an integer from 1 to 30";
    const INTERVAL = "oauth.device.interval must be an integer from 5 to 60";
    const bad: [unknown, string][] = [
      [true, "oauth.device must be an object or false"],
      [null, "oauth.device must be an object or false"],
      [
        { codeTtl: 5 },
        "oauth.device.codeTtl is not an option; core has codeTtlMinutes and interval",
      ],
      [{ codeTtlMinutes: 0 }, TTL],
      [{ codeTtlMinutes: 31 }, TTL],
      [{ codeTtlMinutes: 1.5 }, TTL],
      [{ codeTtlMinutes: "10" }, TTL],
      [{ interval: 4 }, INTERVAL],
      [{ interval: 61 }, INTERVAL],
      [{ interval: 5.5 }, INTERVAL],
      [{ interval: "5" }, INTERVAL],
    ];
    for (const [value, message] of bad) expect(() => device(value)).toThrowError(message);
  });

  it("accepts dynamic and cimd both off: api.oauth.clients.create is the way in (plan 12e)", () => {
    expect(
      resolveConfig({
        ...base,
        oauth: { resources: [R], registration: { dynamic: false, cimd: false } },
      }).oauth,
    ).toMatchObject({ dynamic: false, cimd: false });
  });

  it("refuses an initialAccessTokenHash while registration.dynamic is off", () => {
    const message =
      "oauth.registration.initialAccessTokenHash needs oauth.registration.dynamic set to true: the register route that reads the token is off";
    for (const registration of [
      { cimd: false, initialAccessTokenHash: "0a".repeat(32) },
      { cimd: false, dynamic: false, initialAccessTokenHash: "0a".repeat(32) },
    ])
      expect(() =>
        resolveConfig({ ...base, oauth: { resources: [R], registration } }),
      ).toThrowError(message);
  });

  it("refuses an initialAccessTokenHash that is not 64 lowercase hex characters", () => {
    const message =
      "oauth.registration.initialAccessTokenHash must be the SHA-256 of the token as 64 lowercase hex characters";
    for (const hash of [
      "a".repeat(63),
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(65),
      "",
      7,
      null,
    ])
      expect(() =>
        resolveConfig({
          ...base,
          oauth: {
            resources: [R],
            registration: { dynamic: true, cimd: false, initialAccessTokenHash: hash as never },
          },
        }),
      ).toThrowError(message);
    expect(
      resolveConfig({
        ...base,
        oauth: {
          resources: [R],
          registration: { dynamic: true, cimd: false, initialAccessTokenHash: "0a".repeat(32) },
        },
      }).oauth?.initialAccessTokenHash,
    ).toBe("0a".repeat(32));
  });

  it("refuses a jwtMint.audience entry that is also an oauth.resources entry, by either form of audience (final fix wave, review I-2)", () => {
    const message = `jwtMint.audience and oauth.resources both hold ${R}: a server of that audience would take an OAuth access token as a session JWT; give the session JWT its own audience`;
    for (const audience of [R, ["https://app.example.com", R]])
      expect(() =>
        resolveConfig({ ...base, jwtMint: { audience }, oauth: { resources: [R], fetch } }),
      ).toThrowError(message);
    // The default audience is baseURL: a resource equal to it is refused too.
    expect(() =>
      resolveConfig({ ...base, oauth: { resources: [base.baseURL], fetch } }),
    ).toThrowError("jwtMint.audience and oauth.resources both hold");
    // A resource under the audience at another path is another string: it passes.
    expect(
      resolveConfig({
        ...base,
        jwtMint: { audience: base.baseURL },
        oauth: { resources: [R], fetch },
      }).oauth?.resources,
    ).toEqual([R]);
  });
});
