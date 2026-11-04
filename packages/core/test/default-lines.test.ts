import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, resolveConfig, secretValues } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { confirmEmailChange, requestEmailChange } from "../src/engine/email-change.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { runBefore } from "../src/engine/hooks.js";
import { mintSessionJwt } from "../src/engine/jwt.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { fetchCimd, fetchClientJwks, findClient } from "../src/engine/oauth-clients.js";
import { deleteFamilies } from "../src/engine/oauth-family.js";
import { revokeGrant } from "../src/engine/oauth-grants.js";
import { deliverLogouts } from "../src/engine/oauth-logout.js";
import { auditDraft, operatorAct } from "../src/engine/operator/audit.js";
import { banUser } from "../src/engine/operator/ban.js";
import { requireOperatorUser } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { createOrganization } from "../src/engine/organizations.js";
import {
  deletePasskey,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { effectiveIn } from "../src/engine/permissions.js";
import { addPhone, requestPhone, sendPhoneCode, verifyAddPhone } from "../src/engine/phone.js";
import { updateProfile } from "../src/engine/profile.js";
import { createRole, listRoles } from "../src/engine/roles.js";
import { rewrapSecrets } from "../src/engine/secrets.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { connectionSecret } from "../src/engine/sso/connections.js";
import { addDomain, verifyDomain } from "../src/engine/sso/domains.js";
import { requireSsoManager } from "../src/engine/sso/guard.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { disableTotpWithCode, regenerateBackupCodes, verifyTwoFactor } from "../src/engine/totp.js";
import { setUsername } from "../src/engine/username.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { EVENTS, type EventSpec } from "../src/observe/events.js";
import type { AuthEvent } from "../src/observe/port.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { ok } from "../src/result.js";
import type { JwtSeam } from "../src/seams/jwt.js";
import { createSimpleWebAuthnSeam, type WebAuthnSeam } from "../src/seams/webauthn.js";
import type { OAuth2Entry } from "../src/social/oauth2.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { type StorageAdapter, StorageError } from "../src/storage/port.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { d1Like } from "./d1-like.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, sessionFor, tokenFromMail } from "./helpers.js";
import { codeFor, exchange, oauthHandle, REDIRECT, RESOURCE, SCOPES } from "./oauth-helpers.js";
import { operatorAuth } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import {
  APPLE,
  type FakeIdToken,
  fakeFetch,
  fakeJwt,
  GOOGLE,
  googleClaims,
  type TokenCall,
} from "./social-helpers.js";
import { SSO_APP, seedOrganization, ssoAuth, verifiedDomain } from "./sso/helpers.js";
import { samlConnection, samlSignIn, samlWorld } from "./sso/saml-helpers.js";
import { acmeWithSso, ssoSignIn, ssoSignInWorld } from "./sso/sign-in-helpers.js";
import {
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
  wrongFor,
} from "./totp-helpers.js";

/**
 * The default lines (plan 12h Task 3, spec 31 item 2). With no `observe`,
 * each fault event writes the line of today at once, word for word. One test
 * covers each fault entry of EVENTS and has the name of the event. Each test
 * causes the fault through the flow and asserts every argument. It uses the
 * setup of the test that held the line before the move.
 */

const SECRET = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The calls of `console.error`, with no output. */
const errors = () => vi.spyOn(console, "error").mockImplementation(() => {});
/** The calls of `console.warn`, with no output. */
const warns = () => vi.spyOn(console, "warn").mockImplementation(() => {});

/** The config of a deployment with no `observe`. A list of secret versions replaces the one secret. */
function input(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    baseURL: BASE_URL,
    ...(extra.secrets ? {} : { secret: SECRET }),
    trustedOrigins: [APP_ORIGIN],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    ...extra,
  };
}

/** A memory store whose `findOne` throws `thrown`: a store that is down. */
function downStore(thrown: unknown): StorageAdapter {
  return {
    ...createMemoryAdapter(),
    findOne: async () => {
      throw thrown;
    },
  };
}

/** A session read through the route, so the store's throw reaches the error boundary. */
const sessionRead = () =>
  new Request(`${BASE_URL}/auth/session`, {
    headers: { authorization: `Bearer ts_${"a".repeat(43)}` },
  });

/**
 * A request with the legacy session cookie and `method`. The cookie move
 * reads the store for each method, so a store that is down throws at the boundary.
 */
const legacyRead = (method: string) =>
  new Request(`${BASE_URL}/auth/session`, {
    method,
    headers: { cookie: `tempo_session=ts_${"a".repeat(43)}` },
  });

/** A magic link sign-in to its end, through the engine. */
async function magicSignIn(auth: ReturnType<typeof makeAuth>, email = EMAIL) {
  const sent = await requestMagicLink(auth.config, { email, ip: null });
  if (!sent.ok) throw new Error(sent.code);
  const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
  return verifyMagicLink(auth.config, { token, ip: null, userAgent: null });
}

/** A recording sink. */
function recording() {
  const batches: AuthEvent[][] = [];
  return {
    events: () => batches.flat(),
    sink: { write: (batch: readonly AuthEvent[]) => void batches.push([...batch]) },
  };
}

/** A 32-character secret of digits only: 106 bits by the estimate, under the warning bound of 120. */
const DIGITS = "01234567890123456789012345678901";
/** 43 characters of base64url from 32 random bytes. */
const B64 = "Qm9JbGFkV2l0aFNvbWVFbnRyb3B5MDEyMzQ1Njc4OUE";

describe("the observer lines (plan 12h)", () => {
  it("observe.wait_until_threw", async () => {
    const log = errors();
    const auth = createAuth(input());
    class Context {
      waitUntil(promise: Promise<unknown>): void {
        if (!(this instanceof Context)) throw new TypeError("Illegal invocation");
        void promise;
      }
    }
    const ctx = new Context();
    const res = await auth.handle(post("/auth/magic-link/request", { email: EMAIL }), {
      waitUntil: ctx.waitUntil,
    });
    expect(res.status).toBe(200);
    expect(log.mock.calls).toEqual([
      ["authtempo: waitUntil threw; the flush has no hook", "TypeError"],
    ]);
  });

  it("observe.wait_until_missing", async () => {
    const log = warns();
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    try {
      const sms = createRecordingSms();
      const auth = createAuth(
        input({ phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true } }),
      );
      const res = await auth.handle(post("/auth/phone/request", { phone: "+14155550100" }));
      expect(res.status).toBe(200);
      // The code went out before the answer.
      expect(sms.sent).toHaveLength(1);
      expect(log.mock.calls).toEqual([
        ["authtempo: no waitUntil on Workers; the answer waited for the work after it"],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the secret lines (plan 12b)", () => {
  it("secret.low_entropy", () => {
    const log = warns();
    resolveConfig(input({ secret: DIGITS }));
    resolveConfig(
      input({
        secrets: [
          { version: 2, value: B64 },
          { version: 1, value: DIGITS },
        ],
      }),
    );
    expect(log.mock.calls).toEqual([
      ["authtempo: secret has an estimated 106 bits of entropy; 120 or more is recommended"],
      ["authtempo: secrets[1] has an estimated 106 bits of entropy; 120 or more is recommended"],
    ]);
  });

  it("writes a construction line with or without a sink", () => {
    const construction = Object.entries(EVENTS as Record<string, EventSpec>).filter(
      ([, spec]) => spec.line?.construction,
    );
    expect(construction.map(([name]) => name)).toEqual(["secret.low_entropy"]);
    const log = warns();
    const { sink, events } = recording();
    createAuth(input({ secret: DIGITS }));
    createAuth(input({ secret: DIGITS, observe: { sink } }));
    const line =
      "authtempo: secret has an estimated 106 bits of entropy; 120 or more is recommended";
    expect(log.mock.calls).toEqual([[line], [line]]);
    expect(events()).toEqual([]);
  });

  it("secret.unknown_version", async () => {
    const storage = createMemoryAdapter();
    const old = makeAuth({ storage });
    const asked = await requestEmailOtp(old.config, { email: EMAIL, ip: null });
    expect(asked.ok).toBe(true);
    const code = /\b(\d{6})\b/.exec(old.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const [row] = await storage.findMany("verification", []);
    expect(row?.secretVersion).toBe(1);
    // The app drops version 1 of its secret: the code row of version 1 names a version it lacks.
    const later = resolveConfig(
      input({ storage, clock: old.clock, secrets: [{ version: 2, value: B64 }] }),
    );
    const log = errors();
    const r = await verifyEmailOtp(later, { email: EMAIL, code, ip: null, userAgent: null });
    expect(r).toMatchObject({ ok: false, code: "invalid_code" });
    expect(log.mock.calls).toEqual([
      ["authtempo: a stored value names secret version 1, which is not configured", row?.id],
    ]);
  });
});

describe("the router line (plan 11g)", () => {
  it("error.internal", async () => {
    const log = errors();
    const res = await createAuth(input({ storage: downStore(new TypeError("db down")) })).handle(
      sessionRead(),
    );
    expect(res.status).toBe(500);
    // The route template, never the raw path (ruling 1 point 3 of plan 12h).
    expect(log.mock.calls).toEqual([
      ["authtempo: unhandled error", "GET", "/session", "TypeError"],
    ]);
  });

  it("writes the same arguments as the call of today for each error class", async () => {
    const thrown: [unknown, string][] = [
      [new TypeError("x"), "TypeError"],
      [new StorageError("unique_violation", "user"), "StorageError"],
      [new DOMException("x", "AbortError"), "AbortError"],
      [new DOMException("x", "TimeoutError"), "TimeoutError"],
      // The appErrorName rule of the router since plan 9c: a name that does not end in Error is Error.
      [Object.assign(new Error("x"), { name: "JWTExpired" }), "Error"],
      ["x", "string"],
    ];
    for (const [value, name] of thrown) {
      const log = errors();
      const res = await createAuth(input({ storage: downStore(value) })).handle(sessionRead());
      expect(res.status).toBe(500);
      expect(log.mock.calls).toEqual([["authtempo: unhandled error", "GET", "/session", name]]);
      log.mockRestore();
    }
  });

  it("writes Error for an error name that is not an identifier", async () => {
    const leaky = Object.assign(new Error("x"), { name: "a@b.c leaked" });
    const log = errors();
    await createAuth(input({ storage: downStore(leaky) })).handle(sessionRead());
    expect(log.mock.calls).toEqual([["authtempo: unhandled error", "GET", "/session", "Error"]]);
    // The kind errorClass writes Error too: a passkey registration that a seam rejects with that name.
    log.mockClear();
    const p = await passkeyWorld({ verifyRegistration: leaky });
    expect(await p.register()).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(log.mock.calls).toEqual([["authtempo: passkey registration rejected", "Error"]]);
  });

  it("writes the method of the request, HEAD too", async () => {
    const log = errors();
    const res = await createAuth(input({ storage: downStore(new TypeError("db down")) })).handle(
      legacyRead("HEAD"),
    );
    expect(res.status).toBe(500);
    // The method of today, as 91c26417 wrote it (ruling 12 of plan 12h). HEAD /session is no route.
    expect(log.mock.calls).toEqual([
      ["authtempo: unhandled error", "HEAD", "unmatched", "TypeError"],
    ]);
  });

  it("scrubs a social client secret from a line", async () => {
    const clientSecret = "GOCSPX-scrub-0123456789abcdef";
    const log = errors();
    const auth = createAuth(
      input({
        storage: downStore(new TypeError("db down")),
        social: { google: { clientId: "gid", clientSecret } },
      }),
    );
    // A client sends the client secret as its method: the method kind keeps it, and the scrub writes ***.
    expect((await auth.handle(legacyRead(clientSecret))).status).toBe(500);
    expect(log.mock.calls).toEqual([
      ["authtempo: unhandled error", "***", "unmatched", "TypeError"],
    ]);
  });

  it("scrubs a social client secret from each event with a sink", async () => {
    const clientSecret = "GOCSPX-scrub-0123456789abcdef";
    const { sink, events } = recording();
    const auth = createAuth(
      input({
        storage: downStore(new TypeError("db down")),
        social: { google: { clientId: "gid", clientSecret } },
        observe: { sink },
      }),
    );
    // The same request as the line above: the method token is the secret.
    expect((await auth.handle(legacyRead(clientSecret))).status).toBe(500);
    await auth.observe.flush();
    const written = events();
    expect(written.map((e) => [e.name, e.method])).toEqual([
      ["error.internal", "***"],
      ["request", "***"],
    ]);
    expect(JSON.stringify(written)).not.toContain(clientSecret);
  });

  it("writes no line with a sink, and the sink gets the fault event", async () => {
    const log = errors();
    const { sink, events } = recording();
    const auth = createAuth(
      input({ storage: downStore(new TypeError("db down")), observe: { sink } }),
    );
    expect((await auth.handle(sessionRead())).status).toBe(500);
    expect(log).not.toHaveBeenCalled();
    await auth.observe.flush();
    const faults = events().filter((e) => e.name === "error.internal");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      level: "error",
      method: "GET",
      route: "GET /session",
      errorName: "TypeError",
    });
  });
});

/** A second keyring value: 32 characters, as the old version of a rotation. */
const OLD_SECRET = "fedcba9876543210fedcba9876543210";

/** An OpenID Connect entry with `clientSecret`, at the issuer of `name`. */
function oidcEntry(name: string, clientSecret: string) {
  return {
    name,
    label: name,
    issuer: `https://id.${name}.example`,
    clientId: `${name}-id`,
    clientSecret,
    endpoints: {
      authorizeUrl: `https://id.${name}.example/authorize`,
      tokenUrl: `https://id.${name}.example/token`,
      jwksUrl: `https://id.${name}.example/jwks`,
    },
  };
}

/** An OAuth 2.0 entry with `clientSecret`, at the host of `name`. */
function oauth2Entry(name: string, clientSecret: string): OAuth2Entry {
  return {
    name,
    label: name,
    authorizeUrl: `https://${name}.example/authorize`,
    tokenUrl: `https://${name}.example/token`,
    clientId: `${name}-id`,
    clientSecret,
    scope: "email",
    userinfo: async () => ({
      subject: "1",
      email: null,
      emailVerified: false,
      name: null,
      image: null,
    }),
  };
}

describe("the scrub sources (plan 12h)", () => {
  /**
   * One row for each secret source of the config. The secret of the row is
   * the method token of a request, so the event carries it unless the scrub
   * list holds that source. The oidc and oauth2 rows put the secret in the
   * second entry, so a scrub of the first entry alone fails. The config reads
   * the Apple private key only at a sign-in, so a token value is a key it takes.
   */
  const ROWS: Array<[string, string, Partial<AuthConfig>]> = [
    ["the current keyring value", SECRET, {}],
    [
      "an old keyring value",
      OLD_SECRET,
      {
        secrets: [
          { version: 1, value: OLD_SECRET },
          { version: 2, value: SECRET },
        ],
      },
    ],
    [
      "the google client secret",
      "GOCSPX-row-google-0123456789",
      { social: { google: { clientId: "g", clientSecret: "GOCSPX-row-google-0123456789" } } },
    ],
    [
      "the github client secret",
      "gh-row-github-0123456789abcdef",
      { social: { github: { clientId: "h", clientSecret: "gh-row-github-0123456789abcdef" } } },
    ],
    [
      "the linkedin client secret",
      "li-row-linkedin-0123456789abc",
      { social: { linkedin: { clientId: "l", clientSecret: "li-row-linkedin-0123456789abc" } } },
    ],
    [
      "the microsoft client secret",
      "ms-row-microsoft-0123456789ab",
      {
        social: {
          microsoft: {
            clientId: "m",
            clientSecret: "ms-row-microsoft-0123456789ab",
            tenant: "common",
          },
        },
      },
    ],
    [
      "the discord client secret",
      "dc-row-discord-0123456789abcd",
      { social: { discord: { clientId: "d", clientSecret: "dc-row-discord-0123456789abcd" } } },
    ],
    [
      "the gitlab client secret",
      "gl-row-gitlab-0123456789abcde",
      { social: { gitlab: { clientId: "gl", clientSecret: "gl-row-gitlab-0123456789abcde" } } },
    ],
    [
      "the slack client secret",
      "sl-row-slack-0123456789abcdef",
      { social: { slack: { clientId: "sl", clientSecret: "sl-row-slack-0123456789abcdef" } } },
    ],
    [
      "the twitter client secret",
      "x-row-twitter-0123456789abcde",
      { social: { twitter: { clientId: "x", clientSecret: "x-row-twitter-0123456789abcde" } } },
    ],
    [
      "the facebook client secret",
      "fb-row-facebook-0123456789abc",
      { social: { facebook: { clientId: "f", clientSecret: "fb-row-facebook-0123456789abc" } } },
    ],
    [
      "the apple private key",
      "apple-row-key-0123456789abcdef",
      {
        social: {
          apple: {
            clientId: "a",
            teamId: "T",
            keyId: "K",
            privateKey: "apple-row-key-0123456789abcdef",
          },
        },
      },
    ],
    [
      "the client secret of the second oidc entry",
      "oidc-row-second-0123456789ab",
      {
        social: {
          oidc: [
            oidcEntry("one", "oidc-row-first-0123456789abc"),
            oidcEntry("two", "oidc-row-second-0123456789ab"),
          ],
        },
      },
    ],
    [
      "the client secret of the second oauth2 entry",
      "oauth2-row-second-0123456789",
      {
        social: {
          oauth2: [
            oauth2Entry("three", "oauth2-row-first-01234567890"),
            oauth2Entry("four", "oauth2-row-second-0123456789"),
          ],
        },
      },
    ],
  ];

  it.each(ROWS)("scrubs %s from each event and from the line", async (_source, secret, extra) => {
    const log = errors();
    const quiet = createAuth(input({ storage: downStore(new TypeError("db down")), ...extra }));
    expect((await quiet.handle(legacyRead(secret))).status).toBe(500);
    expect(log.mock.calls).toEqual([
      ["authtempo: unhandled error", "***", "unmatched", "TypeError"],
    ]);
    const { sink, events } = recording();
    const auth = createAuth(
      input({ storage: downStore(new TypeError("db down")), ...extra, observe: { sink } }),
    );
    expect((await auth.handle(legacyRead(secret))).status).toBe(500);
    await auth.observe.flush();
    const written = events();
    expect(written.map((e) => [e.name, e.method])).toEqual([
      ["error.internal", "***"],
      ["request", "***"],
    ]);
    expect(JSON.stringify(written)).not.toContain(secret);
  });

  it("holds the scrub list to each source of the config", () => {
    // The event recorder of the suite reads secretValues as its deny list, so only this literal list can catch a lost source.
    const social: AuthConfig["social"] = {
      google: { clientId: "g", clientSecret: "list-google-secret" },
      github: { clientId: "h", clientSecret: "list-github-secret" },
      linkedin: { clientId: "l", clientSecret: "list-linkedin-secret" },
      microsoft: { clientId: "m", clientSecret: "list-microsoft-secret", tenant: "common" },
      discord: { clientId: "d", clientSecret: "list-discord-secret" },
      gitlab: { clientId: "gl", clientSecret: "list-gitlab-secret" },
      slack: { clientId: "sl", clientSecret: "list-slack-secret" },
      twitter: { clientId: "x", clientSecret: "list-twitter-secret" },
      facebook: { clientId: "f", clientSecret: "list-facebook-secret" },
      apple: { clientId: "a", teamId: "T", keyId: "K", privateKey: "list-apple-key" },
      oidc: [oidcEntry("one", "list-oidc-one"), oidcEntry("two", "list-oidc-two")],
      oauth2: [oauth2Entry("three", "list-oauth2-one"), oauth2Entry("four", "list-oauth2-two")],
    };
    const secrets = [
      { version: 1, value: OLD_SECRET },
      { version: 2, value: SECRET },
    ];
    const { keyring } = resolveConfig(input({ secrets, social }));
    expect([...secretValues(keyring, social)].sort()).toEqual([
      "0123456789abcdef0123456789abcdef",
      "fedcba9876543210fedcba9876543210",
      "list-apple-key",
      "list-discord-secret",
      "list-facebook-secret",
      "list-github-secret",
      "list-gitlab-secret",
      "list-google-secret",
      "list-linkedin-secret",
      "list-microsoft-secret",
      "list-oauth2-one",
      "list-oauth2-two",
      "list-oidc-one",
      "list-oidc-two",
      "list-slack-secret",
      "list-twitter-secret",
    ]);
  });
});

describe("the captcha lines (plan 12b)", () => {
  const port = (answer: "unavailable" | "throw") => ({
    async verify() {
      if (answer === "throw") throw new Error("down");
      return answer;
    },
  });
  const ask = (captcha: NonNullable<AuthConfig["captcha"]>) =>
    createAuth(input({ captcha })).handle(
      new Request(`${BASE_URL}/auth/magic-link/request`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: APP_ORIGIN,
          "x-captcha-response": "tok",
        },
        body: JSON.stringify({ email: EMAIL }),
      }),
    );

  it("captcha.port_threw", async () => {
    const log = errors();
    expect((await ask({ port: port("throw") })).status).toBe(200);
    expect(log.mock.calls).toEqual([
      ["authtempo: the captcha port threw", "magic-link-request", "Error"],
      ["authtempo: the captcha did not answer", "magic-link-request"],
    ]);
  });

  it("captcha.no_answer", async () => {
    const log = errors();
    expect((await ask({ port: port("unavailable") })).status).toBe(200);
    expect(log.mock.calls).toEqual([
      ["authtempo: the captcha did not answer", "magic-link-request"],
    ]);
  });
});

describe("the SMS lines (plan 12i)", () => {
  it("sms.port_threw", async () => {
    const log = errors();
    const config = resolveConfig(
      input({
        phone: {
          sms: {
            send: async ({ to }) => {
              throw new Error(`down for ${to}`);
            },
          },
          regions: ["+1"],
          isolateLimiter: "allow",
        },
      }),
    );
    const to = "+14155550100";
    expect(
      await sendPhoneCode(config, { purpose: "phone-otp", identifier: to, to, data: {} }),
    ).toBe("unavailable");
    expect(log.mock.calls).toEqual([["authtempo: the SMS port threw", "Error"]]);
  });

  it("sms.not_sent", async () => {
    const log = errors();
    const sms = { send: async () => "unavailable" as const };
    const config = resolveConfig(
      input({
        phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true, dailyCap: 1 },
      }),
    );
    // The route hands the send to `after`: the answer is sent, and the line tells what failed.
    const ask = async (phone: string) => {
      const after: Promise<unknown>[] = [];
      const answer = await requestPhone(config, { phone, ip: null }, (w) => void after.push(w));
      await Promise.all(after);
      return answer;
    };
    expect(await ask("+14155550100")).toEqual({ ok: true, value: { sent: true } });
    expect(await ask("+14155550101")).toEqual({ ok: true, value: { sent: true } });
    expect(log.mock.calls).toEqual([
      ["authtempo: an SMS after the answer was not sent", "unavailable"],
      ["authtempo: an SMS after the answer was not sent", "capped"],
    ]);
  });
});

describe("the hook lines (plan 9d)", () => {
  const signUp = (auth: ReturnType<typeof totpAuth>) =>
    passwordSignUp(auth.config, { email: EMAIL, password: PASSWORD, ip: null, userAgent: null });

  it("hook.copy_failed", async () => {
    const log = errors();
    const auth = totpAuth();
    const hook = vi.fn();
    // An event that structuredClone refuses: core builds the event, so this is a fault of core.
    await expect(
      runBefore(auth.config.observe, "organization.beforeCreate", hook, { f: () => 1 }),
    ).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      ["authtempo: hook event copy failed", "organization.beforeCreate", "DataCloneError"],
    ]);
  });

  it("hook.before_failed", async () => {
    const log = errors();
    const auth = totpAuth({
      hooks: {
        user: {
          beforeCreate: () => {
            throw new TypeError("row 42 of the tenant table");
          },
        },
      },
    });
    expect(await signUp(auth)).toMatchObject({ ok: false, code: "hook_failed" });
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "user.beforeCreate", "TypeError"],
    ]);
  });

  it("hook.after_failed", async () => {
    const log = errors();
    const auth = totpAuth({
      hooks: {
        user: {
          afterCreate: () => {
            throw new RangeError("tenant store down");
          },
        },
      },
    });
    expect((await signUp(auth)).ok).toBe(true);
    const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "user.afterCreate", user?.id, "RangeError"],
    ]);
  });

  it("user.patch_refused", async () => {
    const log = errors();
    const auth = totpAuth({
      hooks: { user: { beforeCreate: () => ({ email: "other@example.com" }) as never } },
    });
    expect(await signUp(auth)).toMatchObject({ ok: false, code: "hook_failed" });
    expect(log.mock.calls).toEqual([
      ["authtempo: user patch refused", "a field other than name and image"],
    ]);
  });

  it("session.patch_refused", async () => {
    const answers: [unknown, string][] = [
      [{ userId: "someone-else" }, "the field userId"],
      [{ ip: 5 }, "an ip that is not a string or null"],
      [[1], "a value that is not an object"],
    ];
    for (const [patch, what] of answers) {
      const auth = makeAuth({ hooks: { session: { beforeCreate: () => patch as never } } });
      const log = errors();
      expect(await magicSignIn(auth)).toMatchObject({ ok: false, code: "hook_failed" });
      expect(log.mock.calls).toEqual([["authtempo: session patch refused", what]]);
      log.mockRestore();
    }
  });
});

const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };

/**
 * A verified user with a password, a soft authenticator, and a passkey
 * config. A seam method named in `throws` throws that value, as a seam
 * throws on a bad ceremony.
 */
async function passkeyWorld(
  throws: { verifyRegistration?: unknown; verifyAuthentication?: unknown } = {},
) {
  const seam = createSimpleWebAuthnSeam();
  const webauthn: WebAuthnSeam = {
    ...seam,
    verifyRegistration: async (i) => {
      if ("verifyRegistration" in throws) throw throws.verifyRegistration;
      return seam.verifyRegistration(i);
    },
    verifyAuthentication: async (i) => {
      if ("verifyAuthentication" in throws) throw throws.verifyAuthentication;
      return seam.verifyAuthentication(i);
    },
  };
  const auth = totpAuth({ passkey: RP, webauthn });
  const s = await verifiedSession(auth);
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
  return {
    auth,
    session: s,
    soft,
    async register(user = s.user, authenticator = soft) {
      const options = await passkeyRegistrationOptions(auth.config, {
        session: await sessionFor(auth.config, user),
      });
      if (!options.ok) throw new Error(options.code);
      return verifyPasskeyRegistration(auth.config, {
        session: await sessionFor(auth.config, user),
        response: await authenticator.register(options.value.challenge),
      });
    },
    async signIn() {
      const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
      if (!options.ok) throw new Error(options.code);
      return verifyPasskeyAuthentication(auth.config, {
        response: await soft.authenticate(options.value.challenge),
        ip: null,
        userAgent: null,
      });
    },
  };
}

/**
 * Another request writes the user row before each of the next `times` user
 * updates inside a transaction. Thus each compare of the flow matches no row.
 */
function raceUserWrites(storage: StorageAdapter, userId: string, times = 5) {
  const original = storage.transaction.bind(storage);
  const byId = [{ field: "id" as const, op: "eq" as const, value: userId }];
  let left = times;
  (storage as { transaction: StorageAdapter["transaction"] }).transaction = ((fn) =>
    original((tx) =>
      fn({
        ...tx,
        update: async (model, where, data) => {
          if (model === "user" && left > 0) {
            left--;
            const row = await storage.findOne("user", byId);
            if (row)
              await storage.update("user", byId, {
                name: `Other ${left}`,
                updatedAt: new Date(row.updatedAt.getTime() + 1),
              });
          }
          return tx.update(model, where, data);
        },
      }),
    )) as StorageAdapter["transaction"];
}

/** A store whose update never matches a row, as the count loops of today's tests use. */
function neverMatches(storage: StorageAdapter): StorageAdapter {
  let updates = 0;
  return {
    ...storage,
    update: async () => {
      // A guard: a loop with no bound fails here instead of hanging.
      if (++updates > 100) throw new Error("the loop did not stop");
      return 0;
    },
  };
}

describe("the passkey lines (plan 4)", () => {
  it("passkey.registration_rejected", async () => {
    const log = errors();
    const p = await passkeyWorld({ verifyRegistration: new TypeError("bad attestation") });
    expect(await p.register()).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(log.mock.calls).toEqual([["authtempo: passkey registration rejected", "TypeError"]]);
  });

  it("passkey.already_registered", async () => {
    const log = errors();
    const p = await passkeyWorld();
    expect((await p.register()).ok).toBe(true);
    // The same authenticator for a second user: the credential id is unique across users.
    const other = await verifiedSession(p.auth, "bob@example.com");
    expect(await p.register(other.user)).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(log.mock.calls).toEqual([["authtempo: passkey credential already registered"]]);
  });

  it("passkey.authentication_rejected", async () => {
    const log = errors();
    const p = await passkeyWorld({ verifyAuthentication: new RangeError("bad signature") });
    expect((await p.register()).ok).toBe(true);
    expect(await p.signIn()).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(log.mock.calls).toEqual([["authtempo: passkey authentication rejected", "RangeError"]]);
  });

  it("passkey.counter_moved", async () => {
    const log = errors();
    const p = await passkeyWorld();
    expect((await p.register()).ok).toBe(true);
    // A parallel sign-in moves the stored counter after this one read it.
    const store = p.auth.storage;
    const update = store.update.bind(store);
    let raced = false;
    store.update = (async (model, where, data) => {
      if (model === "passkey" && !raced) {
        raced = true;
        const [row] = await store.findMany("passkey", []);
        if (row)
          await update("passkey", [{ field: "id", op: "eq", value: row.id }], {
            counter: row.counter + 1,
          });
      }
      return update(model, where, data);
    }) as StorageAdapter["update"];
    expect(await p.signIn()).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(log.mock.calls).toEqual([["authtempo: passkey counter moved"]]);
  });

  it("passkey.credential_id_too_long", async () => {
    const log = errors();
    const p = await passkeyWorld();
    // WebAuthn Level 3 bounds a credential id to 1023 bytes (ruling 7 of plan 12g).
    const long = await SoftAuthenticator.create({
      rpID: RP.rpID,
      origin: RP.origins[0] ?? "",
      credentialIdBytes: 1024,
    });
    expect(await p.register(p.session.user, long)).toMatchObject({
      ok: false,
      code: "passkey_failed",
    });
    expect(log.mock.calls).toEqual([["authtempo: passkey credential id over 1023 bytes"]]);
  });
});

describe("the gave-up lines (plans 12a and 12f)", () => {
  it("user.hold_gave_up", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    raceUserWrites(auth.storage, me.user.id);
    const log = errors();
    expect(await magicSignIn(auth)).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(log.mock.calls).toEqual([["authtempo: user hold gave up", me.user.id]]);
  });

  it("account.delete_gave_up", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    raceUserWrites(auth.storage, me.user.id);
    const log = errors();
    expect(await deleteAccount(auth.config, { session: me, ip: null, userAgent: null })).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(log.mock.calls).toEqual([["authtempo: account delete gave up", me.user.id]]);
  });

  it("credential.removal_gave_up", async () => {
    const p = await passkeyWorld();
    const added = await p.register();
    if (!added.ok) throw new Error(added.code);
    raceUserWrites(p.auth.storage, p.session.user.id);
    const log = errors();
    expect(
      await deletePasskey(p.auth.config, { user: p.session.user, id: added.value.id }),
    ).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(log.mock.calls).toEqual([["authtempo: credential removal gave up", p.session.user.id]]);
  });

  it("email_change.gave_up", async () => {
    let auth: ReturnType<typeof totpAuth> | null = null;
    // Another request writes the user row inside each round of the change.
    auth = totpAuth({
      hooks: {
        user: {
          beforeUpdate: async (e) => {
            if (!auth) return;
            await auth.storage.update("user", [{ field: "id", op: "eq", value: e.user.id }], {
              name: "Other",
              updatedAt: new Date(e.user.updatedAt.getTime() + 1),
            });
          },
        },
      },
    });
    const me = await verifiedSession(auth);
    const asked = await requestEmailChange(auth.config, {
      session: me,
      newEmail: "new@example.com",
    });
    if (!asked.ok) throw new Error(asked.code);
    const mail = auth.mail.findLast((m) => m.to === "new@example.com");
    const log = errors();
    expect(
      await confirmEmailChange(auth.config, {
        token: tokenFromMail(mail?.text ?? ""),
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(log.mock.calls).toEqual([["authtempo: email change gave up", me.user.id]]);
  });

  it("profile.update_gave_up", async () => {
    let auth: ReturnType<typeof totpAuth> | null = null;
    auth = totpAuth({
      hooks: {
        user: {
          beforeUpdate: async (e) => {
            if (!auth) return;
            await auth.storage.update("user", [{ field: "id", op: "eq", value: e.user.id }], {
              name: "Other",
              updatedAt: new Date(e.user.updatedAt.getTime() + 1),
            });
          },
        },
      },
    });
    const me = await verifiedSession(auth);
    const log = errors();
    expect(await updateProfile(auth.config, { session: me, name: "Ada" })).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(log.mock.calls).toEqual([["authtempo: profile update gave up", me.user.id]]);
  });

  it("username.set_gave_up", async () => {
    let auth: ReturnType<typeof totpAuth> | null = null;
    auth = totpAuth({
      username: {},
      hooks: {
        user: {
          beforeUpdate: async (e) => {
            if (!auth) return;
            await auth.storage.update("user", [{ field: "id", op: "eq", value: e.user.id }], {
              name: "Other",
              updatedAt: new Date(e.user.updatedAt.getTime() + 1),
            });
          },
        },
      },
    });
    const me = await verifiedSession(auth);
    const log = errors();
    expect(
      await setUsername(auth.config, { session: me, username: "ada", ip: null, userAgent: null }),
    ).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(log.mock.calls).toEqual([["authtempo: username set gave up", me.user.id]]);
  });

  it("phone.set_gave_up", async () => {
    // A write lands on the row between each read and its compare-and-set.
    const sms = createRecordingSms();
    let auth: ReturnType<typeof totpAuth> | null = null;
    auth = totpAuth({
      phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
      hooks: {
        user: {
          beforeUpdate: async (e) => {
            if (!auth || e.via !== "phone") return;
            await auth.storage.update("user", [{ field: "id", op: "eq", value: e.user.id }], {
              name: "Other",
              updatedAt: new Date(e.user.updatedAt.getTime() + 1),
            });
          },
        },
      },
    });
    const me = await verifiedSession(auth);
    expect((await addPhone(auth.config, { session: me, phone: "+14155550100", ip: null })).ok).toBe(
      true,
    );
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    const log = errors();
    expect(
      await verifyAddPhone(auth.config, { session: me, code, ip: null, userAgent: null }),
    ).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(log.mock.calls).toEqual([["authtempo: phone set gave up", me.user.id]]);
  });

  it("operator.ban_write_gave_up", async () => {
    const auth = await operatorAuth();
    const target = await verifiedSession(auth, "target@example.com");
    raceUserWrites(auth.storage, target.user.id);
    const log = errors();
    expect(
      await banUser(auth.config, {
        actor: { kind: "app", name: "support-tool" },
        userId: target.user.id,
        reason: "abuse report 7",
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(log.mock.calls).toEqual([["authtempo: operator ban write gave up", target.user.id]]);
  });
});

describe("the count lines (plans 9e and 9f)", () => {
  it("email_code.count_gave_up", async () => {
    const auth = makeAuth();
    const asked = await requestEmailOtp(auth.config, { email: EMAIL, ip: null });
    if (!asked.ok) throw new Error(asked.code);
    const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const [row] = await auth.storage.findMany("verification", []);
    const log = errors();
    const r = await verifyEmailOtp(
      { ...auth.config, storage: neverMatches(auth.storage) },
      { email: EMAIL, code: code === "000000" ? "111111" : "000000", ip: null, userAgent: null },
    );
    expect(r).toEqual({ ok: false, code: "invalid_code", status: 400 });
    expect(log.mock.calls).toEqual([["authtempo: email code count gave up", row?.id]]);
  });

  it("second_factor.count_gave_up", async () => {
    const auth = totpAuth();
    const { secret } = await enrolled(auth);
    const signIn = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!signIn.ok || "token" in signIn.value) throw new Error("the sign-in answered no challenge");
    const [challenge] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
    ]);
    const right = await codeNow(auth, secret);
    const log = errors();
    const r = await verifyTwoFactor(
      { ...auth.config, storage: neverMatches(auth.storage) },
      { challenge: signIn.value.twoFactor.challenge, code: wrongFor(right), ip: null },
    );
    expect(r).toEqual({ ok: false, code: "invalid_code", status: 400 });
    expect(log.mock.calls).toEqual([
      ["authtempo: second-factor challenge count gave up", challenge?.id],
    ]);
  });

  it("backup_code.spend_gave_up", async () => {
    const auth = totpAuth();
    const { user, backupCodes } = await enrolled(auth);
    const [row] = await auth.storage.findMany("totp", []);
    const log = errors();
    expect(
      await disableTotpWithCode(
        { ...auth.config, storage: neverMatches(auth.storage) },
        { user, code: backupCodes[0] ?? "" },
      ),
    ).toEqual({ ok: false, code: "invalid_code", status: 400 });
    expect(log.mock.calls).toEqual([["authtempo: backup code spend gave up", row?.id]]);
  });

  it("backup_code.replace_gave_up", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    const [row] = await auth.storage.findMany("totp", []);
    const log = errors();
    expect(
      await regenerateBackupCodes(
        { ...auth.config, storage: neverMatches(auth.storage) },
        { userId: user.id },
      ),
    ).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(log.mock.calls).toEqual([["authtempo: backup code replacement gave up", row?.id]]);
  });
});

describe("the sealed value lines (plan 12b)", () => {
  /** A user with the factor on under version 1, and a second config over the same store. */
  async function moved(
    secrets: NonNullable<AuthConfig["secrets"]>,
    wrap?: (s: StorageAdapter) => StorageAdapter,
  ) {
    const auth = totpAuth();
    await enrolled(auth);
    const [row] = await auth.storage.findMany("totp", []);
    const storage = wrap ? wrap(auth.storage) : auth.storage;
    const config = resolveConfig(
      input({ storage, clock: auth.clock, secrets, password: { hash: FAST }, totp: {} }),
    );
    return { config, row };
  }
  const updateThrows = (model: string) => (s: StorageAdapter) => ({
    ...s,
    update: ((m, where, data) =>
      m === model
        ? Promise.reject(new Error("store down"))
        : s.update(m, where, data)) as StorageAdapter["update"],
  });

  it("totp.reseal_failed", async () => {
    const { config, row } = await moved(
      [
        { version: 2, value: B64 },
        { version: 1, value: SECRET },
      ],
      updateThrows("totp"),
    );
    const log = errors();
    expect(await rewrapSecrets(config)).toMatchObject({ ok: true, value: { failed: 1 } });
    expect(log.mock.calls).toEqual([
      ["authtempo: a TOTP secret reseal failed", row?.id, "Error"],
      [
        "authtempo: a sealed value did not move to the current secret; it did not open, or a concurrent write changed it first",
        "totp",
        row?.id,
        "version 1",
      ],
    ]);
  });

  it("secrets.rewrap_failed", async () => {
    // Version 1 holds another value than the one that sealed the row: the row does not open.
    const { config, row } = await moved([
      { version: 2, value: B64 },
      { version: 1, value: "another secret of 32 characters!" },
    ]);
    const log = errors();
    expect(await rewrapSecrets(config)).toMatchObject({ ok: true, value: { failed: 1 } });
    expect(log.mock.calls).toEqual([
      [
        "authtempo: a sealed value did not move to the current secret; it did not open, or a concurrent write changed it first",
        "totp",
        row?.id,
        "version 1",
      ],
    ]);
  });
});

describe("the signing key lines (plans 9b and 12b)", () => {
  async function minted(extra: Partial<AuthConfig> = {}) {
    const auth = makeAuth(extra);
    const user = await auth.seedUser(EMAIL);
    const { session } = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
      proved: true,
      activeOrganizationId: null,
    });
    return { auth, input: { userId: user.id, sessionId: session.id } };
  }
  const kidOf = (token: string) => decodeJws(token)?.header.kid;

  it("jwt.key_unopened", async () => {
    const { auth, input: ids } = await minted();
    const first = await mintSessionJwt(auth.config, ids);
    if (!first.ok) throw new Error(first.code);
    const other = makeAuth({
      storage: auth.storage,
      clock: auth.clock,
      secret: "another secret of 32 characters!",
    });
    const log = errors();
    expect((await mintSessionJwt(other.config, ids)).ok).toBe(true);
    expect(log.mock.calls).toEqual([
      [
        "authtempo: a signing key does not open under this secret; it retires",
        kidOf(first.value.token),
      ],
    ]);
  });

  it("jwt.key_reseal_failed", async () => {
    const { auth, input: ids } = await minted();
    const first = await mintSessionJwt(auth.config, ids);
    if (!first.ok) throw new Error(first.code);
    const config = resolveConfig(
      input({
        storage: {
          ...auth.storage,
          update: ((m, where, data) =>
            m === "jwk"
              ? Promise.reject(new Error("store down"))
              : auth.storage.update(m, where, data)) as StorageAdapter["update"],
        },
        clock: auth.clock,
        secrets: [
          { version: 2, value: B64 },
          { version: 1, value: SECRET },
        ],
      }),
    );
    const log = errors();
    expect((await mintSessionJwt(config, ids)).ok).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: a signing key reseal failed", kidOf(first.value.token), "Error"],
    ]);
  });

  it("jwt.claims_not_object", async () => {
    const { auth, input: ids } = await minted({ jwtMint: { claims: () => 5 as never } });
    const log = errors();
    expect(await mintSessionJwt(auth.config, ids)).toMatchObject({
      ok: false,
      code: "hook_failed",
    });
    expect(log.mock.calls).toEqual([
      ["authtempo: jwtMint.claims answered a value that is not an object"],
    ]);
  });

  it("jwt.claims_threw", async () => {
    const { auth, input: ids } = await minted({
      jwtMint: {
        claims: () => {
          throw new SyntaxError("bad claims");
        },
      },
    });
    const log = errors();
    expect(await mintSessionJwt(auth.config, ids)).toMatchObject({
      ok: false,
      code: "hook_failed",
    });
    expect(log.mock.calls).toEqual([["authtempo: jwtMint.claims threw", "SyntaxError"]]);
  });
});

describe("the notice line (plan 12a)", () => {
  it("notice.mail_failed", async () => {
    const auth = totpAuth({
      account: {
        notices: {
          mail: () => {
            throw new TypeError("no template");
          },
        },
      },
    });
    const me = await verifiedSession(auth);
    const log = errors();
    const changed = await changePassword(auth.config, {
      session: me,
      currentPassword: PASSWORD,
      newPassword: "a new horse battery",
      ip: null,
      userAgent: null,
    });
    expect(changed.ok).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: notice mail failed", "password_changed", "TypeError"],
    ]);
  });
});

describe("the claim line (plan 12o)", () => {
  it("claim.mail_failed", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const up = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const confirm = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    const asked = await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    if (!asked.ok) throw new Error(asked.code);
    const link = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    // The D1 view: at the lease of the magic link's claim (plan 12p), the
    // verify link claims the user first. The view has a query limit, so the
    // magic link answers 409.
    const view = d1Like(auth.config);
    view.storage.queryLimitPerInvocation = true;
    const original = view.storage.transaction.bind(view.storage);
    let armed = true;
    view.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      original((tx) =>
        fn({
          ...tx,
          create: async (m, d) => {
            if (
              armed &&
              m === "verification" &&
              (d as { purpose?: unknown }).purpose === "claim-lease"
            ) {
              armed = false;
              const won = await verifyPasswordEmail(view, {
                token: confirm,
                ip: null,
                userAgent: null,
              });
              if (!won.ok) throw new Error(won.code);
            }
            return tx.create(m, d);
          },
        }),
      );
    const log = errors();
    const failing = {
      ...view,
      mail: {
        ...view.mail,
        send: async () => {
          throw new TypeError("mail down");
        },
      },
    };
    const lost = await verifyMagicLink(failing, { token: link, ip: null, userAgent: null });
    expect(lost).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(armed).toBe(false);
    expect(log.mock.calls).toEqual([["authtempo: claim mail failed", "magic_link", "TypeError"]]);
  });
});

/** A Google flow to its callback, over a fake token endpoint and a fake jwt seam. */
function googleWorld(answer: (call: TokenCall) => Response | Promise<Response>, jwt?: JwtSeam) {
  const tokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = fakeFetch(answer);
  const auth = makeAuth({
    social: { google: GOOGLE, apple: APPLE, fetch: fetchFn },
    jwt: jwt ?? fakeJwt(tokens),
  });
  return {
    auth,
    tokens,
    async callback(provider: "google" | "apple" = "google", nonce?: string) {
      const r = await startSocial(auth.config, { provider, next: "/home", ip: null });
      if (!r.ok) throw new Error(r.code);
      const url = new URL(r.value.location);
      tokens["idtok-default"] = googleClaims(nonce ?? url.searchParams.get("nonce") ?? "", {});
      return completeSocial(auth.config, {
        provider,
        state: url.searchParams.get("state") ?? "",
        code: "c",
        error: null,
        bindToken: r.value.bindToken,
        ip: null,
        userAgent: null,
      });
    },
  };
}
const idToken = () => Response.json({ id_token: "idtok-default", access_token: "at" });

/** An oauth2 provider `acme` whose user info function is `userinfo`. */
function acmeWorld(userinfo: OAuth2Entry["userinfo"]) {
  const { fetchFn } = fakeFetch(() =>
    Response.json({ access_token: "acme-at", token_type: "bearer" }),
  );
  const auth = makeAuth({
    social: {
      oauth2: [
        {
          name: "acme",
          label: "Continue with Acme",
          authorizeUrl: "https://id.acme.example/oauth/authorize",
          tokenUrl: "https://id.acme.example/oauth/token",
          clientId: "acme-id",
          clientSecret: "acme-secret",
          scope: "user email",
          userinfo,
        },
      ],
      fetch: fetchFn,
    },
  });
  return {
    async callback() {
      const r = await startSocial(auth.config, { provider: "acme", next: "/home", ip: null });
      if (!r.ok) throw new Error(r.code);
      const url = new URL(r.value.location);
      return completeSocial(auth.config, {
        provider: "acme",
        state: url.searchParams.get("state") ?? "",
        code: "c",
        error: null,
        bindToken: r.value.bindToken,
        ip: null,
        userAgent: null,
      });
    },
  };
}

describe("the social lines (plans 3 and 9c)", () => {
  it("social.client_secret_failed", async () => {
    // Apple's client secret is a JWT that the jwt seam signs: a seam that throws fails it.
    const jwt: JwtSeam = {
      ...fakeJwt({}),
      signES256: async () => {
        throw new TypeError("no key");
      },
    };
    const w = googleWorld(idToken, jwt);
    const log = errors();
    expect(await w.callback("apple")).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([
      ["authtempo: social client secret failed", "apple", "TypeError"],
    ]);
  });

  it("social.token_request_failed", async () => {
    const w = googleWorld(() => {
      throw new TypeError("network down");
    });
    const log = errors();
    expect(await w.callback()).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([
      ["authtempo: social token request failed", "google", "TypeError"],
    ]);
  });

  it("social.token_status", async () => {
    const w = googleWorld(() => new Response("down", { status: 502 }));
    const log = errors();
    expect(await w.callback()).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([["authtempo: social token endpoint answered", "google", 502]]);
  });

  it("social.token_missing", async () => {
    const w = googleWorld(() => Response.json({ error: "bad_verification_code" }));
    const log = errors();
    expect(await w.callback()).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([["authtempo: social token answer has no token", "google"]]);
  });

  it("social.id_token_rejected", async () => {
    // The fake seam knows no token of this name, and throws as jose does.
    const w = googleWorld(() => Response.json({ id_token: "unknown", access_token: "at" }));
    const log = errors();
    expect(await w.callback()).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([["authtempo: social id token rejected", "google", "Error"]]);
  });

  it("social.nonce_mismatch", async () => {
    const w = googleWorld(idToken);
    const log = errors();
    expect(await w.callback("google", "another nonce")).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(log.mock.calls).toEqual([["authtempo: social nonce mismatch", "google"]]);
  });

  it("social.user_info_failed", async () => {
    const w = acmeWorld(async () => {
      throw new URIError("boom");
    });
    const log = errors();
    expect(await w.callback()).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([["authtempo: social user info failed", "acme", "URIError"]]);
  });

  it("social.bad_subject", async () => {
    const w = acmeWorld(async () => ({
      subject: "acme\n7",
      email: EMAIL,
      emailVerified: true,
      name: null,
      image: null,
    }));
    const log = errors();
    expect(await w.callback()).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([["authtempo: social user info has a bad subject", "acme"]]);
  });
});

describe("the oidc discovery lines (plan 9c)", () => {
  const ISSUER = "https://login.acme.example/tenant-1/v2.0";
  const DOC = {
    issuer: ISSUER,
    authorization_endpoint: "https://login.acme.example/tenant-1/oauth2/v2.0/authorize",
    token_endpoint: "https://login.acme.example/tenant-1/oauth2/v2.0/token",
    jwks_uri: "https://login.acme.example/tenant-1/discovery/v2.0/keys",
  };
  /** A start of the `entra` provider, whose discovery document answers `doc`. */
  async function start(doc: () => Response) {
    const { fetchFn } = fakeFetch(doc);
    const auth = makeAuth({
      social: {
        oidc: [
          {
            name: "entra",
            label: "Continue with Microsoft",
            issuer: ISSUER,
            clientId: "entra-id",
            clientSecret: "entra-secret",
          },
        ],
        fetch: fetchFn,
      },
    });
    return startSocial(auth.config, { provider: "entra", next: "/home", ip: null });
  }

  it("oidc.discovery_failed", async () => {
    const log = errors();
    expect(
      await start(() => {
        throw new TypeError("network");
      }),
    ).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([
      ["authtempo: oidc discovery request failed", "entra", "TypeError"],
    ]);
  });

  it("oidc.discovery_status", async () => {
    const log = errors();
    expect(await start(() => new Response("down", { status: 503 }))).toMatchObject({ ok: false });
    expect(log.mock.calls).toEqual([["authtempo: oidc discovery answered", "entra", 503]]);
  });

  it("oidc.discovery_not_json", async () => {
    const log = errors();
    expect(await start(() => new Response("not json", { status: 200 }))).toMatchObject({
      ok: false,
    });
    expect(log.mock.calls).toEqual([["authtempo: oidc discovery is not JSON", "entra"]]);
  });

  it("oidc.issuer_mismatch", async () => {
    const log = errors();
    expect(
      await start(() => Response.json({ ...DOC, issuer: "https://login.other.example/" })),
    ).toMatchObject({ ok: false });
    expect(log.mock.calls).toEqual([["authtempo: oidc discovery issuer mismatch", "entra"]]);
  });

  it("oidc.endpoint_missing", async () => {
    const log = errors();
    expect(await start(() => Response.json({ ...DOC, jwks_uri: undefined }))).toMatchObject({
      ok: false,
    });
    expect(log.mock.calls).toEqual([["authtempo: oidc discovery lacks an endpoint", "entra"]]);
  });
});

const DOC_URL = "https://client.example.com/oauth/metadata.json";
/** The client reference of DOC_URL: `cimd:` and the first 32 hex of its SHA-256 (shasum -a 256). */
const DOC_REF = "cimd:31c67c351206ab0ec26c672384aa30a2";
const DOC = {
  client_id: DOC_URL,
  client_name: "Example key client",
  redirect_uris: ["https://client.example.com/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/** An engine view with the provider on, whose `oauth.fetch` answers `answer`. */
function provider(answer: (url: string) => Response | Promise<Response>, base = makeAuth()) {
  return makeAuth({
    // The store of the base's config: makeAuth answers its own store only when no store is given.
    storage: base.config.storage,
    clock: base.clock,
    oauth: {
      resources: [RESOURCE],
      scopes: SCOPES,
      registration: { cimd: true, dynamic: true },
      fetch: (async (input: RequestInfo | URL) => answer(String(input))) as typeof fetch,
    },
  });
}

describe("the client metadata lines (plans 9g and 12e)", () => {
  it("oauth.client_metadata_refused", async () => {
    const refusals: [Response, string][] = [
      [new Response(null, { status: 404 }), "status 404"],
      [
        Response.json({ ...DOC, client_id: "https://client.example.com/other.json" }),
        "client_id is not the document URL",
      ],
      [Response.json({ ...DOC, client_secret: "s" }), "client_secret is present (-02 section 4.1)"],
      [Response.json({ ...DOC, client_name: 5 }), "client_name"],
      [
        new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
        "not application/json",
      ],
    ];
    for (const [res, why] of refusals) {
      const log = errors();
      expect(await fetchCimd(provider(() => res).config, DOC_URL)).toBeNull();
      expect(log.mock.calls).toEqual([["authtempo: client metadata document refused", why]]);
      log.mockRestore();
    }
  });

  it("oauth.client_metadata_member_dropped", async () => {
    const log = warns();
    const doc = { ...DOC, grant_types: ["authorization_code", "password"] };
    expect(await fetchCimd(provider(() => Response.json(doc)).config, DOC_URL)).not.toBeNull();
    expect(log.mock.calls).toEqual([["authtempo: client metadata member dropped", "grant_types"]]);
  });

  it("oauth.client_key_set_refused", async () => {
    const answers: [Response, string][] = [
      [new Response(null, { status: 500 }), "status 500"],
      [Response.json({ nokeys: [] }), "no keys array"],
    ];
    for (const [res, why] of answers) {
      const log = errors();
      const p = provider(() => res);
      expect(
        await fetchClientJwks(
          p.config,
          { jwks: null, jwksUri: "https://client.example.com/jwks.json" },
          { kid: null },
        ),
      ).toBeNull();
      expect(log.mock.calls).toEqual([["authtempo: client key set refused", why]]);
      log.mockRestore();
    }
  });

  it("oauth.client_auth_dropped", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k-1" };
    const keyDoc = { ...DOC, token_endpoint_auth_method: "private_key_jwt", jwks: { keys: [jwk] } };
    // Instance A reads the document with a key; instance B, on the same store, reads it with none.
    const a = provider(() => Response.json(keyDoc));
    expect(await findClient(a.config, DOC_URL)).toMatchObject({ authMethod: "private_key_jwt" });
    const b = provider(() => Response.json(DOC), a);
    const log = errors();
    expect(await findClient(b.config, DOC_URL)).toMatchObject({ authMethod: "none" });
    // The client reference, never the document URL (ruling 1 point 2 of plan 12h).
    expect(log.mock.calls).toEqual([
      [
        "authtempo: client metadata document dropped its client auth; refresh tokens and device codes revoked",
        DOC_REF,
        "private_key_jwt",
        "none",
      ],
    ]);
  });

  it("oauth.refresh_delete_failed", async () => {
    const outer = oauthHandle();
    let revokeFirst: (() => Promise<unknown>) | null = null;
    let failDelete = false;
    // A grant revoke lands between the write of the refresh row and its check, and the cleanup delete throws.
    const storage = new Proxy(outer.storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if ((key !== "create" && key !== "delete") || typeof value !== "function") return value;
        return async (model: string, ...args: unknown[]) => {
          if (key === "create" && model === "oauthToken" && revokeFirst) {
            const run = revokeFirst;
            revokeFirst = null;
            await run();
            failDelete = true;
          } else if (key === "delete" && model === "oauthToken" && failDelete) {
            failDelete = false;
            throw new Error("storage down");
          }
          return (value as (...a: unknown[]) => Promise<unknown>).call(target, model, ...args);
        };
      },
    }) as StorageAdapter;
    const h = { ...oauthHandle({ storage, clock: outer.clock }), storage: outer.storage };
    const c = await codeFor(h);
    revokeFirst = () => revokeGrant(h.config, { userId: c.user.id, clientId: c.clientId });
    const log = errors();
    expect((await h.auth.handle(exchange(c.code, c.clientId, c.verifier))).status).toBe(400);
    const [row] = await h.storage.findMany("oauthToken", []);
    expect(log.mock.calls).toEqual([
      ["authtempo: the delete of a refresh row in a revoked grant failed", row?.id, "Error"],
    ]);
  });
});

describe("the back-channel logout lines (plan 12e)", () => {
  const BC = "https://client.example.com/backchannel";
  /** A user, a client with a back-channel URI, and one due outbox row of them. */
  async function outboxOf(attempts = 0, bcStatus = 200) {
    const h = oauthHandle({
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: false, dynamic: true },
        fetch: (async () => new Response(null, { status: bcStatus })) as typeof fetch,
      },
    });
    const res = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        client_name: "Logout client",
        backchannel_logout_uri: BC,
      }),
    );
    if (res.status !== 201) throw new Error(`register answered ${res.status}`);
    const clientId = ((await res.json()) as { client_id: string }).client_id;
    const user = await h.storage.create("user", {
      id: "u-bc",
      email: EMAIL,
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    });
    // The row that a session end writes for a linked client (plan 12e Task 16).
    await h.storage.create("oauthLogout", {
      id: "lo-1",
      clientId,
      userId: user.id,
      sessionId: "s-1",
      sid: "sid-1",
      attempts,
      nextAttemptAt: h.clock.now(),
      issuer: null,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    });
    return { h, clientId, userId: user.id };
  }

  it("oauth.logout_dropped_attempts", async () => {
    const { h, clientId, userId } = await outboxOf(6);
    const log = errors();
    await deliverLogouts(h.config, userId);
    expect(log.mock.calls).toEqual([
      ["authtempo: a back-channel logout is dropped after 6 attempts", clientId],
    ]);
  });

  it("oauth.logout_refused", async () => {
    const { h, clientId, userId } = await outboxOf(0, 400);
    const log = errors();
    await deliverLogouts(h.config, userId);
    expect(log.mock.calls).toEqual([
      ["authtempo: a back-channel logout is dropped: the client refused it", clientId, 400],
    ]);
  });

  it("oauth.logout_attempt_failed", async () => {
    const { h, userId } = await outboxOf();
    const findOne = h.storage.findOne.bind(h.storage);
    h.storage.findOne = ((model, where) =>
      model === "oauthClient"
        ? Promise.reject(new RangeError("store down"))
        : findOne(model, where)) as StorageAdapter["findOne"];
    const log = errors();
    await deliverLogouts(h.config, userId);
    expect(log.mock.calls).toEqual([
      ["authtempo: a back-channel logout attempt failed", "RangeError"],
    ]);
  });

  it("oauth.logout_delivery_failed", async () => {
    const { h, userId } = await outboxOf();
    const findMany = h.storage.findMany.bind(h.storage);
    h.storage.findMany = ((model, where, opts) =>
      model === "oauthLogout"
        ? Promise.reject(new EvalError("store down"))
        : findMany(model, where, opts)) as StorageAdapter["findMany"];
    const log = errors();
    await deliverLogouts(h.config, userId);
    expect(log.mock.calls).toEqual([
      ["authtempo: the back-channel logout delivery failed", "EvalError"],
    ]);
  });
});

describe("the sweep lines (plans 12e and 12f)", () => {
  /** A sweep whose store throws at the read of `model`. */
  async function sweepWithout(model: string) {
    const base = makeAuth();
    const findMany = base.storage.findMany.bind(base.storage);
    base.storage.findMany = ((m, where, opts) =>
      m === model
        ? Promise.reject(new Error("too many queries"))
        : findMany(m, where, opts)) as StorageAdapter["findMany"];
    const p = provider(() => new Response(null, { status: 200 }), base);
    const log = errors();
    await sweepExpired(p.config);
    return log.mock.calls;
  }

  it("sweep.link_stopped", async () => {
    expect(await sweepWithout("oauthSessionClient")).toEqual([
      ["authtempo: the sweep link step stopped", "Error"],
    ]);
  });

  it("sweep.outbox_stopped", async () => {
    expect(await sweepWithout("oauthLogout")).toEqual([
      ["authtempo: the sweep outbox step stopped", "Error"],
    ]);
  });

  it("sweep.pending_end_stopped", async () => {
    // The pending-end rows of a ban or a revoke: a store limit at their read stops the step.
    const base = makeAuth();
    const findMany = base.storage.findMany.bind(base.storage);
    base.storage.findMany = ((m, where, opts) =>
      // One read takes the pending rows of plan 12d too, so the purpose is a list (ruling 78).
      m === "verification" &&
      where.some(
        (c) =>
          c.field === "purpose" &&
          (c.value === "session-end" ||
            (Array.isArray(c.value) && c.value.includes("session-end"))),
      )
        ? Promise.reject(new Error("too many queries"))
        : findMany(m, where, opts)) as StorageAdapter["findMany"];
    const log = errors();
    await sweepExpired(base.config);
    expect(log.mock.calls).toEqual([["authtempo: the sweep pending end step stopped", "Error"]]);
  });
});

describe("the operator lines (plan 12f)", () => {
  const APP = { kind: "app", name: "support-tool" } as const;

  it("operator.guard_refused", async () => {
    const auth = await operatorAuth();
    const plain = await verifiedSession(auth, "plain@example.com");
    const log = errors();
    expect(await requireOperatorUser(auth.config, plain)).toMatchObject({
      ok: false,
      code: "operator_required",
    });
    // Through a route, the line names the route key (ruling 1 point 18 of plan 12h).
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(
      new Request(`${BASE_URL}/auth/operator/users`, {
        headers: { authorization: `Bearer ${plain.token}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(log.mock.calls).toEqual([
      ["authtempo: operator guard refused", "api"],
      ["authtempo: operator guard refused", "GET /operator/users"],
    ]);
  });

  it("operator.read", async () => {
    const auth = await operatorAuth();
    const log = errors();
    expect((await operatorApi(auth.config).users.list({ actor: APP, limit: 3 })).ok).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: operator read", "app", "support-tool", "listUsers"],
    ]);
  });

  it("operator.route_unauthorized", async () => {
    const auth = await operatorAuth();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const log = errors();
    const res = await handle(
      new Request(`${BASE_URL}/auth/operator/users`, {
        headers: { authorization: "Operator operator-wrong-0123456789abcdef-012345" },
      }),
    );
    expect(res.status).toBe(401);
    expect(log.mock.calls).toEqual([
      ["authtempo: operator route unauthorized", "GET /operator/users", "secret_mismatch"],
    ]);
  });

  it("keeps the operator 401 as one event with a sink, and writes no line", async () => {
    const { sink, events } = recording();
    const auth = await operatorAuth({ observe: { sink } });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const log = errors();
    const res = await handle(
      new Request(`${BASE_URL}/auth/operator/users`, {
        headers: { authorization: "Operator operator-wrong-0123456789abcdef-012345" },
      }),
    );
    expect(res.status).toBe(401);
    expect(log).not.toHaveBeenCalled();
    await auth.config.observe.flush();
    // The one-line promise of spec 9 (ruling 1 point 19 of plan 12h): one fault event, no second.
    const faults = events().filter((e) => (EVENTS as Record<string, EventSpec>)[e.name]?.line);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      name: "operator.route_unauthorized",
      level: "error",
      route: "GET /operator/users",
      reason: "secret_mismatch",
    });
  });

  /** A user, and the draft of a ban of that user by the app. */
  async function act() {
    const auth = await operatorAuth();
    const target = await verifiedSession(auth, "target@example.com");
    const draft = auditDraft(APP, {
      action: "ban",
      targetUserId: target.user.id,
      reason: "Spam from this account.",
      data: { until: null },
      ip: null,
      userAgent: null,
    });
    if (!draft.ok) throw new Error(draft.code);
    return { auth, target, draft: draft.value };
  }

  it("operator.step_failed", async () => {
    const { auth, draft } = await act();
    const log = errors();
    const done = await operatorAct(auth.config, draft, async () => ok({}), {
      async committed() {
        throw new Error("step broke");
      },
    });
    if (!done.ok) throw new Error(done.code);
    expect(log.mock.calls).toEqual([
      ["authtempo: operator step failed", done.value.auditId, "Error"],
    ]);
  });

  it("operator.family_end_failed", async () => {
    const { auth, target, draft } = await act();
    // A store limit after the commit, such as query 51 on D1 Free, stops the end of the families.
    let down = false;
    const store = auth.storage;
    const findMany = store.findMany.bind(store);
    const storage: StorageAdapter = {
      ...store,
      findMany: ((m, where, opts) =>
        down && m === "oauthToken"
          ? Promise.reject(new Error("Too many API requests by single worker invocation."))
          : findMany(m, where, opts)) as StorageAdapter["findMany"],
    };
    const log = errors();
    const done = await operatorAct(
      { ...auth.config, storage },
      draft,
      async (tx, _draft, ends) => {
        await deleteFamilies(
          tx,
          [{ field: "userId", op: "eq", value: target.user.id }],
          ends.families,
        );
        return ok({});
      },
      {
        async committed() {
          down = true;
        },
        answerFamilyEnd: true,
      },
    );
    if (!done.ok) throw new Error(done.code);
    expect(done.value.familyEndFailed).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: operator family end failed", done.value.auditId, "Error"],
    ]);
  });
});

describe("the role line (plan 12k)", () => {
  it("role.row_invalid", async () => {
    const auth = makeAuth({ organizations: { dynamicRoles: {} } });
    const ada = await auth.seedUser(EMAIL);
    const org = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    const organizationId = org.value.organization.id;
    const role = await createRole(auth.config, {
      user: ada,
      organizationId,
      name: "editor",
      rank: 2,
      permissions: { member: ["read"] },
    });
    if (!role.ok) throw new Error(role.code);
    // A row that another writer stored with a bad shape: core must survive any text.
    await auth.storage.update(
      "organizationRole",
      [{ field: "id", op: "eq", value: role.value.id }],
      {
        permissions: "{",
      },
    );
    const log = warns();
    expect(await listRoles(auth.config, { user: ada, organizationId })).toEqual({
      ok: true,
      value: [],
    });
    const standing = await effectiveIn(auth.config, auth.storage, organizationId, "editor");
    expect(standing.unnamed).toBe(1);
    expect(log.mock.calls).toEqual([
      [`authtempo: role row invalid ${role.value.id}`],
      [`authtempo: role row invalid ${role.value.id}`],
    ]);
  });
});

describe("the SSO lines (plan 12d)", () => {
  /** A start through the route: the state of the IdP redirect and the binding cookie. */
  async function started(w: ReturnType<typeof ssoSignInWorld>, connectionId: string) {
    const res = await w.handle(get(`/auth/sso/${connectionId}/start?next=/home`));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const bind =
      res.headers
        .getSetCookie()
        .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
        ?.split(";")[0] ?? "";
    return { state, bind };
  }

  it("sso.guard_refused", async () => {
    const w = ssoSignInWorld();
    const organizationId = await seedOrganization(w, "acme");
    // A verified user with no membership of the organization fails the rank step.
    const eve = await verifiedSession(w, "eve@other.example");
    const resolved = await resolveSession(w.config, eve.token);
    if (!resolved) throw new Error("no session");
    const log = errors();
    expect(await requireSsoManager(w.config, resolved, organizationId)).toMatchObject({
      ok: false,
      code: "forbidden_rank",
    });
    expect(log.mock.calls).toEqual([["authtempo: sso guard refused", "rank"]]);
  });

  it("sso.failed", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const log = errors();
    // A state that no start wrote.
    const res = await w.handle(get(`/auth/sso/${connectionId}/callback?code=c1&state=nope`));
    expect(res.headers.get("location")).toContain("auth_error=sso_failed");
    expect(log.mock.calls).toEqual([["authtempo: sso failed", connectionId, "state"]]);
  });

  it("sso.denied", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const s = await started(w, connectionId);
    const log = errors();
    const q = new URLSearchParams({ error: "access_denied", state: s.state });
    const res = await w.handle(get(`/auth/sso/${connectionId}/callback?${q}`, { cookie: s.bind }));
    expect(res.headers.get("location")).toContain("auth_error=oauth_denied");
    expect(log.mock.calls).toEqual([["authtempo: sso denied", connectionId]]);
  });

  it("sso.refused", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const log = errors();
    const r = await ssoSignIn(w, connectionId, "acme", {
      sub: "c-1",
      email: "ceo@other.example",
      email_verified: true,
    });
    expect(r.error).toBe("sso_domain_mismatch");
    expect(log.mock.calls).toEqual([
      ["authtempo: sso refused", connectionId, "sso_domain_mismatch"],
    ]);
  });

  it("saml.certificate_expired", async () => {
    const w = samlWorld();
    const idp = await createTestIdp({
      alg: "rsa",
      certificateNotAfter: new Date("2025-06-01T00:00:00Z"),
    });
    const organizationId = await seedOrganization(w, "acme");
    await verifiedDomain(w, organizationId, "acme.example");
    const connectionId = await samlConnection(w, organizationId, idp);
    const log = warns();
    // The expired certificate still verifies: the sign-in opens a session.
    expect((await samlSignIn(w, connectionId, idp)).token).toMatch(/^ts_/);
    expect(log.mock.calls).toEqual([["authtempo: saml certificate expired", connectionId]]);
  });

  it("sso.client_secret_unopened", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const row = await w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: connectionId },
    ]);
    if (!row) throw new Error("no connection");
    // The app replaced the value of its secret version 1, so the sealed secret does not open.
    const moved = makeAuth({
      storage: w.storage,
      secret: `${SECRET}x`,
      organizations: {},
      sso: { oidc: true, dns: [w.a] },
    });
    const log = errors();
    expect(await connectionSecret(moved.config, row)).toBeNull();
    expect(log.mock.calls).toEqual([["authtempo: an sso client secret did not open", row.id]]);
  });

  it("sso.domain_unverified", async () => {
    const w = ssoAuth();
    const organizationId = await seedOrganization(w, "acme");
    const added = await addDomain(w.config, SSO_APP, { organizationId, domain: "acme.example" });
    if (!added.ok) throw new Error(added.code);
    // No record is published, so the first resolver gives no value.
    const log = errors();
    expect(await verifyDomain(w.config, SSO_APP, { id: added.value.id })).toMatchObject({
      ok: false,
      code: "domain_unverified",
    });
    expect(log.mock.calls).toEqual([["authtempo: sso domain unverified", "a", added.value.id]]);
  });

  it("sso.domain_lost", async () => {
    const w = ssoAuth();
    const organizationId = await seedOrganization(w, "acme");
    const domainId = await verifiedDomain(w, organizationId, "acme.example");
    w.clock.advance(31 * 86_400_000);
    // Both resolvers lose the record: three failures over 72 hours lose the domain.
    for (const name of Object.keys(w.answers.a)) {
      w.answers.a[name] = [];
      w.answers.b[name] = [];
    }
    const log = errors();
    for (const hours of [0, 36, 36]) {
      w.clock.advance(hours * 3_600_000);
      await sweepExpired(w.config);
    }
    expect(log.mock.calls.filter((c) => c[0] === "authtempo: sso domain lost")).toEqual([
      ["authtempo: sso domain lost", domainId],
    ]);
  });

  it("sweep.sso_recheck_stopped", async () => {
    const w = ssoAuth();
    const findMany = w.storage.findMany.bind(w.storage);
    w.storage.findMany = ((m, where, opts) =>
      m === "ssoDomain"
        ? Promise.reject(new Error("too many queries"))
        : findMany(m, where, opts)) as StorageAdapter["findMany"];
    const log = errors();
    await sweepExpired(w.config);
    expect(log.mock.calls).toEqual([["authtempo: the sweep sso recheck step stopped", "Error"]]);
  });

  it("sweep.anonymous_stopped", async () => {
    const auth = makeAuth({ anonymous: { isolateLimiter: "allow" } });
    const findMany = auth.storage.findMany.bind(auth.storage);
    // The anonymous step reads the user rows first (plan 12i Task 6); no step before it does.
    auth.storage.findMany = ((m, where, opts) =>
      m === "user"
        ? Promise.reject(new Error("too many queries"))
        : findMany(m, where, opts)) as StorageAdapter["findMany"];
    const log = errors();
    const result = await sweepExpired(auth.config);
    expect(result.anonymousUsers).toBe(0);
    expect(log.mock.calls).toEqual([["authtempo: the sweep anonymous step stopped", "Error"]]);
  });

  it("anonymous.cleanup_failed", async () => {
    let down = false;
    const auth = makeAuth({
      password: { hash: FAST, uniformSignUp: false },
      anonymous: { isolateLimiter: "allow" },
      hooks: {
        anonymous: {
          // The next transaction is the end of the anonymous session, after the commit.
          afterLink: () => {
            down = true;
          },
        },
      },
    });
    await verifiedSession(auth, "ada@example.com");
    const transaction = auth.storage.transaction.bind(auth.storage);
    auth.storage.transaction = ((work) => {
      if (!down) return transaction(work);
      down = false;
      return Promise.reject(new Error("too many queries"));
    }) as StorageAdapter["transaction"];
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const signedIn = await handle(post("/auth/anonymous/sign-in", {}));
    const name = `${auth.config.cookieName}=`;
    const cookie = signedIn.headers
      .getSetCookie()
      .find((c) => c.startsWith(name))
      ?.split(";")[0];
    const anonymous = await auth.storage.findOne("user", [
      { field: "isAnonymous", op: "eq", value: true },
    ]);
    const log = errors();
    const res = await handle(
      post(
        "/auth/password/sign-in",
        { email: "ada@example.com", password: PASSWORD },
        { cookie: cookie ?? "" },
      ),
    );
    expect(res.status).toBe(200);
    expect(log.mock.calls).toEqual([
      ["authtempo: the anonymous upgrade cleanup failed", anonymous?.id, "Error"],
    ]);
  });

  it("sweep.organization_rest_stopped", async () => {
    const auth = makeAuth({ organizations: {}, password: { hash: FAST } });
    const ada = await verifiedSession(auth, "ada@example.com");
    const made = await createOrganization(auth.config, {
      user: ada.user,
      slug: "solo",
      name: "Solo",
    });
    if (!made.ok) throw new Error(made.code);
    // The delete of the solo owner leaves the rest of the organization to the sweep.
    const deleted = await deleteAccount(auth.config, { session: ada, ip: null, userAgent: null });
    expect(deleted.ok).toBe(true);
    auth.storage.transaction = (() =>
      Promise.reject(new Error("too many queries"))) as StorageAdapter["transaction"];
    const log = errors();
    await sweepExpired(auth.config);
    expect(log.mock.calls).toEqual([
      ["authtempo: the sweep organization rest step stopped", "Error"],
    ]);
  });
});
