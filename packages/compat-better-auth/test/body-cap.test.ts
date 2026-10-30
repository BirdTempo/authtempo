import { BODY_BUSY_RETRY_SECONDS, bodyCapOf, readBodyText } from "@authtempo/core/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admin, emailOTP, organization, twoFactor, username } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { sso } from "../src/sso.js";
import { BASE, fakeDns, memory, SECRET, ssoApp } from "./sso-helpers.js";

/**
 * The body reads of the shim (ruling 46 of the 12j lane, Major 2). Each
 * read is core's capped read at the cap of the core route that the body
 * goes to. A body one byte past that cap answers 413 PAYLOAD_TOO_LARGE at
 * the shim's first read: no JSON.parse takes the long text, and no core
 * route runs. The paths are each path that the shim reads before core.
 */

/** Core's floor, the cap of a read with no route. */
const BODY_CAP_FLOOR = bodyCapOf(undefined);
/** The cap of the SSO connection writes, the largest of core. */
const SSO_CAP = bodyCapOf("POST /sso/connections/create");

/** Each path that the shim reads before core, and the cap of its read. */
const FIRST_READS: readonly [path: string, cap: number][] = [
  ["/change-email", BODY_CAP_FLOOR],
  ["/user/change-email", BODY_CAP_FLOOR],
  ["/admin/set-role", BODY_CAP_FLOOR],
  ["/admin/update-user", BODY_CAP_FLOOR],
  ["/admin/create-user", BODY_CAP_FLOOR],
  ["/admin/ban-user", BODY_CAP_FLOOR],
  ["/revoke-session", BODY_CAP_FLOOR],
  ["/update-user", BODY_CAP_FLOOR],
  ["/email-otp/send-verification-otp", BODY_CAP_FLOOR],
  ["/two-factor/enable", BODY_CAP_FLOOR],
  ["/sign-in/social", BODY_CAP_FLOOR],
  ["/sign-in/username", BODY_CAP_FLOOR],
  ["/sso/delete-provider", BODY_CAP_FLOOR],
  ["/sso/request-domain-verification", BODY_CAP_FLOOR],
  ["/sso/verify-domain", BODY_CAP_FLOOR],
  ["/sign-in/sso", BODY_CAP_FLOOR],
];

/**
 * The paths of the SSO connection writes, whose read takes the large cap.
 * The shim reads them only after the session check, as core does.
 */
const SSO_WRITES = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/connections/create",
  "/sso/connections/update",
];

/** An app with every plugin whose path the shim reads first. */
function app() {
  return betterAuth({
    baseURL: BASE,
    secret: SECRET,
    database: memory(),
    authtempo: { platformOrganization: "platform-co", ssoDns: [fakeDns("a", new Map()).port] },
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: { sendVerificationEmail: async () => {} },
    user: { changeEmail: { enabled: true } },
    plugins: [
      organization({ sendInvitationEmail: async () => {} }),
      twoFactor({ accountLockout: { enabled: false } }),
      admin({}),
      emailOTP({ sendVerificationOTP: async () => {}, changeEmail: { enabled: true } }),
      username(),
      sso({ domainVerification: { enabled: true } }),
    ],
  });
}

/** A JSON POST of a small object with spaces to exactly `bytes` bytes, with `cookie` when given. */
function post(path: string, bytes: number, cookie?: string): Request {
  const json = '{"newEmail":"a@example.com","userId":"u","role":"user"}';
  return new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: json + " ".repeat(bytes - json.length),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the body reads of the shim (ruling 46 of the 12j lane)", () => {
  it.each(FIRST_READS)(
    "answers 413 PAYLOAD_TOO_LARGE at the first read of %s one byte past its cap",
    async (path, cap) => {
      const auth = app();
      const parse = vi.spyOn(JSON, "parse");
      const res = await auth.handler(post(path, cap + 1));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ code: "PAYLOAD_TOO_LARGE", message: "Payload too large" });
      expect(parse.mock.calls.filter(([t]) => typeof t === "string" && t.length > cap)).toEqual([]);
    },
  );

  it.each(SSO_WRITES)(
    "reads %s only with a session, and answers 413 PAYLOAD_TOO_LARGE one byte past 8 MiB",
    async (path) => {
      const { auth, person } = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
      const anonymous = post(path, SSO_CAP + 1);
      const res = await auth.handler(anonymous);
      expect(res.status).toBe(401);
      expect(anonymous.bodyUsed).toBe(false);
      const { cookie } = await person("ada@example.com");
      const parse = vi.spyOn(JSON, "parse");
      const over = await auth.handler(post(path, SSO_CAP + 1, cookie));
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({
        code: "PAYLOAD_TOO_LARGE",
        message: "Payload too large",
      });
      expect(
        parse.mock.calls.filter(([t]) => typeof t === "string" && t.length > BODY_CAP_FLOOR),
      ).toEqual([]);
      // A body past the floor and under the cap is read: the answer is not 413.
      expect((await auth.handler(post(path, BODY_CAP_FLOOR + 1, cookie))).status).not.toBe(413);
    },
  );

  it("reads a body that a reader locked before the shim as no JSON, not 500 (ruling 51 Low 3)", async () => {
    const auth = app();
    for (const [path] of FIRST_READS) {
      const request = post(path, 100);
      request.body?.getReader();
      const res = await auth.handler(request);
      expect([path, res.status]).not.toEqual([path, 500]);
    }
  });

  it("reads a body at the cap of its route and passes it on", async () => {
    const auth = app();
    // At the floor, the body is read: the answer is not 413, whatever the route answers next.
    for (const [path, cap] of FIRST_READS.filter(([, c]) => c === BODY_CAP_FLOOR)) {
      const res = await auth.handler(post(path, cap));
      expect([path, res.status]).not.toEqual([path, 413]);
    }
  });
});

/**
 * A JSON body of `bytes` bytes, `{}` and spaces, in chunks of 64 KiB. It
 * counts the bytes that a reader pulled, so a test sees that no read ran.
 */
function countedBody(bytes: number) {
  const spaces = new Uint8Array(65_536).fill(0x20);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close();
      const chunk = spaces.slice(0, Math.min(spaces.byteLength, bytes - sent));
      if (sent === 0) chunk.set(new TextEncoder().encode("{}"));
      sent += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  return { stream, pulled: () => sent };
}

/** Core's SSO_MANAGE_PER_USER.max: the SSO manager writes of one user in 15 minutes. */
const SSO_MANAGE_MAX = 30;

const OIDC = {
  clientId: "acme-client",
  clientSecret: "acme-secret-value",
  skipDiscovery: true,
  authorizationEndpoint: "https://idp.acme.example/authorize",
  tokenEndpoint: "https://idp.acme.example/token",
  jwksEndpoint: "https://idp.acme.example/jwks",
  scopes: ["openid", "email", "profile"],
  pkce: true,
};

describe("core's limit of the user before the large read of an SSO write (ruling 51 Minor 1 of the 12j lane)", () => {
  it("counts each write once, and past the limit answers 429 with no read and no parse", {
    timeout: 60_000,
  }, async () => {
    const { auth, person } = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { cookie } = await person("ada@example.com");
    // Small writes through the shim's label check: each counts once, as in core.
    const statuses: number[] = [];
    for (let i = 0; i <= SSO_MANAGE_MAX; i++)
      statuses.push((await auth.handler(post("/sso/connections/update", 64, cookie))).status);
    expect(statuses.indexOf(429)).toBe(SSO_MANAGE_MAX);
    for (const path of SSO_WRITES) {
      const parse = vi.spyOn(JSON, "parse");
      const body = countedBody(SSO_CAP);
      const res = await auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie },
          body: body.stream,
          duplex: "half",
        } as RequestInit),
      );
      expect([path, res.status]).toEqual([path, 429]);
      // The lengths of the parsed texts, not the texts: a diff of 8 MiB never ends.
      const long = parse.mock.calls.map(([t]) => (typeof t === "string" ? t.length : 0));
      expect(long.filter((n) => n > BODY_CAP_FLOOR)).toEqual([]);
      // No reader took the body: at most the first chunks that a stream fills ahead.
      expect(body.pulled()).toBeLessThan(4 * 65_536);
      parse.mockRestore();
    }
  });

  it("counts a register as core counts its writes, with no extra count of the shim", {
    timeout: 60_000,
  }, async () => {
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const owner = await app.manager("ann@acme.example");
    const organizationId = await app.organizationOf(owner, "acme");
    const reg = await app.call(
      "/sso/register",
      {
        organizationId,
        providerId: "acme-oidc",
        issuer: "https://idp.acme.example",
        domain: "acme.example",
        oidcConfig: OIDC,
      },
      owner.cookie,
    );
    expect(reg.status).toBe(200);
    // The register made three writes of core: the connection, the domain, and its route.
    let left = 0;
    while ((await app.call("/sso/connections/update", {}, owner.cookie)).status === 400) left++;
    expect(left).toBe(SSO_MANAGE_MAX - 3);
  });
});

/** Core's LARGE_READ_SHARE: the bytes that the large reads of one IP hold at once. */
const IP_SHARE = 4 * 1_048_576;

/**
 * A large read of core for `client`: `bytes` spaces at the cap of the SSO
 * writes, which stop after `before` bytes until `open` runs. `atGate`
 * resolves when the reader asks for the first chunk past `before`.
 */
function gatedRead(client: string, bytes: number, before: number) {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = () => {};
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (sent >= bytes) return c.close();
      if (sent >= before) {
        reached();
        await gate;
      }
      const n = Math.min(65_536, (sent < before ? before : bytes) - sent);
      c.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
  });
  const read = readBodyText(
    new Request(`${BASE}/x`, { method: "POST", body: stream, duplex: "half" } as RequestInit),
    SSO_CAP,
    client,
  );
  read.catch(() => {});
  return { read, atGate, open };
}

describe("the budget of the large reads through the shim (ruling 51 Minor 2 of the 12j lane)", () => {
  it("answers 503 SERVICE_UNAVAILABLE with Retry-After to an SSO write past the user half", {
    timeout: 60_000,
  }, async () => {
    const { auth, person } = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { cookie } = await person("ada@example.com");
    // A read of another user that stops one chunk before 8 MiB holds the user half of core (ruling 66).
    const held = gatedRead("user:hold", SSO_CAP, SSO_CAP - 65_536);
    await held.atGate;
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sso/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: countedBody(1_000_000).stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(BODY_BUSY_RETRY_SECONDS));
    expect(await res.json()).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable",
    });
    held.open();
    expect((await held.read)?.length).toBe(SSO_CAP);
  });
});

/** Core's LARGE_READ_IDLE_MS: a large read that gets no chunk for this time ends with 408. */
const IDLE_MS = 10_000;

describe("the deadlines of the large reads through the shim (ruling 59 Major 1 of the 12j lane)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers 408 REQUEST_TIMEOUT to an SSO write whose body stalls past the idle limit", {
    timeout: 60_000,
  }, async () => {
    const { auth, person } = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { cookie } = await person("ada@example.com");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // 1 MB of a JSON body, then a stall.
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached = () => {};
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (sent >= 1_048_576) {
          reached();
          await gate;
        }
        if (sent >= 2_097_152) return c.close();
        c.enqueue(new Uint8Array(65_536).fill(0x20));
        sent += 65_536;
      },
    });
    let answered: Response | null = null;
    void auth
      .handler(
        new Request(`${BASE}/api/auth/sso/register`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie },
          body: stream,
          duplex: "half",
        } as RequestInit),
      )
      .then((res) => {
        answered = res;
      });
    try {
      // The session check runs WebCrypto, which no fake timer moves: wait for the read itself.
      await atGate;
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(sent).toBe(1_048_576);
      expect(answered).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const res = answered as Response | null;
      expect(res?.status).toBe(408);
      expect(await res?.json()).toEqual({ code: "REQUEST_TIMEOUT", message: "Request timeout" });
    } finally {
      open();
    }
  });
});

describe("the share of one client of the large reads through the shim (ruling 59 Major 1 of the 12j lane)", () => {
  it("counts the shim's read of an SSO write in the user half, which holds every user", {
    timeout: 60_000,
  }, async () => {
    const { auth, person } = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const ada = await person("ada@example.com");
    const bea = await person("bea@example.com");
    // Two IPs that each hold their share fill the anonymous half of core (ruling 66).
    const anon = ["ip:203.0.113.1", "ip:203.0.113.2"].map((client) =>
      gatedRead(client, IP_SHARE, IP_SHARE - 65_536),
    );
    let mine: ReturnType<typeof gatedRead> | undefined;
    try {
      await Promise.all(anon.map((a) => a.atGate));
      const register = (cookie: string) =>
        auth.handler(
          new Request(`${BASE}/api/auth/sso/register`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE, cookie },
            body: countedBody(4 * 1_048_576).stream,
            duplex: "half",
          } as RequestInit),
        );
      // Bea's register reads its body in the user half, and the shim refuses its fields.
      expect((await register(bea.cookie)).status).toBe(400);
      // A read of Ada's holds 5 MiB of the user half: Bea's register passes the half, 503 at the shim.
      mine = gatedRead(`user:${ada.user.id}`, SSO_CAP, 5 * 1_048_576);
      await mine.atGate;
      const late = await register(bea.cookie);
      expect(late.status).toBe(503);
      expect(await late.json()).toEqual({
        code: "SERVICE_UNAVAILABLE",
        message: "Service unavailable",
      });
    } finally {
      for (const g of [...anon, ...(mine ? [mine] : [])]) g.open();
    }
    expect((await mine?.read)?.length).toBe(SSO_CAP);
  });
});
