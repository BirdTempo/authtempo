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
    // The email code cost too (plan 9e final fix wave, M-2).
    expect(c.notes.find((n) => n.startsWith("advanced.ipAddress.disableIpTracking"))).toContain(
      "can guess 10 email codes on each of many addresses per 15 minutes (at most 100 a day per address)",
    );
  });

  it("maps github and linkedin, refuses their unknown keys, and refuses another provider with a pointer to core's lists (plan 9c)", () => {
    const c = checkOptions({
      socialProviders: {
        github: { clientId: "h", clientSecret: "h", scope: ["repo"] },
        linkedin: { clientId: "l", clientSecret: "l" },
        twitch: { clientId: "t", clientSecret: "t" },
      },
    } as unknown as BetterAuthOptions);
    expect(c.refusals.filter((r) => r.startsWith("socialProviders"))).toEqual([
      "socialProviders.github.scope: authtempo has no such option",
      "socialProviders.twitch: not mapped; add it through core's social.oidc or social.oauth2",
    ]);
  });

  it("maps microsoft, discord, gitlab, twitter, and facebook, and refuses slack by its subject (plan 12i Task 16, ruling 22)", () => {
    const refusalOf = (name: string) =>
      checkOptions({
        socialProviders: { [name]: { clientId: "i", clientSecret: "s" } },
      } as unknown as BetterAuthOptions).refusals.filter((r) => r.startsWith("socialProviders"));
    for (const name of ["microsoft", "discord", "gitlab", "twitter", "facebook"])
      expect(refusalOf(name)).toEqual([]);
    const [slack] = refusalOf("slack");
    expect(slack).toMatch(
      /^socialProviders\.slack: not mapped: core's Slack subject is team_id:user_id, and Better Auth's account rows hold the user_id alone/,
    );
    // Every other key of the Better Auth provider stays refused.
    expect(
      checkOptions({
        socialProviders: {
          microsoft: { clientId: "i", clientSecret: "s", tenantId: "common", prompt: "login" },
          gitlab: {
            clientId: "i",
            clientSecret: "s",
            issuer: "https://gitlab.example.com",
            scope: [],
          },
        },
      } as unknown as BetterAuthOptions).refusals.filter((r) => r.startsWith("socialProviders")),
    ).toEqual([
      "socialProviders.gitlab.scope: authtempo has no such option",
      "socialProviders.microsoft.prompt: authtempo has no such option",
    ]);
    // An inherited key of a plain object is not a preset name.
    expect(refusalOf("toString")).toEqual([
      "socialProviders.toString: not mapped; add it through core's social.oidc or social.oauth2",
    ]);
    // The README states each reason that a provider id can reach.
    expect(readme).toContain("core's Slack subject is team_id:user_id");
    expect(readme).not.toContain("coming preset");
    expect(readme).toContain("`not mapped; add it through core's social.oidc or social.oauth2`");
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

  it("maps tiktok by clientKey and wechat by clientId, and refuses a missing key or an unknown option (plan 12i Task 22)", () => {
    const refusals = (socialProviders: unknown) =>
      checkOptions({ socialProviders } as unknown as BetterAuthOptions).refusals.filter((r) =>
        r.startsWith("socialProviders"),
      );
    expect(
      refusals({
        tiktok: { clientKey: "k", clientSecret: "s", disableSignUp: true },
        wechat: { clientId: "i", clientSecret: "s" },
      }),
    ).toEqual([]);
    expect(refusals({ tiktok: { clientId: "k", clientSecret: "s" } })).toEqual([
      "socialProviders.tiktok.clientId: authtempo has no such option",
      "socialProviders.tiktok.clientKey: required",
    ]);
    expect(refusals({ tiktok: { clientKey: " ", clientSecret: "s" } })).toEqual([
      "socialProviders.tiktok.clientKey: required",
    ]);
    expect(refusals({ wechat: { clientId: "i", clientSecret: "", lang: "en" } })).toEqual([
      "socialProviders.wechat.clientSecret: required",
      "socialProviders.wechat.lang: authtempo has no such option",
    ]);
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
    // Since plan 12k Task 10 ac, roles, and dynamicAccessControl map; each role still needs its rank.
    // Since Task 11 teams maps.
    consumerc: [
      "hooks",
      "plugins[expo]",
      "plugins[organization].roles.admin",
      "plugins[organization].roles.member",
      "plugins[organization].roles.operator",
      "plugins[organization].roles.owner",
      "plugins[organization].roles.viewer",
      "plugins[organization].sendInvitationEmail",
      "socialProviders.apple.clientSecret",
      "socialProviders.apple",
    ],
    consumerd: [
      "baseURL",
      "hooks",
      "plugins[admin]",
      "plugins[anonymous]",
      "plugins[organization].disableOrganizationDeletion",
      "plugins[organization].roles.admin",
      "plugins[organization].roles.guardian",
      "plugins[organization].roles.learner",
      "plugins[organization].roles.owner",
      "plugins[organization].roles.teacher",
      "plugins[passkey].origin",
      "rateLimit.customStorage",
      "secret",
    ],
    consumerb: [
      "advanced.defaultCookieAttributes.secure",
      "emailAndPassword.sendResetPassword",
      "emailVerification.expiresIn",
      "plugins[admin]",
      "plugins[cimd]",
      "plugins[jwt]",
      "plugins[mcp]",
      "plugins[organization].roles.admin",
      "plugins[organization].roles.member",
      "plugins[organization].roles.owner",
      "plugins[organization].roles.viewer",
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
      // Plan 12k Task 12 maps the api-key plugin: no refusal names it.
      if (name === "consumerb")
        expect(c.refusals.filter((r) => r.startsWith("plugins[api-key]"))).toEqual([]);
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
      kind: "authtempo-compat-database" as const,
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
        requireEmailVerification: true,
        autoSignIn: true,
        disableSignUp: false,
        revokeSessionsOnPasswordReset: true,
        resetPasswordTokenExpiresIn: 1800,
        sendResetPassword: send,
      },
      emailVerification: {
        sendVerificationEmail: send,
        sendOnSignUp: true,
        sendOnSignIn: true,
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

  it("refuses Better Auth's captcha and have-i-been-pwned plugins and names core's options (plan 12b)", () => {
    // Better Auth's own plugin objects: a refusal case, so the cast is the input.
    const foreign = [{ id: "captcha" }, { id: "have-i-been-pwned" }] as never;
    expect(checkOptions({ ...base, plugins: foreign }).refusals).toEqual([
      "plugins[captcha]: not mapped; use core's captcha option (@authtempo/core) with @authtempo/captcha-turnstile",
      "plugins[have-i-been-pwned]: not mapped; use core's password.breachCheck option (@authtempo/core) with @authtempo/breach-check",
    ]);
    for (const name of ["`captcha`", "`have-i-been-pwned`", "@authtempo/breach-check"])
      expect(readme).toContain(name);
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

describe("checkOptions: the JWT and OAuth provider plugins (plan 9g)", () => {
  it("refuses jwt, mcp, cimd, oidc-provider, and oauth-provider with plan 9g's texts", () => {
    const c = checkOptions({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      database: {
        kind: "authtempo-compat-database",
        dialect: "postgres",
        storage: {} as never,
        limiter: {} as never,
      },
      plugins: [
        { id: "jwt" },
        { id: "mcp", loginPage: "/login" },
        { id: "cimd" },
        { id: "oidc-provider" },
        { id: "oauth-provider" },
      ],
    } as unknown as BetterAuthOptions);
    const PROVIDER =
      "core has an OAuth 2.1 and OIDC provider on its own routes (`/oauth/*`, the well-known handler); the Better Auth plugin is not mapped; see the plan index";
    expect(c.refusals).toEqual([
      `plugins[cimd]: ${PROVIDER}`,
      "plugins[jwt]: core mints JWTs on its own routes (`/jwks`, `/token`, `api.jwt`); the Better Auth plugin is not mapped, and a token it issued stops verifying at the cutover; see the plan index",
      `plugins[mcp]: ${PROVIDER}`,
      `plugins[oauth-provider]: ${PROVIDER}`,
      `plugins[oidc-provider]: ${PROVIDER}`,
    ]);
  });
});
