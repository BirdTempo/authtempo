import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import { COMPAT_PLUGIN, passkey } from "../src/plugins.js";
import { checkOptions } from "../src/server/check-options.js";
import type { BetterAuthOptions } from "../src/types.js";
import { consumerc, consumere, consumerb, consumerd, consumeri } from "../typetest/options.js";

const paths = (refusals: string[]) => refusals.map((r) => r.slice(0, r.indexOf(":")));

describe("checkOptions on the five apps (Review Focus 1)", () => {
  it("refuses exactly these consumere options", () => {
    const c = checkOptions(consumere);
    // GitHub and LinkedIn map onto core's presets since plan 9c.
    expect(paths(c.refusals)).toEqual(["secondaryStorage", "session.storeSessionInDatabase"]);
    // consumere sets disableIpTracking: accepted, with the note that the per-IP limits are skipped.
    expect(paths(c.notes)).toEqual([
      "advanced.database.generateId",
      "advanced.ipAddress.disableIpTracking",
    ]);
    // The note names what the trade costs (final review L-11).
    expect(c.notes.find((n) => n.startsWith("advanced.ipAddress.disableIpTracking"))).toContain(
      "one caller can try one password on many addresses, bounded only by each address's limit",
    );
  });

  it("maps github and linkedin, refuses their unknown keys, and refuses another provider with a pointer to core's lists (plan 9c)", () => {
    const c = checkOptions({
      socialProviders: {
        github: { clientId: "h", clientSecret: "h", scope: ["repo"] },
        linkedin: { clientId: "l", clientSecret: "l" },
        discord: { clientId: "d", clientSecret: "d" },
      },
    } as unknown as BetterAuthOptions);
    expect(c.refusals.filter((r) => r.startsWith("socialProviders"))).toEqual([
      "socialProviders.discord: not mapped; add it through core's social.oidc or social.oauth2",
      "socialProviders.github.scope: tempo-auth has no such option",
    ]);
  });

  it("refuses a missing, empty, whitespace-only, or non-string clientId or clientSecret of google, github, and linkedin", () => {
    for (const name of ["google", "github", "linkedin"]) {
      const refusals = (config: unknown) =>
        checkOptions({
          socialProviders: { [name]: config },
        } as unknown as BetterAuthOptions).refusals.filter((r) => r.startsWith("socialProviders"));
      expect(refusals({ clientId: "i" })).toEqual([
        `socialProviders.${name}.clientSecret: required`,
      ]);
      expect(refusals({ clientSecret: "s" })).toEqual([
        `socialProviders.${name}.clientId: required`,
      ]);
      expect(refusals({ clientId: "", clientSecret: "s" })).toEqual([
        `socialProviders.${name}.clientId: required`,
      ]);
      expect(refusals({ clientId: "   ", clientSecret: "s" })).toEqual([
        `socialProviders.${name}.clientId: required`,
      ]);
      expect(refusals({ clientId: "i", clientSecret: " \t\n" })).toEqual([
        `socialProviders.${name}.clientSecret: required`,
      ]);
      expect(refusals({ clientId: 1, clientSecret: ["s"] })).toEqual([
        `socialProviders.${name}.clientId: expected a string`,
        `socialProviders.${name}.clientSecret: expected a string`,
      ]);
      expect(refusals({ clientId: "i", clientSecret: "s" })).toEqual([]);
    }
  });

  it("refuses exactly these consumer-i options", () => {
    const c = checkOptions(consumeri);
    expect(paths(c.refusals)).toEqual([
      "emailAndPassword.sendResetPassword",
      "emailVerification.sendVerificationEmail",
      "plugins[organization].sendInvitationEmail",
      "rateLimit.customRules",
      "rateLimit.customStorage",
      "rateLimit.max",
      "rateLimit.window",
    ]);
    expect(paths(c.notes)).toEqual(["session.cookieCache"]);
    // Since plan 9d the package maps Better Auth's limits and their defaults of 100, so no note says that they are missing.
    expect(c.notes.join("\n")).not.toContain("100 members");
  });

  // The exact lists, so a key accepted in silence fails here (final review L-6).
  const EXACT = {
    consumerc: [
      "hooks",
      "plugins[expo]",
      "plugins[organization].ac",
      "plugins[organization].dynamicAccessControl",
      "plugins[organization].roles",
      "plugins[organization].sendInvitationEmail",
      "socialProviders.apple.clientSecret",
      "socialProviders.apple",
    ],
    consumerd: [
      "baseURL",
      "hooks",
      "plugins[admin]",
      "plugins[anonymous]",
      "plugins[email-otp]",
      "plugins[organization].ac",
      "plugins[organization].disableOrganizationDeletion",
      "plugins[organization].roles",
      "plugins[organization].teams",
      "plugins[passkey].origin",
      "rateLimit.customStorage",
      "secret",
      "session.deferSessionRefresh",
      "session.freshAge",
    ],
    consumerb: [
      "advanced.defaultCookieAttributes.secure",
      "emailAndPassword.requireEmailVerification",
      "emailAndPassword.sendResetPassword",
      "emailVerification.expiresIn",
      "plugins[admin]",
      "plugins[api-key]",
      "plugins[cimd]",
      "plugins[jwt]",
      "plugins[mcp]",
      "plugins[organization].ac",
      "plugins[organization].roles",
      "plugins[organization].sendInvitationEmail",
      "plugins[passkey].origin",
    ],
  };

  it("refuses exactly these consumerc, consumerd, and consumerb options, and the README lists the same", () => {
    const apps = { consumerc, consumerd, consumerb };
    for (const [name, list] of Object.entries(EXACT)) {
      // consumerd fails the weak-type rule (TS2559: its rateLimit has no key in common with the type); the runtime check is what this test pins.
      const c = checkOptions(apps[name as keyof typeof apps] as BetterAuthOptions);
      expect({ name, refusals: paths(c.refusals) }).toEqual({ name, refusals: list });
      if (name === "consumerb")
        expect(c.refusals).toContain("plugins[api-key]: not mapped; see the plan index");
      const line = readme
        .split("\n")
        .find((l, i, all) => all[i - 1]?.startsWith(`${name} (`) && l.startsWith("The factory"));
      expect({ name, readme: line }).toEqual({
        name,
        readme: `The factory refuses exactly these: ${list.map((k) => `\`${k}\``).join(", ")}.`,
      });
    }
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
      [{ ...base, socialProviders: { apple: null } }, "socialProviders.apple"],
      [{ ...base, plugins: [null] }, "plugins[unknown]"],
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

  it("refuses a magic link plugin with no sendMagicLink and a passkey plugin with no rpID, rpName, or origin (M-7)", () => {
    const noSend = { kind: COMPAT_PLUGIN, id: "magic-link", options: {} } as never;
    expect(checkOptions({ ...base, plugins: [noSend] }).refusals).toEqual([
      "plugins[magic-link].sendMagicLink: required",
    ]);
    expect(checkOptions({ ...base, plugins: [passkey({})] }).refusals).toEqual([
      "plugins[passkey].origin: required",
      "plugins[passkey].rpID: required",
      "plugins[passkey].rpName: required",
    ]);
  });

  it("refuses a trustedOrigins function and each entry that is not an exact origin or an app scheme (M-2)", () => {
    expect(checkOptions({ ...base, trustedOrigins: () => [] }).refusals).toEqual([
      "trustedOrigins: a function is refused; pass a list of exact origins",
    ]);
    const c = checkOptions({
      ...base,
      trustedOrigins: [
        "https://app.example.com",
        "http://localhost:3000",
        "app://",
        "https://*.example.com",
        "https://app.example.com/",
        "https://app.example.com/path",
        "https://",
      ],
    });
    expect(paths(c.refusals)).toEqual([
      "trustedOrigins[3]",
      "trustedOrigins[4]",
      "trustedOrigins[5]",
      "trustedOrigins[6]",
    ]);
    expect(c.refusals[0]).toContain(
      "Better Auth's wildcard form (https://*.example.com) is refused",
    );
  });
});
