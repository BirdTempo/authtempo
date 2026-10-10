import { describe, expect, it } from "vitest";
import { checkOptions } from "../src/server/check-options.js";
import { consumerc, consumere, consumerb, consumerd, consumeri } from "../typetest/options.js";

const paths = (refusals: string[]) => refusals.map((r) => r.slice(0, r.indexOf(":")));

describe("checkOptions on the five apps (Review Focus 1)", () => {
  it("refuses exactly these consumere options", () => {
    const c = checkOptions(consumere);
    expect(paths(c.refusals)).toEqual([
      "databaseHooks",
      "secondaryStorage",
      "session.storeSessionInDatabase",
      "socialProviders.github",
      "socialProviders.linkedin",
    ]);
    expect(c.refusals).toContain(
      "socialProviders.github: plan 9c (a generic OAuth2 and OIDC provider) is not written yet",
    );
    // consumere sets disableIpTracking: accepted, with the note that the per-IP limits are skipped.
    expect(paths(c.notes)).toEqual([
      "advanced.database.generateId",
      "advanced.ipAddress.disableIpTracking",
    ]);
  });

  it("refuses exactly these consumer-i options", () => {
    const c = checkOptions(consumeri);
    expect(paths(c.refusals)).toEqual([
      "emailAndPassword.sendResetPassword",
      "emailVerification.sendVerificationEmail",
      "plugins[organization].organizationHooks",
      "plugins[organization].organizationLimit",
      "plugins[organization].sendInvitationEmail",
      "rateLimit.customRules",
      "rateLimit.customStorage",
      "rateLimit.max",
      "rateLimit.window",
    ]);
    expect(paths(c.notes)).toEqual(["session.cookieCache"]);
  });

  it("refuses the consumerc, consumerd, and consumerb features the README names", () => {
    expect(paths(checkOptions(consumerc).refusals)).toEqual(
      expect.arrayContaining([
        "databaseHooks",
        "hooks",
        "plugins[organization].ac",
        "plugins[organization].roles",
        "plugins[organization].dynamicAccessControl",
        "plugins[organization].organizationHooks",
        "socialProviders.apple",
        "socialProviders.apple.clientSecret",
      ]),
    );
    expect(paths(checkOptions(consumerd).refusals)).toEqual(
      expect.arrayContaining([
        "hooks",
        "plugins[admin]",
        "plugins[email-otp]",
        "plugins[anonymous]",
        "plugins[organization].teams",
        "plugins[organization].membershipLimit",
        "session.freshAge",
        "session.deferSessionRefresh",
        "rateLimit.customStorage",
      ]),
    );
    expect(paths(checkOptions(consumerb).refusals)).toEqual(
      expect.arrayContaining([
        "plugins[admin]",
        "plugins[api-key]",
        "plugins[jwt]",
        "plugins[mcp]",
        "plugins[cimd]",
        "emailAndPassword.requireEmailVerification",
        "advanced.defaultCookieAttributes.secure",
      ]),
    );
  });
});

describe("checkOptions: the allow list fails closed", () => {
  const base = {
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    database: {
      kind: "tempo-auth-compat-database" as const,
      dialect: "postgres" as const,
      storage: {} as never,
      limiter: {} as never,
    },
  };

  it("accepts a full option object that uses only mapped keys", () => {
    const send = async () => {};
    const c = checkOptions({
      ...base,
      appName: "App",
      basePath: "/api/auth",
      trustedOrigins: ["https://app.example.com", "app://"],
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        requireEmailVerification: false,
        autoSignIn: true,
        disableSignUp: false,
        revokeSessionsOnPasswordReset: true,
        resetPasswordTokenExpiresIn: 1800,
        sendResetPassword: send,
      },
      emailVerification: {
        sendVerificationEmail: send,
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        expiresIn: 3600,
      },
      socialProviders: {
        google: { clientId: "g", clientSecret: "s" },
        apple: { clientId: "a", teamId: "T", keyId: "K", privateKey: "P" },
      },
      session: { expiresIn: 2592000, updateAge: 86400 },
      advanced: {
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], disableIpTracking: false },
        defaultCookieAttributes: { sameSite: "none" },
      },
      rateLimit: { enabled: true },
      telemetry: { enabled: false },
    });
    expect(c).toEqual({ refusals: [], notes: [] });
  });

  it("refuses a key the list does not name, at every level", () => {
    for (const [options, path] of [
      [{ ...base, someNewOption: 1 }, "someNewOption"],
      [
        { ...base, emailAndPassword: { enabled: false, password: {} } },
        "emailAndPassword.password",
      ],
      [{ ...base, session: { additionalFields: {} } }, "session.additionalFields"],
      [{ ...base, advanced: { cookiePrefix: "x" } }, "advanced.cookiePrefix"],
      [{ ...base, advanced: { ipAddress: { ipv6Subnet: 64 } } }, "advanced.ipAddress.ipv6Subnet"],
      [
        {
          ...base,
          socialProviders: { google: { clientId: "g", clientSecret: "s", prompt: "consent" } },
        },
        "socialProviders.google.prompt",
      ],
      [{ ...base, telemetry: { enabled: false, debug: true } }, "telemetry.debug"],
    ] as const) {
      expect(paths(checkOptions(options as never).refusals)).toEqual([path]);
    }
  });

  it("refuses a missing baseURL, secret, or database, and a baseURL path that differs from basePath", () => {
    expect(paths(checkOptions({}).refusals)).toEqual(["baseURL", "database", "secret"]);
    expect(
      checkOptions({ ...base, baseURL: "https://api.example.com/auth", basePath: "/api/auth" })
        .refusals,
    ).toEqual(["baseURL: its path /auth differs from basePath /api/auth"]);
  });

  it("refuses a value that is not whole minutes or whole days", () => {
    expect(paths(checkOptions({ ...base, session: { expiresIn: 90000 } }).refusals)).toEqual([
      "session.expiresIn",
    ]);
    expect(
      paths(
        checkOptions({ ...base, emailAndPassword: { resetPasswordTokenExpiresIn: 90 } }).refusals,
      ),
    ).toEqual(["emailAndPassword.resetPasswordTokenExpiresIn"]);
  });
});
