import { describe, expect, it } from "vitest";
import { type AuthConfig, type MailMessage, resolveConfig } from "../src/config.js";
import { configKeyPaths } from "../src/config-paths.js";
import { createAuth } from "../src/create-auth.js";
import type { SecretsRewrap, SecretsStatus } from "../src/engine/secrets.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { LimiterPort, LimitWindow } from "../src/limiter/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import { SCHEMA_VERSION } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { VERSION } from "../src/version.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, tokenFromMail } from "./helpers.js";
import { FAST, proofCookie } from "./password-helpers.js";

const SECRET = "operator-secret-0123456789abcdef-0123456789";
/** A wrong secret of the right form, so that only the hash refuses it. */
const WRONG = "operator-secret-wrong-wrong-wrong-wrong-wrong";
const S1 = "0123456789abcdef0123456789abcdef";
const S2 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
const ONE = [{ version: 1, value: S1 }];
const TWO = [
  { version: 2, value: S2 },
  { version: 1, value: S1 },
];
const HOUR = 3_600_000;
const EMAIL = "ada@example.com";
const PW = "correct horse battery";
const IP = "203.0.113.7";
const STATUS = "/auth/operator/secrets/status";
const REWRAP = "/auth/operator/secrets/rewrap";
const INFO = "/auth/operator/info";
const ROTATE = "/auth/operator/keys/rotate";

type Secrets = Array<{ version: number; value: string }>;
type Body = Record<string, unknown>;

/** A request to an operator route from one IP, with an Authorization header when `auth` is set. */
function call(
  method: "GET" | "POST",
  path: string,
  auth: string | null,
  o: { ip?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: {
      "cf-connecting-ip": o.ip ?? IP,
      ...(auth === null ? {} : { authorization: auth }),
      ...(o.body === undefined ? {} : { "content-type": "application/json" }),
      ...o.headers,
    },
    ...(o.body === undefined ? {} : { body: o.body }),
  });
}
const status = (auth: string | null, ip = IP) => call("GET", STATUS, auth, { ip });
const rewrap = (auth: string | null, body?: string, ip = IP) =>
  call("POST", REWRAP, auth, body === undefined ? { ip } : { ip, body });
const info = (auth: string | null, ip = IP) => call("GET", INFO, auth, { ip });
const rotate = (auth: string | null, ip = IP) => call("POST", ROTATE, auth, { ip });
const RIGHT = `Operator ${SECRET}`;

/**
 * One storage, clock, limiter, and mail list. `on(secrets)` makes the handle
 * of one phase over them: phase 1 with version 1, phase 2 with version 2
 * current and version 1 kept. `calls` records each limiter call. The memory
 * limiter keys a bucket by the key and its window together, so only the
 * record can show that two routes use two keys.
 */
async function fixture() {
  const base = makeAuth();
  const inner = createMemoryLimiter(base.clock);
  const calls: Array<[string, LimitWindow]> = [];
  const limiter: LimiterPort = {
    allow(key, window) {
      calls.push([key, { ...window }]);
      return inner.allow(key, window);
    },
  };
  const mails: MailMessage[] = [];
  const secretHash = await sha256Hex(SECRET);
  const on = (secrets: Secrets, extra: Partial<AuthConfig> = {}, operator = true) =>
    createAuth({
      baseURL: BASE_URL,
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      mail: {
        send: async (m) => {
          mails.push(m);
        },
      },
      clock: base.clock,
      limiter,
      secrets,
      // The detailed sign-up answer, so that the confirm mail carries the link.
      password: { hash: FAST, uniformSignUp: false },
      ...(operator ? { operator: { secretHash } } : {}),
      ...extra,
    });
  return { ...base, limiter, calls, mails, on };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Handle = ReturnType<Fixture["on"]>;

/** A verified user with a password through the routes, and the session cookie of a sign-in. */
async function signedIn(f: Fixture, auth: Handle, email: string): Promise<string> {
  const up = await auth.handle(post("/auth/password/sign-up", { email, password: PW }));
  const confirm = f.mails.findLast((m) => m.to === email && m.subject.startsWith("Confirm"));
  if (!confirm) throw new Error("no confirm mail");
  // The sign-up's own browser keeps the password (ruling 11 of plan 12q).
  await auth.handle(
    post("/auth/password/verify", { token: tokenFromMail(confirm.text) }, proofCookie(up)),
  );
  const signIn = await auth.handle(post("/auth/password/sign-in", { email, password: PW }));
  const cookie = signIn.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-tempo_session="))
    ?.split(";")[0];
  if (!cookie) throw new Error(`the sign-in answered ${signIn.status} with no session cookie`);
  return cookie;
}

/** A TOTP setup through the route, with no enable: a live setup that holds backup codes. */
async function setupOnly(f: Fixture, auth: Handle, email: string): Promise<void> {
  const cookie = await signedIn(f, auth, email);
  const setup = await auth.handle(post("/auth/totp/setup", { password: PW }, { cookie }));
  if (setup.status !== 200) throw new Error(`the setup answered ${setup.status}`);
}

/**
 * Phase 1 through the routes: a verified user with a password, enrolled in
 * TOTP, and the first signing key. Answers the number of backup codes.
 */
async function enroll(f: Fixture, auth: Handle): Promise<number> {
  const cookie = await signedIn(f, auth, EMAIL);
  const setup = await auth.handle(post("/auth/totp/setup", { password: PW }, { cookie }));
  const body = (await setup.json()) as { secret: string; backupCodes: string[] };
  const code = await totpCode(base32Decode(body.secret), f.clock.now());
  const enable = await auth.handle(post("/auth/totp/enable", { code }, { cookie }));
  if (enable.status !== 200) throw new Error(`the enable answered ${enable.status}`);
  // The first JWKS read writes the first signing key.
  const jwks = await auth.handle(get("/auth/jwks"));
  if (jwks.status !== 200) throw new Error(`the jwks answered ${jwks.status}`);
  return body.backupCodes.length;
}

/** A two-phase fixture: phase 1 enrolled, and the handle of phase 2. */
async function twoPhase() {
  const f = await fixture();
  const codes = await enroll(f, f.on(ONE));
  return { f, codes, auth: f.on(TWO) };
}

const versionOf = (s: SecretsStatus, version: number) =>
  s.versions.find((v) => v.version === version);

describe("the operator routes of the app secrets and info (plan 11c2)", () => {
  it("is off without operator: each new route answers 404", async () => {
    const f = await fixture();
    for (const auth of [f.on(ONE, { operator: false }), f.on(ONE, {}, false)]) {
      for (const req of [status(RIGHT), rewrap(RIGHT, "{}"), info(RIGHT)])
        expect((await auth.handle(req)).status, req.url).toBe(404);
    }
  });

  it("answers 401 to no header, to another scheme, and to a wrong secret", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    for (const header of [null, `Bearer ${SECRET}`, `Operator ${WRONG}`, "Operator short"]) {
      for (const req of [status(header), rewrap(header, "{}"), info(header)]) {
        const res = await auth.handle(req);
        expect(res.status, `${req.url} with ${header}`).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    }
  });

  it("counts a wrong secret, and answers 429 at the 121st call of an hour", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    const routes: Array<[string, (a: string | null, ip: string) => Request]> = [
      ["status", (a, ip) => status(a, ip)],
      ["rewrap", (a, ip) => rewrap(a, "{}", ip)],
      ["info", (a, ip) => info(a, ip)],
    ];
    // Each route on its own IP: the 121st call of the hour answers 429, also with the right secret.
    for (const [i, [name, make]] of routes.entries()) {
      const ip = `203.0.113.${10 + i}`;
      for (let n = 1; n <= 120; n++)
        expect((await auth.handle(make(`Operator ${WRONG}`, ip))).status, `${name} ${n}`).toBe(401);
      const refused = await auth.handle(make(RIGHT, ip));
      expect(refused.status, `${name} 121`).toBe(429);
      expect(await refused.json()).toEqual({ error: "rate_limited" });
    }
    f.clock.advance(HOUR);
    for (const [i, [name, make]] of routes.entries())
      expect((await auth.handle(make(RIGHT, `203.0.113.${10 + i}`))).status, name).toBe(200);
    // The three routes share one key: 60 status and 60 info guesses spend the rewrap call.
    for (let n = 1; n <= 60; n++) {
      expect((await auth.handle(status(`Operator ${WRONG}`, "203.0.113.20"))).status).toBe(401);
      expect((await auth.handle(info(`Operator ${WRONG}`, "203.0.113.20"))).status).toBe(401);
    }
    expect((await auth.handle(rewrap(RIGHT, "{}", "203.0.113.20"))).status).toBe(429);
  });

  it("keeps the 5 per hour of keys/rotate apart", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    // Two keys, two windows: the three routes share one, and keys/rotate keeps its own.
    await auth.handle(status(RIGHT, "203.0.113.29"));
    await auth.handle(rewrap(RIGHT, "{}", "203.0.113.29"));
    await auth.handle(info(RIGHT, "203.0.113.29"));
    await auth.handle(rotate(RIGHT, "203.0.113.29"));
    expect(f.calls).toEqual([
      ["operator-secrets:ip:203.0.113.29", { seconds: 3600, max: 120 }],
      ["operator-secrets:ip:203.0.113.29", { seconds: 3600, max: 120 }],
      ["operator-secrets:ip:203.0.113.29", { seconds: 3600, max: 120 }],
      ["operator:ip:203.0.113.29", { seconds: 3600, max: 5 }],
    ]);
    // 120 status calls do not change the five rotate calls of the hour.
    for (let n = 1; n <= 120; n++)
      expect((await auth.handle(status(RIGHT, "203.0.113.30"))).status, `status ${n}`).toBe(200);
    for (let n = 1; n <= 5; n++)
      expect((await auth.handle(rotate(RIGHT, "203.0.113.30"))).status, `rotate ${n}`).toBe(200);
    expect((await auth.handle(rotate(RIGHT, "203.0.113.30"))).status).toBe(429);
    expect((await auth.handle(status(RIGHT, "203.0.113.30"))).status).toBe(429);
    // Five rotate calls do not change the status count.
    for (let n = 1; n <= 5; n++)
      expect((await auth.handle(rotate(RIGHT, "203.0.113.31"))).status, `rotate ${n}`).toBe(200);
    expect((await auth.handle(rotate(RIGHT, "203.0.113.31"))).status).toBe(429);
    expect((await auth.handle(status(RIGHT, "203.0.113.31"))).status).toBe(200);
  });

  it("answers the status that api.secrets.status() answers", async () => {
    const { auth, codes } = await twoPhase();
    const res = await auth.handle(status(RIGHT));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as SecretsStatus;
    expect(body).toEqual(await auth.api.secrets.status());
    // The rows of phase 1: one TOTP secret, its backup codes, and one signing key.
    expect(codes).toBe(10);
    expect(versionOf(body, 1)).toEqual({
      version: 1,
      configured: true,
      current: false,
      totpSecrets: 1,
      backupCodes: 10,
      signingKeys: 1,
      emailCodes: 0,
      ssoClientSecrets: 0,
      stateData: 0,
    });
    expect(versionOf(body, 2)).toEqual({
      version: 2,
      configured: true,
      current: true,
      totpSecrets: 0,
      backupCodes: 0,
      signingKeys: 0,
      emailCodes: 0,
      ssoClientSecrets: 0,
      stateData: 0,
    });
  });

  it("reseals through the route as api.secrets.rewrap() does", async () => {
    const a = await twoPhase();
    const b = await twoPhase();
    // The ids are random, so `next` is compared by its table only.
    const shape = (r: SecretsRewrap) => ({ ...r, next: r.next?.split(":")[0] ?? null });
    const answers: SecretsRewrap[] = [];
    for (let round = 0; round < 10; round++) {
      const res = await a.auth.handle(rewrap(RIGHT, JSON.stringify({ limit: 1 })));
      expect(res.status, `round ${round}`).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as SecretsRewrap;
      answers.push(body);
      if (!body.more) break;
    }
    expect(answers.at(-1)?.more).toBe(false);
    // The TOTP secret, then the key: two calls at one row each.
    expect(answers.map((r) => r.resealed)).toEqual([1, 1]);
    for (const [i, body] of answers.entries()) {
      const api = await b.auth.api.secrets.rewrap({ limit: 1 });
      expect(api.ok, `call ${i + 1}`).toBe(true);
      if (api.ok) expect(shape(body), `call ${i + 1}`).toEqual(shape(api.value));
    }
    const after = (await (await a.auth.handle(status(RIGHT))).json()) as SecretsStatus;
    // The backup codes are keyed hashes: they stay under version 1 until they are used or replaced.
    expect(versionOf(after, 1)).toEqual({
      version: 1,
      configured: true,
      current: false,
      totpSecrets: 0,
      backupCodes: 10,
      signingKeys: 0,
      emailCodes: 0,
      ssoClientSecrets: 0,
      stateData: 0,
    });
  });

  it("passes the cursor after to the engine, so a pass moves past a blocked head row", async () => {
    const f = await fixture();
    const v1 = f.on(ONE);
    // A live setup with codes sorts first: the ids carry the time, and the clock moves after it.
    await setupOnly(f, v1, "bo@example.com");
    f.clock.advance(1000);
    await enroll(f, v1);
    const auth = f.on(TWO);
    const first = await auth.handle(rewrap(RIGHT, JSON.stringify({ limit: 1 })));
    expect(first.status).toBe(200);
    const head = (await first.json()) as SecretsRewrap;
    expect({ ...head, next: head.next?.split(":")[0] }).toEqual({
      resealed: 0,
      failed: 0,
      skipped: 1,
      more: true,
      next: "totp",
    });
    const second = await auth.handle(rewrap(RIGHT, JSON.stringify({ limit: 1, after: head.next })));
    expect(second.status).toBe(200);
    const moved = (await second.json()) as SecretsRewrap;
    expect({ ...moved, next: moved.next?.split(":")[0] }).toEqual({
      resealed: 1,
      failed: 0,
      skipped: 0,
      more: true,
      next: "totp",
    });
  });

  it("refuses a body that is not a limit", async () => {
    const { auth } = await twoPhase();
    const before = await (await auth.handle(status(RIGHT))).json();
    for (const body of [
      "[]",
      '"x"',
      "null",
      "{",
      '{ "limit": 0 }',
      '{ "limit": 1001 }',
      '{ "limit": 1.5 }',
      '{ "limit": "1" }',
      '{ "limit": 1, "x": 1 }',
      '{ "after": 1 }',
      '{ "after": "" }',
      '{ "after": "user:f1" }',
    ]) {
      const res = await auth.handle(rewrap(RIGHT, body));
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    expect(await (await auth.handle(status(RIGHT))).json()).toEqual(before);
  });

  it("takes an empty body as no limit", async () => {
    const f = await fixture();
    const res = await f.on(ONE).handle(rewrap(RIGHT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resealed: 0,
      failed: 0,
      skipped: 0,
      more: false,
      next: null,
    });
  });

  it("answers the version, the schema version, and the key paths, never a value", async () => {
    const base = makeAuth();
    const secretHash = await sha256Hex(SECRET);
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: S1,
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      mail: { send: async () => {} },
      clock: base.clock,
      limiter: createMemoryLimiter(base.clock),
      operator: { secretHash },
      jwtMint: { rotateEvery: 30 },
      social: { google: { clientId: "id-77", clientSecret: "cs-secret-77" } },
    });
    const res = await auth.handle(info(RIGHT));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Body;
    expect(body).toEqual({
      core: VERSION,
      schemaVersion: SCHEMA_VERSION,
      configKeys: [
        "baseURL",
        "clock",
        "jwtMint",
        "jwtMint.rotateEvery",
        "limiter",
        "mail",
        "operator",
        "operator.secretHash",
        "secret",
        "social",
        "social.google",
        "storage",
        "trustedOrigins",
      ],
    });
    const text = JSON.stringify(body);
    for (const value of ["cs-secret-77", "id-77", S1, secretHash])
      expect(text.includes(value), value).toBe(false);
    for (const path of body.configKeys as string[])
      expect(path.startsWith("storage.") || path.startsWith("mail."), path).toBe(false);
  });

  it("accepts operator without jwtMint, and then keys/rotate answers 404 and status answers 200", async () => {
    const f = await fixture();
    const auth = f.on(ONE, { jwtMint: false });
    expect((await auth.handle(rotate(RIGHT))).status).toBe(404);
    expect((await auth.handle(status(RIGHT))).status).toBe(200);
    expect((await auth.handle(info(RIGHT))).status).toBe(200);
  });

  it("refuses a browser post to the rewrap route from an untrusted origin before the secret check", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    for (const header of [RIGHT, `Operator ${WRONG}`]) {
      const res = await auth.handle(
        call("POST", REWRAP, header, { body: "{}", headers: { origin: "https://evil.example" } }),
      );
      expect(res.status, header).toBe(403);
    }
  });
});

describe("configKeyPaths (plan 11c2)", () => {
  const required = {
    baseURL: BASE_URL,
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
  };

  it("lists a key that core names, and a sub key of an option block only", () => {
    class Session {
      ttlDays = 1;
    }
    const input = {
      ...required,
      secrets: [{ version: 1, value: S1 }],
      // A class instance is no plain object: its members are not listed.
      session: new Session(),
      // A null-prototype object is a plain object.
      social: Object.assign(Object.create(null), { google: { clientId: "a", clientSecret: "b" } }),
      hooks: { session: { before: async () => {} } },
      jwtMint: { ttlMinutes: undefined, rotateEvery: 30 },
      cookie: undefined,
      extra: 1,
    } as unknown as AuthConfig;
    expect(configKeyPaths(input)).toEqual([
      "baseURL",
      "hooks",
      "hooks.session",
      "jwtMint",
      "jwtMint.rotateEvery",
      "mail",
      "secrets",
      "session",
      "social",
      "social.google",
      "storage",
      "trustedOrigins",
    ]);
  });

  it("reads no value below the second level", () => {
    const input = {
      ...required,
      social: {
        google: {
          get clientId(): string {
            throw new Error("read");
          },
          clientSecret: "b",
        },
      },
    } as AuthConfig;
    expect(configKeyPaths(input)).toEqual([
      "baseURL",
      "mail",
      "social",
      "social.google",
      "storage",
      "trustedOrigins",
    ]);
    expect(resolveConfig({ ...required, secret: S1 }).configKeys).toEqual([
      "baseURL",
      "mail",
      "secret",
      "storage",
      "trustedOrigins",
    ]);
  });
});
