import type { LimiterPort } from "@authtempo/core";
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

/**
 * The path of the SSO write `write` with the query of core's two routes
 * (plan 12l). The query names the organization of a create, or the
 * connection of an update. Core reads it before the body. The Better Auth
 * paths name the organization in the body, so they take no query.
 */
function withQuery(write: string, organizationId: string, connectionId: string): string {
  if (write === "/sso/connections/create")
    return `${write}?organizationId=${encodeURIComponent(organizationId)}`;
  if (write === "/sso/connections/update") return `${write}?id=${encodeURIComponent(connectionId)}`;
  return write;
}

/** The four SSO write paths, each with its query (plan 12l). */
function ssoWritePaths(organizationId: string, connectionId: string): string[] {
  return SSO_WRITES.map((write) => withQuery(write, organizationId, connectionId));
}

type SsoApp = ReturnType<typeof ssoApp>;

/**
 * A manager of the organization `slug` through the shim's flows (`manager`
 * and `organizationOf` of sso-helpers.ts). The app also makes one OIDC
 * connection of the organization in process (plan 12l). The update path
 * of core names that row in its query. The create of the app counts
 * nothing on the limits of the manager. The label holds a space, so no
 * Better Auth path reads it as a providerId.
 */
async function managerOf(app: SsoApp, email: string, slug: string) {
  const m = await app.manager(email);
  const organizationId = await app.organizationOf(m, slug);
  const made = await app.auth.tempo.api.sso?.connections.create({
    actor: { kind: "app", name: "test" },
    organizationId,
    kind: "oidc",
    label: `${slug} SSO`,
    issuer: `https://idp.${slug}.example`,
    clientId: `${slug}-client`,
    clientSecret: `${slug}-secret-0123456789`,
  });
  if (!made?.ok) throw new Error(`no connection of ${slug}`);
  const connectionId = made.value.id;
  return Object.assign(m, {
    organizationId,
    connectionId,
    paths: ssoWritePaths(organizationId, connectionId),
  });
}

/**
 * A memory database whose limiter records each key that it counts (plan
 * 12l), and each key that it refuses. Core's `limit` is the one caller of
 * the limiter that emits, and it emits one `limit.hit` for each refusal. So
 * each refused key of a family is one `limit.hit` of that family. The shim
 * has no `observe` option, so a test reads the events here.
 */
function recordedMemory() {
  const database = memory();
  const keys: string[] = [];
  const refused: string[] = [];
  const limiter: LimiterPort = {
    scope: "isolate",
    async allow(key, window) {
      keys.push(key);
      const allowed = await database.limiter.allow(key, window);
      if (!allowed) refused.push(key);
      return allowed;
    },
  };
  return { database: { ...database, limiter }, keys, refused };
}

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
    async (write) => {
      const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
      const { auth } = app;
      // A manager reaches the read: the manager guard runs before it (plan 12l).
      const ada = await managerOf(app, "ada@example.com", "acme");
      const { cookie } = ada;
      const path = withQuery(write, ada.organizationId, ada.connectionId);
      const anonymous = post(path, SSO_CAP + 1);
      const res = await auth.handler(anonymous);
      expect(res.status).toBe(401);
      expect(anonymous.bodyUsed).toBe(false);
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

describe("one read of each body through the shim (ruling 68 Minor 1 of the 12j lane)", () => {
  it("clones no body of an SSO write, the ACS, or SCIM, and clones the body of a password path", async () => {
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // A manager reaches the read of each SSO write (plan 12l).
    const ada = await managerOf(app, "ada@example.com", "acme");
    const { cookie } = ada;
    // A clone is a tee: the branch that no one reads keeps each chunk of a large body.
    const clone = vi.spyOn(Request.prototype, "clone");
    const clones = async (request: Request) => {
      clone.mockClear();
      const res = await auth.handler(request);
      return [new URL(request.url).pathname, res.status === 500, clone.mock.calls.length];
    };
    for (const write of SSO_WRITES)
      expect(
        await clones(
          post(withQuery(write, ada.organizationId, ada.connectionId), BODY_CAP_FLOOR + 1, cookie),
        ),
      ).toEqual([`/api/auth${write}`, false, 0]);
    for (const path of ["/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs", "/scim/v2/Users"])
      expect(await clones(post(path, 100))).toEqual([`/api/auth${path}`, false, 0]);
    // The policy code of a password path reads the copy, so that path keeps its one clone.
    expect(await clones(post("/password/sign-up", 100))).toEqual([
      "/api/auth/password/sign-up",
      false,
      1,
    ]);
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
/** Core's SSO_LARGE_READ_PER_USER.max: the large reads of one user in an hour (ruling 69). */
const SSO_LARGE_READ_MAX = 6;

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
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // A manager reaches the large-read count, after the guard (plan 12l).
    const ada = await managerOf(app, "ada@example.com", "acme");
    const { cookie } = ada;
    // Domain writes at the floor leave as many manager writes as large reads (ruling 69 of the
    // 12j lane), so a second count on either limit shows below.
    for (let i = 0; i < SSO_MANAGE_MAX - SSO_LARGE_READ_MAX; i++)
      expect((await auth.handler(post("/sso/domains/update", 64, cookie))).status).toBe(400);
    // Small writes through the shim's label check: each counts once on each limit, as in core.
    const statuses: number[] = [];
    const update = withQuery("/sso/connections/update", ada.organizationId, ada.connectionId);
    for (let i = 0; i <= SSO_LARGE_READ_MAX; i++)
      statuses.push((await auth.handler(post(update, 64, cookie))).status);
    expect(statuses.indexOf(429)).toBe(SSO_LARGE_READ_MAX);
    for (const path of ada.paths) {
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
    // The update names the connection of the register in its query (plan 12l). Its body is
    // no valid update, so each update reads and answers 400.
    const { redirectURI } = (await reg.json()) as { redirectURI: string };
    const id = /\/sso\/([^/]+)\/callback$/.exec(redirectURI)?.[1] ?? "";
    const update = withQuery("/sso/connections/update", organizationId, id);
    // The register made one large read, the shim's: core's read of the connection counted no more.
    let left = 0;
    while ((await app.call(update, { more: 1 }, owner.cookie)).status === 400) left++;
    expect(left).toBe(SSO_LARGE_READ_MAX - 1);
    // It made three manager writes of core: the connection, the domain, and its route. Each
    // update above counted one more, and so did the update that the large-read limit refused.
    let rest = 0;
    while ((await app.call("/sso/domains/update", {}, owner.cookie)).status === 400) rest++;
    expect(rest).toBe(SSO_MANAGE_MAX - 3 - SSO_LARGE_READ_MAX);
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
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // A manager reaches the read, after the pre-check of the guard (plan 12l).
    const { cookie } = await managerOf(app, "ada@example.com", "acme");
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
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // A manager reaches the read, after the pre-check of the guard (plan 12l).
    const { cookie } = await managerOf(app, "ada@example.com", "acme");
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
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    const ada = await app.person("ada@example.com");
    // Bea's register reaches the read: she manages an organization (plan 12l).
    const bea = await managerOf(app, "bea@example.com", "bexley");
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

describe("one large read of a user at a time through the shim (ruling 69 of the 12j lane)", () => {
  it("answers 503 SERVICE_UNAVAILABLE to an SSO write of a user whose large read runs, with no byte read", {
    timeout: 60_000,
  }, async () => {
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // A manager reaches the large read, after the pre-check of the guard (plan 12l).
    const ada = await managerOf(app, "ada@example.com", "acme");
    // A large read of Ada's runs and holds little: the user half has room, Ada has none.
    const mine = gatedRead(`user:${ada.user.id}`, SSO_CAP, 65_536);
    try {
      await mine.atGate;
      const body = countedBody(1_000_000);
      const res = await auth.handler(
        new Request(`${BASE}/api/auth/sso/register`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie: ada.cookie },
          body: body.stream,
          duplex: "half",
        } as RequestInit),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        code: "SERVICE_UNAVAILABLE",
        message: "Service unavailable",
      });
      // No reader took the body: at most the first chunks that a stream fills ahead.
      expect(body.pulled()).toBeLessThan(4 * 65_536);
    } finally {
      mine.open();
    }
    expect((await mine.read)?.length).toBe(SSO_CAP);
  });
});

/** A JSON POST to `path` of `{}` and spaces to `bytes` bytes, with its content-length, as a browser fetch sends. */
function sizedPost(path: string, bytes: number, cookie: string): Request {
  return new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes),
      origin: BASE,
      cookie,
    },
    body: `{}${" ".repeat(bytes - 2)}`,
  });
}

describe("a large read that cannot start spends no count through the shim (ruling 72 Minor 1 of the 12j lane)", () => {
  it("answers 503 to each retry of an SSO write while the user half is full, and counts none", {
    timeout: 60_000,
  }, async () => {
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // A manager reaches the large read of each write, after the guard (plan 12l).
    const ada = await managerOf(app, "ada@example.com", "acme");
    const { cookie } = ada;
    // Another account holds the user half of core less 16 bytes.
    const held = gatedRead("user:hold", SSO_CAP, SSO_CAP - 16);
    const tries = Math.ceil((SSO_MANAGE_MAX + 1) / SSO_WRITES.length);
    try {
      await held.atGate;
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Ada sends each write of 4 KiB again and again: more tries than both limits of a user allow.
      for (const path of ada.paths)
        for (let i = 0; i < tries; i++) {
          const res = await auth.handler(sizedPost(path, 4096, cookie));
          expect([path, res.status, res.headers.get("retry-after")]).toEqual([path, 503, "1"]);
        }
    } finally {
      held.open();
    }
    expect((await held.read)?.length).toBe(SSO_CAP);
    // No refused try counted: each path reads now, and Ada has the rest of the hour's reads.
    const after: number[] = [];
    for (const path of ada.paths)
      after.push((await auth.handler(sizedPost(path, 4096, cookie))).status);
    expect(after.filter((s) => s === 429 || s === 503)).toEqual([]);
    const update = withQuery("/sso/connections/update", ada.organizationId, ada.connectionId);
    let left = 0;
    while ((await auth.handler(sizedPost(update, 4096, cookie))).status !== 429) left++;
    expect(left).toBe(SSO_LARGE_READ_MAX - SSO_WRITES.length);
  });
});

describe("the stall of a large read through the shim (ruling 75 of the 12j lane)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spends the user's large reads at the shim's 408: each SSO write of the user answers 429, and others read", {
    timeout: 60_000,
  }, async () => {
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // Two managers reach the large reads, after the guard (plan 12l).
    const ada = await managerOf(app, "ada@example.com", "acme");
    const bea = await managerOf(app, "bea@example.com", "bexley");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // 1 MB of a register body, then a stall: the shim's own read stops at the idle limit.
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
    const pending = auth.handler(
      new Request(`${BASE}/api/auth/sso/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: ada.cookie },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    try {
      await atGate;
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect((await pending).status).toBe(408);
    } finally {
      open();
    }
    vi.useRealTimers();
    // Ada's 5 other reads of the hour are spent: each SSO write path answers 429, before its read.
    const after: [string, number][] = [];
    for (const path of ada.paths)
      after.push([path, (await auth.handler(sizedPost(path, 4096, ada.cookie))).status]);
    expect(after).toEqual(ada.paths.map((path) => [path, 429]));
    // The spend is Ada's own: each write of Bea reads.
    for (const path of bea.paths)
      expect((await auth.handler(sizedPost(path, 4096, bea.cookie))).status).not.toBe(429);
  });
});

describe("a slow large read through the shim (ruling 79 of the 12j lane)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spends the user's large reads at a shim read that ends whole after 9 s: each SSO write of the user answers 429, and others read", {
    timeout: 60_000,
  }, async () => {
    const app = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
    const { auth } = app;
    // Two managers reach the large reads, after the guard (plan 12l).
    const ada = await managerOf(app, "ada@example.com", "acme");
    const bea = await managerOf(app, "bea@example.com", "bexley");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // 1 MB of a register body, a pause of 9 s, then the rest: under the idle limit, so no 408.
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
    const pending = auth.handler(
      new Request(`${BASE}/api/auth/sso/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: ada.cookie },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    try {
      await atGate;
      await vi.advanceTimersByTimeAsync(9_000);
    } finally {
      open();
    }
    // The shim read the whole body, which is no JSON object.
    expect((await pending).status).toBe(400);
    vi.useRealTimers();
    // The read took more than 8 s: Ada's 5 other reads of the hour are spent, before each read.
    const after: [string, number][] = [];
    for (const path of ada.paths)
      after.push([path, (await auth.handler(sizedPost(path, 4096, ada.cookie))).status]);
    expect(after).toEqual(ada.paths.map((path) => [path, 429]));
    // The spend is Ada's own: each write of Bea reads.
    for (const path of bea.paths)
      expect((await auth.handler(sizedPost(path, 4096, bea.cookie))).status).not.toBe(429);
  });
});

/**
 * A JSON POST of `stream` that declares a length of 8 MiB, the cap of the
 * SSO writes (plan 12l). A client of a large write sends it so.
 */
function streamPost(path: string, stream: ReadableStream<Uint8Array>, cookie: string): Request {
  return new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(SSO_CAP),
      origin: BASE,
      cookie,
    },
    body: stream,
    duplex: "half",
  } as RequestInit);
}

/**
 * A body of `{}` and spaces that sends one chunk of 64 KiB, then stalls
 * until `open` runs (plan 12l). `asked` is true when a reader asked for a
 * second chunk. A read waits at the stall, so it ends only at the idle
 * limit of core's read.
 */
function stalledBody() {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let sent = 0;
  let asked = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (sent > 0) {
        asked = true;
        await gate;
        return c.close();
      }
      const chunk = new Uint8Array(65_536).fill(0x20);
      chunk.set(new TextEncoder().encode("{}"));
      sent += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  return { stream, pulled: () => sent, asked: () => asked, open };
}

describe("the guard before the read through the shim (plan 12l)", () => {
  it("refuses a person before any byte on each SSO write path, and counts no large read", {
    timeout: 60_000,
  }, async () => {
    const { database, keys } = recordedMemory();
    const app = ssoApp(database, [sso({ domainVerification: { enabled: true } })]);
    const ada = await app.person("ada@example.com");
    // Ann manages acme, and the app made one connection of acme: each path names a real row.
    const ann = await managerOf(app, "ann@acme.example", "acme");
    keys.length = 0;
    const answers: [string, number, unknown][] = [];
    for (const path of ann.paths) {
      const body = countedBody(SSO_CAP);
      const res = await app.auth.handler(streamPost(path, body.stream, ada.cookie));
      answers.push([path, res.status, await res.json()]);
      // No reader took the body: at most the chunks that a stream fills ahead.
      expect([path, body.pulled() <= 2 * 65_536]).toEqual([path, true]);
    }
    // Core's guard answers core's paths. The Better Auth paths answer its refusal in Better Auth's form.
    expect(answers).toEqual([
      ["/sso/register", 403, expect.objectContaining({ code: "FORBIDDEN" })],
      ["/sso/update-provider", 403, expect.objectContaining({ code: "FORBIDDEN" })],
      [ann.paths[2], 403, expect.objectContaining({ error: "forbidden_rank" })],
      [ann.paths[3], 403, expect.objectContaining({ error: "forbidden_rank" })],
    ]);
    // Ada counted each write once on the manager writes (ruling 6), and no large read.
    expect(keys.filter((k) => k.endsWith(ada.user.id))).toEqual(
      SSO_WRITES.map(() => `sso-manage:user:${ada.user.id}`),
    );
    expect(keys.filter((k) => k.startsWith("sso-large-read:"))).toEqual([]);
  });

  it("answers a bad query or no row of core's two writes before any byte, and counts no large read", {
    timeout: 60_000,
  }, async () => {
    const { database, keys } = recordedMemory();
    const app = ssoApp(database, [sso({ domainVerification: { enabled: true } })]);
    const ann = await managerOf(app, "ann@acme.example", "acme");
    const org = encodeURIComponent(ann.organizationId);
    const id = encodeURIComponent(ann.connectionId);
    // Each query that core's readQuery refuses, and an update of no row (plan 12l, ruling 6).
    const cases: [path: string, status: number, error: string][] = [
      ["/sso/connections/create", 400, "invalid_body"],
      [`/sso/connections/create?organizationId=${org}&organizationId=${org}`, 400, "invalid_body"],
      [`/sso/connections/create?organizationId=${org}&id=${id}`, 400, "invalid_body"],
      ["/sso/connections/create?organizationId=", 400, "invalid_body"],
      [`/sso/connections/create?organizationId=${"o".repeat(65)}`, 400, "invalid_body"],
      ["/sso/connections/update", 400, "invalid_body"],
      [`/sso/connections/update?organizationId=${org}`, 400, "invalid_body"],
      [`/sso/connections/update?id=${id}&id=${id}`, 400, "invalid_body"],
      ["/sso/connections/update?id=c%00none", 400, "invalid_body"],
      ["/sso/connections/update?id=c-none", 404, "not_found"],
    ];
    keys.length = 0;
    for (const [path, status, error] of cases) {
      const body = stalledBody();
      try {
        const res = await app.auth.handler(streamPost(path, body.stream, ann.cookie));
        expect([path, res.status, await res.json()]).toEqual([
          path,
          status,
          expect.objectContaining({ error }),
        ]);
        // No reader asked for the second chunk: the shim and core read nothing.
        expect([path, body.asked(), body.pulled() <= 2 * 65_536]).toEqual([path, false, true]);
      } finally {
        body.open();
      }
    }
    // Each write counted once on the manager writes, and none on the large reads.
    expect(keys.filter((k) => k.startsWith("sso-manage:"))).toHaveLength(cases.length);
    expect(keys.filter((k) => k.startsWith("sso-large-read:"))).toEqual([]);
  });

  it("takes exactly the queries that core takes on its two writes, and answers as core before any byte (fix-wave item 8)", {
    timeout: 60_000,
  }, async () => {
    const app = ssoApp(memory(), [admin({}), sso({ domainVerification: { enabled: true } })], {
      platformOrganization: "platform-co",
    });
    // One manager for each write keeps each one under core's 30 manager writes.
    const ann = await managerOf(app, "ann@acme.example", "acme");
    const bea = await managerOf(app, "bea@example.com", "bexley");
    // Core's zod counts code points: 64 emoji are 64 code points and 128 UTF-16 units.
    const emoji = (n: number) => encodeURIComponent("\u{1F600}".repeat(n));
    // The cases of the review of Task 4, with the key of the write and a real value of it.
    const queries = (key: string, real: string): [what: string, query: string][] => [
      ["a repeated key", `?${key}=${real}&${key}=${real}`],
      ["a NUL", `?${key}=o%00x`],
      // The decoder of the URL gives U+FFFD for each byte, so no lone surrogate reaches a value.
      ["a lone surrogate", `?${key}=%ED%A0%80`],
      ["a missing key", ""],
      ["an extra key", `?${key}=${real}&extra=1`],
      ["64 emoji", `?${key}=${emoji(64)}`],
      ["65 emoji", `?${key}=${emoji(65)}`],
    ];
    const createCases = queries("organizationId", encodeURIComponent(ann.organizationId));
    const writes = [
      { path: "/sso/connections/create", cookie: ann.cookie, cases: createCases },
      {
        path: "/sso/connections/update",
        cookie: bea.cookie,
        cases: queries("id", encodeURIComponent(bea.connectionId)),
      },
    ];
    /** The answer to a stalled write of a declared 8 MiB, and whether a reader asked for more. */
    const answer = async (
      send: (r: Request) => Promise<Response>,
      path: string,
      cookie: string,
    ) => {
      const body = stalledBody();
      try {
        const res = await send(streamPost(path, body.stream, cookie));
        return { status: res.status, body: (await res.json()) as unknown, asked: body.asked() };
      } finally {
        body.open();
      }
    };
    const coreTakes: [path: string, what: string, takes: boolean][] = [];
    for (const { path, cookie, cases } of writes)
      for (const [what, query] of cases) {
        const shim = await answer((r) => app.auth.handler(r), `${path}${query}`, cookie);
        const core = await answer((r) => app.auth.tempo.handle(r), `${path}${query}`, cookie);
        // The shim answers as core answers the same request, and neither reads a byte first.
        expect([path, what, shim]).toEqual([path, what, core]);
        expect([path, what, shim.asked]).toEqual([path, what, false]);
        // Core refuses a query with 400 invalid_body. Any other answer comes after the query.
        coreTakes.push([path, what, core.status !== 400]);
      }
    const takes = [false, false, true, false, false, true, false];
    expect(coreTakes).toEqual(
      writes.flatMap(({ path, cases }) => cases.map(([what], i) => [path, what, takes[i]])),
    );
    // A query that core takes reaches the shim's own label rule, after the read. A query that
    // core refuses does not. A platform operator passes the guard for any organization.
    const op = await app.operator("op@example.com");
    const fields = {
      kind: "oidc",
      label: "acme-oidc",
      issuer: "https://idp.acme.example",
      clientId: "acme-client",
      clientSecret: "acme-secret-0123456789",
    };
    const ruled: [what: string, ruled: boolean][] = [];
    for (const [what, query] of createCases) {
      const res = await app.call(`/sso/connections/create${query}`, fields, op.cookie);
      const body = (await res.json()) as { message?: string };
      ruled.push([what, res.status === 400 && /providerId form/.test(body.message ?? "")]);
    }
    expect(ruled).toEqual(createCases.map(([what], i) => [what, takes[i]]));
  });

  it("runs the operator guard once for a platform operator's write on core's path (review focus 5)", {
    timeout: 60_000,
  }, async () => {
    const { database, keys } = recordedMemory();
    const app = ssoApp(database, [admin({}), sso({ domainVerification: { enabled: true } })], {
      platformOrganization: "platform-co",
    });
    const ann = await app.manager("ann@acme.example");
    const organizationId = await app.organizationOf(ann, "acme");
    const op = await app.operator("op@example.com");
    keys.length = 0;
    const res = await app.call(
      withQuery("/sso/connections/create", organizationId, ""),
      {
        kind: "oidc",
        label: "Acme SSO",
        issuer: "https://idp.acme.example",
        clientId: "acme-client",
        clientSecret: "acme-secret-0123456789",
      },
      op.cookie,
    );
    expect(res.status).toBe(200);
    // The shim ran the guard before its read, and core took its mark: one count of each limit.
    expect(keys.filter((k) => k.endsWith(op.user.id))).toEqual([
      `sso-manage:user:${op.user.id}`,
      `operator:user:${op.user.id}`,
      `sso-large-read:user:${op.user.id}`,
    ]);
    const audit = await app.auth.tempo.api.operator.audit.list({
      actor: { kind: "app", name: "test" },
    });
    if (!audit.ok) throw new Error(audit.code);
    expect(
      audit.value.rows.filter((r) => r.actorId === op.user.id).map((r) => [r.action, r.actorKind]),
    ).toEqual([["sso_connection_create", "user"]]);
  });

  it("answers a stale session of a manager on core's two writes with Better Auth's code, before any byte (review M1)", {
    timeout: 60_000,
  }, async () => {
    const { database, keys } = recordedMemory();
    const app = ssoApp(database, [sso({ domainVerification: { enabled: true } })]);
    // Ann manages acme, and the app made one connection of acme: the update names a real row.
    const ann = await managerOf(app, "ann@acme.example", "acme");
    const corePaths = [
      withQuery("/sso/connections/create", ann.organizationId, ann.connectionId),
      withQuery("/sso/connections/update", ann.organizationId, ann.connectionId),
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Two days is past the fresh window of one day. The session lives seven days.
      vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
      keys.length = 0;
      for (const path of corePaths) {
        const body = stalledBody();
        try {
          const res = await app.auth.handler(streamPost(path, body.stream, ann.cookie));
          // The shim's guard refuses in core's form. The handler adds Better Auth's code.
          expect([path, res.status, await res.json()]).toEqual([
            path,
            403,
            { error: "session_not_fresh", code: "SESSION_NOT_FRESH" },
          ]);
          // No reader asked for the second chunk: the refusal came before the read.
          expect([path, body.asked(), body.pulled() <= 2 * 65_536]).toEqual([path, false, true]);
        } finally {
          body.open();
        }
      }
    } finally {
      vi.useRealTimers();
    }
    // Each write counted once on the manager writes, and none on the large reads.
    expect(keys.filter((k) => k.startsWith("sso-manage:"))).toHaveLength(corePaths.length);
    expect(keys.filter((k) => k.startsWith("sso-large-read:"))).toEqual([]);
  });

  it("gives one limit.hit to an SSO write past the manager-write limit, before any byte (fix-wave item 7)", {
    timeout: 60_000,
  }, async () => {
    const { database, keys, refused } = recordedMemory();
    const app = ssoApp(database, [sso({ domainVerification: { enabled: true } })]);
    const ada = await managerOf(app, "ada@example.com", "acme");
    // Domain writes at the floor spend each manager write of the window, and no large read.
    for (let i = 0; i < SSO_MANAGE_MAX; i++)
      expect((await app.auth.handler(post("/sso/domains/update", 64, ada.cookie))).status).toBe(
        400,
      );
    keys.length = 0;
    const answers: [path: string, status: number, body: unknown, hits: string[]][] = [];
    for (const path of ada.paths) {
      refused.length = 0;
      const body = stalledBody();
      try {
        const res = await app.auth.handler(streamPost(path, body.stream, ada.cookie));
        answers.push([path, res.status, await res.json(), [...refused]]);
        // No reader asked for the second chunk: the refusal came before the read.
        expect([path, body.asked()]).toEqual([path, false]);
      } finally {
        body.open();
      }
    }
    // Each write gets 429 with one refusal of sso-manage:user, so one limit.hit. Core's paths
    // answer in core's form, and the Better Auth paths in Better Auth's form.
    const hit = [`sso-manage:user:${ada.user.id}`];
    expect(answers).toEqual([
      [ada.paths[0], 429, expect.objectContaining({ code: "TOO_MANY_REQUESTS" }), hit],
      [ada.paths[1], 429, expect.objectContaining({ code: "TOO_MANY_REQUESTS" }), hit],
      [ada.paths[2], 429, { error: "rate_limited" }, hit],
      [ada.paths[3], 429, { error: "rate_limited" }, hit],
    ]);
    // No write reached a large-read count.
    expect(keys.filter((k) => k.startsWith("sso-large-read:"))).toEqual([]);
  });

  it("counts the large read before the read on core's two writes: past the limit, 429 before any byte (fix-wave item 15)", {
    timeout: 60_000,
  }, async () => {
    const { database, refused } = recordedMemory();
    const app = ssoApp(database, [sso({ domainVerification: { enabled: true } })]);
    const ada = await managerOf(app, "ada@example.com", "acme");
    // Six small updates spend the six large reads of the hour (ruling 69 of the 12j lane).
    const update = withQuery("/sso/connections/update", ada.organizationId, ada.connectionId);
    const small: number[] = [];
    for (let i = 0; i < SSO_LARGE_READ_MAX; i++)
      small.push((await app.auth.handler(sizedPost(update, 4096, ada.cookie))).status);
    expect(small).toEqual(small.map(() => 200));
    // A stalled write of a declared 8 MiB on each core path: the count refuses before the read.
    // The core paths are the last two of the four.
    for (const path of ada.paths.slice(2)) {
      refused.length = 0;
      const body = stalledBody();
      try {
        const res = await app.auth.handler(streamPost(path, body.stream, ada.cookie));
        expect([path, res.status, await res.json()]).toEqual([
          path,
          429,
          { error: "rate_limited" },
        ]);
        // No reader asked for the second chunk, and the stream sent one chunk at most.
        expect([path, body.asked(), body.pulled() <= 2 * 65_536]).toEqual([path, false, true]);
        // One refusal, of the large reads: one limit.hit (ruling 72 Low 2 of the 12j lane).
        expect([path, refused]).toEqual([path, [`sso-large-read:user:${ada.user.id}`]]);
      } finally {
        body.open();
      }
    }
  });
});
