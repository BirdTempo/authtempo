import { describe, expect, it, vi } from "vitest";
import {
  type AuthConfig,
  type MailMessage,
  type ResolvedConfig,
  resolveConfig,
} from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  handleProved,
  type ProofCaller,
  provedAccount,
  provedAddress,
  sessionProved,
} from "../src/engine/address.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { mintSessionJwt, sessionLive } from "../src/engine/jwt.js";
import { verifyMagicLink } from "../src/engine/magic-link.js";
import { hasPendingEnd, readPendingEnds } from "../src/engine/operator/access-end.js";
import { revokedFor } from "../src/engine/operator/guards.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { verified } from "../src/engine/organizations.js";
import { requestPhone, verifyPhone } from "../src/engine/phone.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { CLAIM_LEASE_MS, CLAIM_RUNS, claimLeaseId } from "../src/engine/users.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import {
  type ModelName,
  type SessionRow,
  schema,
  type UserRow,
  type VerificationRow,
} from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { meterOf } from "../src/storage/meter.js";
import { type StorageAdapter, StorageError } from "../src/storage/port.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { d1Like } from "./d1-like.js";
import { APP_ORIGIN, BASE_URL, recordAddress, recordCredential, tokenFromMail } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture, operatorHeader } from "./operator-helpers.js";
import { FAST, proofCookie } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  GOOGLE,
  googleClaims,
  tokenEndpoint,
} from "./social-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// Plan 12p Task 2: the proof flag of a session and the rule at every
// verified-only gate. Every session here comes from a flow of the product.
// A claimant is a password sign-up of an address that another person owns.
// The owner proves the address by a magic link, and that proof runs the
// claim. A storage wrapper runs the claimant's requests inside the claim's
// first write, the flip. The claimant's requests go to the store at once,
// as a parallel connection of D1 does. So they see the user verified and the
// claimant's session still live.

const CLAIMED = recordAddress("ada@example.com");
const PW = recordCredential("claimant password 1");
const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };
const PHONE = "+14155550100";
const REDIRECT = "https://client.example.com/callback";
const RESOURCE = `${BASE_URL}/mcp`;
const COOKIE = "__Host-tempo_session";

/** True for the claim's lease: its first statement on a store with no isolation (plan 12p). */
function isLease(model: string, data: unknown): boolean {
  return model === "verification" && (data as { purpose?: unknown }).purpose === "claim-lease";
}

/** True for the claim's flip: the update of an unverified user row to verified. */
function isFlip(model: string, where: { field: string; value: unknown }[], data: unknown): boolean {
  return (
    model === "user" &&
    (data as Partial<UserRow>).emailVerified === true &&
    where.some((w) => w.field === "emailVerified" && w.value === false)
  );
}

/**
 * Two instances of core on one memory store, one clock, one limiter, and one
 * mail list. `owner` writes through a wrapper: its next flip runs `armed.run`
 * before the claim goes on. `claimant` writes to the store at once, also in a
 * transaction, as a parallel connection with no isolation does.
 */
function world(opts: { hook?: boolean; extra?: Partial<AuthConfig> } = {}) {
  let current = new Date("2026-11-04T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const inner = createMemoryAdapter();
  const limiter = createMemoryLimiter(clock);
  const mail: MailMessage[] = [];
  const sms = createRecordingSms();
  const ended: string[] = [];
  const created: SessionRow[] = [];
  /**
   * The claimant's requests to run inside the owner's flow (plan 12p). They
   * run right after one statement of the claim. It is the lease, the flip,
   * or the delete of the identities, the passwords, or the handoff codes.
   */
  const armed: {
    run: (() => Promise<void>) | null;
    at: "lease" | "identity-delete" | "password-delete" | "handoff-delete" | "flip";
  } = {
    run: null,
    at: "flip",
  };
  /**
   * The query cap of a D1 invocation (plan 12p): while on, each call of the
   * owner's store throws as D1 does at query 51. An undo that runs then
   * fails too, as on D1.
   */
  const cap = { on: false };
  const capped = () => {
    if (cap.on) throw new Error("Too many API requests by single worker invocation.");
  };
  /** Each write of the owner's flows as `op:model`, in order, while a test sets it. */
  const log: { writes: string[] | null } = { writes: null };
  const wrote = (op: string, model: string) => log.writes?.push(`${op}:${model}`);
  const wrap = (a: StorageAdapter): StorageAdapter => ({
    createMany: (m, r) => {
      capped();
      return a.createMany(m, r);
    },
    rowsPerInsert: (m) => a.rowsPerInsert(m),
    create: async (m, d) => {
      capped();
      wrote("create", m);
      const row = await a.create(m, d);
      const run = armed.run;
      if (run && armed.at === "lease" && isLease(m, d)) {
        armed.run = null;
        await run();
      }
      return row;
    },
    findOne: (m, w) => {
      capped();
      return a.findOne(m, w);
    },
    findMany: (m, w, o) => {
      capped();
      return a.findMany(m, w, o);
    },
    update: async (m, w, d) => {
      capped();
      const flip = isFlip(m, w as { field: string; value: unknown }[], d);
      wrote(flip ? "flip" : "update", m);
      const n = await a.update(m, w, d);
      const run = armed.run;
      if (run && armed.at === "flip" && n > 0 && flip) {
        armed.run = null;
        await run();
      }
      return n;
    },
    delete: async (m, w) => {
      capped();
      wrote("delete", m);
      const n = await a.delete(m, w);
      const run = armed.run;
      const codes =
        m === "verification" && w.some((x) => x.field === "purpose" && x.value === "handoff-code");
      const at = codes
        ? "handoff-delete"
        : m === "password"
          ? "password-delete"
          : m === "identity"
            ? "identity-delete"
            : null;
      if (run && at !== null && armed.at === at) {
        armed.run = null;
        await run();
      }
      return n;
    },
    deleteRows: (m, w) => {
      capped();
      wrote("deleteRows", m);
      return a.deleteRows(m, w);
    },
    isolated: a.isolated,
    keep: () => a.keep(),
    transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
  });
  /** A wait before the next insert of a model of the claimant's store, while a test sets it. */
  const gate: Record<"session" | "password" | "identity", (() => Promise<void>) | null> = {
    session: null,
    password: null,
    identity: null,
  };
  const open: StorageAdapter = {
    createMany: (m, r) => inner.createMany(m, r),
    rowsPerInsert: (m) => inner.rowsPerInsert(m),
    create: async (m, d) => {
      const key: keyof typeof gate | null =
        m === "session" || m === "password" || m === "identity" ? m : null;
      const wait = key ? gate[key] : null;
      if (key && wait) {
        gate[key] = null;
        await wait();
      }
      return inner.create(m, d);
    },
    findOne: (m, w) => inner.findOne(m, w),
    findMany: (m, w, o) => inner.findMany(m, w, o),
    update: (m, w, d) => inner.update(m, w, d),
    delete: (m, w) => inner.delete(m, w),
    deleteRows: (m, w) => inner.deleteRows(m, w),
    isolated: inner.isolated,
    keep: () => inner.keep(),
    transaction: (fn) => fn(open),
  };
  const input = (storage: StorageAdapter): AuthConfig => ({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    limiter,
    clock,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    password: { hash: FAST, uniformSignUp: false },
    organizations: {},
    username: {},
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    passkey: { ...RP, signUp: { isolateLimiter: "allow" } },
    anonymous: { isolateLimiter: "allow" },
    handoff: { schemes: ["consumera://"] },
    oauth: {
      resources: [RESOURCE],
      scopes: { "mcp:read": "Read your documents" },
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    hooks: {
      session: {
        afterCreate: (e) => {
          created.push(e.session);
        },
        ...(opts.hook
          ? {
              afterEnd: (e) => {
                ended.push(e.reason);
              },
            }
          : {}),
      },
    },
    ...opts.extra,
  });
  /** `handle` that waits for the work after the answer too: a text, a mail, or a hook. */
  const settled = (auth: ReturnType<typeof createAuth>) => ({
    async handle(request: Request): Promise<Response> {
      const after: Promise<unknown>[] = [];
      const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
      await Promise.all(after);
      return res;
    },
  });
  const wrapped = wrap(inner);
  return {
    owner: settled(createAuth(input(wrapped))),
    claimant: settled(createAuth(input(open))),
    config: resolveConfig(input(open)),
    /** The engine view on the owner's store: its transactions undo a throw, as an adapter does. */
    ownerConfig: resolveConfig(input(wrapped)),
    storage: inner,
    mail,
    sms,
    ended,
    created,
    armed,
    gate,
    log,
    clock,
    cap,
  };
}
type World = ReturnType<typeof world>;

let ip = 0;
/** A JSON request of the routes, with the Origin of the app and a new client IP. */
function req(method: "GET" | "POST", path: string, body?: unknown, cookie?: string) {
  return new Request(`${BASE_URL}/auth${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A form request of the OAuth routes. */
function formReq(path: string, body: Record<string, string>, cookie?: string) {
  return new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

/** The session token that an answer sets in the cookie, or null. */
function setToken(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
  const token = line?.slice(COOKIE.length + 1).split(";")[0] ?? "";
  return token === "" ? null : recordCredential(token);
}

const cookieOf = (token: string) => `${COOKIE}=${token}`;

/** The status and the error code of an answer: "200 ok", "403 email_unverified". */
async function answer(res: Response): Promise<string> {
  const text = await res.clone().text();
  let code = "ok";
  try {
    code = (JSON.parse(text || "{}") as { error?: string }).error ?? "ok";
  } catch {
    code = "page";
  }
  return `${res.status} ${code}`;
}

/** The session row of a token. */
async function rowOf(w: World, token: string): Promise<SessionRow | null> {
  return w.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
}

async function userAt(w: World, email: string): Promise<UserRow> {
  const user = await w.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error(`no user at ${email}`);
  return user;
}

/** The claimant: a password sign-up of the owner's address, unverified, with its session. */
async function claimant(w: World): Promise<string> {
  const up = await w.claimant.handle(
    req("POST", "/password/sign-up", { email: CLAIMED, password: PW }),
  );
  expect(await answer(up)).toBe("200 ok");
  const token = setToken(up);
  if (!token) throw new Error("the sign-up set no session cookie");
  expect((await userAt(w, CLAIMED)).emailVerified).toBe(false);
  return token;
}

/**
 * A verified user with a password, through the routes: the sign-up and its
 * verify link. Answers the session token that the link opens.
 */
async function verifiedUser(w: World, email: string): Promise<string> {
  recordAddress(email);
  const up = await w.claimant.handle(req("POST", "/password/sign-up", { email, password: PW }));
  expect(up.status).toBe(200);
  const mail = w.mail.findLast((m) => m.to === email && m.subject.startsWith("Confirm"));
  // The sign-up's own browser keeps the password (ruling 11 of plan 12q).
  const v = await w.claimant.handle(
    req(
      "POST",
      "/password/verify",
      { token: tokenFromMail(mail?.text ?? "") },
      proofCookie(up).cookie,
    ),
  );
  expect(await answer(v)).toBe("200 ok");
  const token = setToken(v);
  if (!token) throw new Error("the verify link set no session cookie");
  return token;
}

/** The owner's magic link, mailed now: the request of its verify. */
async function ownerLink(w: World): Promise<Request> {
  const sent = await w.owner.handle(req("POST", "/magic-link/request", { email: CLAIMED }));
  expect(sent.status).toBe(200);
  const mail = w.mail.findLast((m) => m.to === CLAIMED);
  return req("POST", "/magic-link/verify", { token: tokenFromMail(mail?.text ?? "") });
}

/** A public client of the register route. */
async function client(w: World): Promise<string> {
  const res = await w.claimant.handle(
    new Request(`${BASE_URL}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        grant_types: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
      }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The authorize GET of `clientId` with a PKCE challenge, as a client sends it. */
async function authorizeGet(clientId: string, cookie: string): Promise<Request> {
  const verifier = recordCredential("v".repeat(43));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await sha256Base64UrlOf(verifier),
    code_challenge_method: "S256",
    scope: "openid email mcp:read",
    resource: RESOURCE,
    state: "st-1",
    nonce: "n-1",
  });
  return new Request(`${BASE_URL}/auth/oauth/authorize?${query}`, {
    headers: { cookie, "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}` },
  });
}

async function sha256Base64UrlOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The user code of a device grant that `clientId` started. */
async function deviceCode(w: World, clientId: string): Promise<string> {
  const res = await w.claimant.handle(
    formReq("/oauth/device_authorization", {
      client_id: clientId,
      scope: "mcp:read",
      resource: RESOURCE,
    }),
  );
  expect(res.status).toBe(200);
  return recordCredential(((await res.json()) as { user_code: string }).user_code);
}

/**
 * Each open flow and each reachable gate of a closed flow, as a request of the
 * claimant's session. Each comes with the answer that the rule gives at the
 * flip. The nine open flows come first (inventory-window.md section 1). The
 * first request meets the door of a claimed session, which ends the row
 * (ruling 13 of plan 12q). So each request answers as with no session.
 */
function gateRequests(cookie: string, ctx: { clientId: string; userCode: string }) {
  return [
    ["the API token create", req("POST", "/tokens", { name: "ci" }, cookie), "401 unauthorized"],
    [
      "the change of address",
      req("POST", "/user/change-email", { newEmail: "mallory@example.net" }, cookie),
      "401 unauthorized",
    ],
    [
      "the passkey registration options",
      req("POST", "/passkey/register/options", {}, cookie),
      "401 unauthorized",
    ],
    [
      "the passkey registration verify",
      req(
        "POST",
        "/passkey/register/verify",
        { response: { id: "x", response: { clientDataJSON: "e30" } } },
        cookie,
      ),
      "401 unauthorized",
    ],
    ["the TOTP setup", req("POST", "/totp/setup", { password: PW }, cookie), "401 unauthorized"],
    [
      "the TOTP enable",
      req("POST", "/totp/enable", { code: "123456" }, cookie),
      "401 unauthorized",
    ],
    [
      "the email method enable",
      req("POST", "/second-factor/email/enable", { password: PW }, cookie),
      "401 unauthorized",
    ],
    [
      "the passkey method enable",
      req("POST", "/second-factor/passkey/enable", { password: PW, response: { id: "x" } }, cookie),
      "401 unauthorized",
    ],
    [
      "the organization token create",
      req(
        "POST",
        "/organizations/tokens",
        { organizationId: "01JZZZZZZZZZZZZZZZZZZZZZZZ", name: "ci", permissions: {} },
        cookie,
      ),
      "401 unauthorized",
    ],
    [
      "the username set",
      req("POST", "/user/username", { username: "mallory" }, cookie),
      "401 unauthorized",
    ],
    ["the phone add", req("POST", "/phone/add", { phone: PHONE }, cookie), "401 unauthorized"],
    [
      "the phone add verify",
      req("POST", "/phone/add/verify", { code: "123456" }, cookie),
      "401 unauthorized",
    ],
    ["the token list", req("GET", "/tokens", undefined, cookie), "401 unauthorized"],
    [
      "the profile update",
      req("POST", "/user/update", { name: "Mallory" }, cookie),
      "401 unauthorized",
    ],
    [
      "the password change",
      req(
        "POST",
        "/password/change",
        { currentPassword: PW, newPassword: "another long one" },
        cookie,
      ),
      "401 unauthorized",
    ],
    [
      "the organization create",
      req("POST", "/organizations/create", { slug: "mallory", name: "Mallory" }, cookie),
      "401 unauthorized",
    ],
    [
      "the slug check",
      req("POST", "/organizations/check-slug", { slug: "mallory" }, cookie),
      "401 unauthorized",
    ],
    [
      "the OAuth device approval",
      formReq("/oauth/device", { user_code: ctx.userCode, decision: "allow" }, cookie),
      "401 unauthorized",
    ],
  ] as const;
}

/** The rows that a way in of the claimant would leave, read after the claim. */
async function waysIn(w: World, userId: string) {
  const of = { field: "userId", op: "eq", value: userId } as const;
  const user = await w.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
  const purposes = (
    await w.storage.findMany("verification", [{ field: "identifier", op: "eq", value: userId }])
  )
    .map((r) => r.purpose)
    // The claim's lease is no way in: it stays until the sweep (plan 12p).
    .filter((p) => p !== "magic-link" && p !== "claim-lease");
  return {
    apiTokens: (await w.storage.findMany("apiToken", [of])).length,
    passkeys: (await w.storage.findMany("passkey", [of])).length,
    totp: (await w.storage.findMany("totp", [of])).length,
    secondFactors: (await w.storage.findMany("secondFactor", [of])).length,
    members: (await w.storage.findMany("member", [of])).length,
    organizationTokens: (await w.storage.findMany("organizationToken", [])).length,
    consents: (await w.storage.findMany("oauthConsent", [of])).length,
    approvedDevices: (
      await w.storage.findMany("oauthDevice", [{ field: "status", op: "eq", value: "approved" }])
    ).length,
    proofs: purposes,
    username: user?.username ?? null,
    phone: user?.phone ?? null,
  };
}

describe("a claimant's session at the claim's flip (plan 12p decision 3)", () => {
  for (const hook of [false, true])
    it(`refuses every verified-only action, leaves no row of it, and the first read ends the session (afterEnd hook ${hook}, ruling 13 of plan 12q)`, async () => {
      const w = world({ hook });
      const token = await claimant(w);
      const cookie = cookieOf(token);
      const clientId = await client(w);
      const userCode = await deviceCode(w, clientId);
      const verify = await ownerLink(w);
      const seen: Record<string, string> = {};
      let window: { verified: boolean; proved: boolean } | null = null;
      let authorize: { status: number; client: boolean; code: boolean } | null = null;
      w.armed.run = async () => {
        // The window: the user reads as verified, and the claimant's session row is still there.
        const row = await rowOf(w, token);
        const user = await userAt(w, CLAIMED);
        window = row ? { verified: user.emailVerified, proved: row.proved } : null;
        for (const [name, request, _want] of gateRequests(cookie, { clientId, userCode }))
          seen[name] = await answer(await w.claimant.handle(request));
        const res = await w.claimant.handle(await authorizeGet(clientId, cookie));
        const location = new URL(res.headers.get("location") ?? `${REDIRECT}?none=1`);
        // With no session, the authorize sends the person to sign in, not to the client.
        authorize = {
          status: res.status,
          client: location.href.startsWith(REDIRECT),
          code: location.searchParams.has("code"),
        };
      };
      const owner = await w.owner.handle(verify);
      expect(await answer(owner)).toBe("200 ok");
      expect(w.armed.run).toBeNull();
      expect(window).toEqual({ verified: true, proved: false });
      expect(seen).toEqual(
        Object.fromEntries(
          gateRequests(cookie, { clientId, userCode }).map(([name, , want]) => [name, want]),
        ),
      );
      expect(authorize).toEqual({ status: 302, client: false, code: false });
      // The claim completed: the owner holds a proved session, and the claimant none.
      const user = await userAt(w, CLAIMED);
      expect(user.emailVerified).toBe(true);
      expect(await rowOf(w, token)).toBeNull();
      const ownerToken = setToken(owner);
      expect(ownerToken && (await rowOf(w, ownerToken))?.proved).toBe(true);
      expect(await waysIn(w, user.id)).toEqual({
        apiTokens: 0,
        passkeys: 0,
        totp: 0,
        secondFactors: 0,
        members: 0,
        organizationTokens: 0,
        consents: 0,
        approvedDevices: 0,
        proofs: [],
        username: null,
        phone: null,
      });
      // The first gate request ended the session, so the claim's own delete found none.
      expect(w.ended).toEqual(hook ? ["claimed"] : []);
      // The owner's own session passes the same gate.
      const made = await w.claimant.handle(
        req("POST", "/tokens", { name: "owner" }, cookieOf(ownerToken ?? "")),
      );
      expect(await answer(made)).toBe("200 ok");
    });

  it("mints no session JWT at the flip, and a JWT from before the claim is not live (ruling 13 of plan 12q)", async () => {
    const w = world();
    const token = await claimant(w);
    // Before the claim: the claimant's JWT says email_verified false, and its session is live.
    const before = await w.claimant.handle(req("GET", "/token", undefined, cookieOf(token)));
    expect(before.status).toBe(200);
    const jwt = ((await before.json()) as { token: string }).token;
    expect(decodeJws(jwt)?.payload.email_verified).toBe(false);
    const row = await rowOf(w, token);
    if (!row) throw new Error("no session");
    expect(await sessionLive(w.config, { sid: row.id })).toBe(true);
    const verify = await ownerLink(w);
    const atFlip: Record<string, unknown> = {};
    w.armed.run = async () => {
      // The two reads first: they write nothing, so the row stays for the route.
      atFlip.live = await sessionLive(w.config, { sid: row.id });
      atFlip.mint = await mintSessionJwt(w.config, { userId: row.userId, sessionId: row.id });
      atFlip.row = (await rowOf(w, token)) !== null;
      atFlip.route = await answer(
        await w.claimant.handle(req("GET", "/token", undefined, cookieOf(token))),
      );
    };
    expect(await answer(await w.owner.handle(verify))).toBe("200 ok");
    expect(atFlip).toEqual({
      live: false,
      mint: { ok: false, code: "unauthorized", status: 401 },
      row: true,
      route: "401 unauthorized",
    });
  });
});

describe("the proof flag at the session's creation (plan 12p decision 2)", () => {
  it("is false for the session of an unverified sign-up and true after the owner's proof", async () => {
    const w = world();
    const token = await claimant(w);
    expect((await rowOf(w, token))?.proved).toBe(false);
    const owner = await w.owner.handle(await ownerLink(w));
    const ownerToken = setToken(owner);
    expect(ownerToken && (await rowOf(w, ownerToken))?.proved).toBe(true);
    // The verify link of a sign-up, then a password sign-in, of a verified user: true.
    const linked = await verifiedUser(w, "bob@example.com");
    expect((await rowOf(w, linked))?.proved).toBe(true);
    const signIn = await w.claimant.handle(
      req("POST", "/password/sign-in", { email: "bob@example.com", password: PW }),
    );
    expect(await answer(signIn)).toBe("200 ok");
    const signed = setToken(signIn);
    expect(signed && (await rowOf(w, signed))?.proved).toBe(true);
  });

  it("is false for an anonymous session and true for a phone sign-in of a user with no address", async () => {
    const w = world();
    const anon = await w.claimant.handle(req("POST", "/anonymous/sign-in", {}));
    expect(anon.status).toBe(200);
    const anonToken = setToken(anon);
    expect(anonToken && (await rowOf(w, anonToken))?.proved).toBe(false);
    expect((await w.claimant.handle(req("POST", "/phone/request", { phone: PHONE }))).status).toBe(
      200,
    );
    const code = /^(\d+) is your /.exec(
      w.sms.sent.findLast((s) => s.to === PHONE)?.text ?? "",
    )?.[1];
    const phoned = await w.claimant.handle(req("POST", "/phone/verify", { phone: PHONE, code }));
    expect(await answer(phoned)).toBe("200 ok");
    const phoneToken = setToken(phoned);
    const row = phoneToken ? await rowOf(w, phoneToken) : null;
    expect(row?.proved).toBe(true);
    // The phone user holds the verified powers on it: a token create passes.
    const made = await w.claimant.handle(
      req("POST", "/tokens", { name: "ci" }, cookieOf(phoneToken ?? "")),
    );
    expect(await answer(made)).toBe("200 ok");
  });

  it("is true for a passkey sign-up and for a passkey sign-in of that user with no address", async () => {
    const w = world();
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const options = await w.claimant.handle(
      req("POST", "/passkey/sign-up/options", { name: "Pat" }),
    );
    expect(options.status).toBe(200);
    const o = (await options.json()) as { challenge: string; user: { id: string } };
    const userId = Uint8Array.from(atob(o.user.id.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    const up = await w.claimant.handle(
      req("POST", "/passkey/sign-up/verify", {
        response: await soft.register(o.challenge, userId),
      }),
    );
    expect(await answer(up)).toBe("200 ok");
    const upToken = setToken(up);
    expect(upToken && (await rowOf(w, upToken))?.proved).toBe(true);
    const signIn = await w.claimant.handle(req("POST", "/passkey/authenticate/options", {}));
    const challenge = ((await signIn.json()) as { challenge: string }).challenge;
    const done = await w.claimant.handle(
      req("POST", "/passkey/authenticate/verify", { response: await soft.authenticate(challenge) }),
    );
    expect(await answer(done)).toBe("200 ok");
    const inToken = setToken(done);
    expect(inToken && (await rowOf(w, inToken))?.proved).toBe(true);
  });

  it("copies the flag of the browser session at a handoff", async () => {
    const w = world();
    /** A handoff of the browser session of `browser`, to its redeem: the `proved` flag of the new session. */
    const redeem = async (browser: string) => {
      const live = await resolveSession(w.config, browser);
      if (!live) throw new Error("no browser session");
      const verifier = recordCredential("h".repeat(43));
      const started = await startHandoff(w.config, {
        challenge: await sha256Base64UrlOf(verifier),
        redirect: "consumera://auth",
        ip: null,
      });
      if (!started.ok) throw new Error(started.code);
      const cont = await continueHandoff(w.config, {
        handoffId: started.value.handoffId,
        userId: live.user.id,
        sessionId: live.session.id,
      });
      if (!cont.ok) throw new Error(cont.code);
      const code = new URL(cont.value.location).searchParams.get("code") ?? "";
      const r = await redeemHandoff(w.config, {
        code: recordCredential(code),
        verifier,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      recordCredential(r.value.token);
      return r.value.session.proved;
    };
    // The unverified claimant's browser session: the redeemed session is not proved.
    expect(await redeem(await claimant(w))).toBe(false);
    // The owner's browser session after the proof: the redeemed session is proved.
    const ownerToken = setToken(await w.owner.handle(await ownerLink(w)));
    expect(await redeem(ownerToken ?? "")).toBe(true);
    // A phone user with no address: the code's session is proved, so the redeemed one is too.
    expect(await redeem(await phoneUser(w))).toBe(true);
  });

  it("refuses the redeem of a code that a claimant's browser minted after the claim deleted the codes", async () => {
    const w = world();
    const token = await claimant(w);
    const live = await resolveSession(w.config, token);
    if (!live) throw new Error("no browser session");
    const verifier = recordCredential("m".repeat(43));
    const started = await startHandoff(w.config, {
      challenge: await sha256Base64UrlOf(verifier),
      redirect: "consumera://auth",
      ip: null,
    });
    if (!started.ok) throw new Error(started.code);
    const verify = await ownerLink(w);
    let code: string | null = null;
    // The claim deleted the handoff codes and not yet the sessions: the browser session still passes.
    w.armed.at = "handoff-delete";
    w.armed.run = async () => {
      const cont = await continueHandoff(w.config, {
        handoffId: started.value.handoffId,
        userId: live.user.id,
        sessionId: live.session.id,
      });
      if (!cont.ok) throw new Error(cont.code);
      code = recordCredential(new URL(cont.value.location).searchParams.get("code") ?? "");
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(w.armed.run).toBeNull();
    const minted = code as string | null;
    if (!minted) throw new Error("no code");
    // The code outlived the claim, but its redeem opens no session.
    const r = await redeemHandoff(w.ownerConfig, {
      code: minted,
      verifier,
      ip: null,
      userAgent: null,
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    const user = await userAt(w, CLAIMED);
    const sessions = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(sessions.map((x) => x.id)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });

  it("takes the state of the target at an impersonation start", async () => {
    const operator: AuthConfig["operator"] = {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
      ],
      users: true,
      impersonation: {},
    };
    const sms = createRecordingSms();
    const phone = { sms, regions: ["+1"], isolateLimiter: "allow" as const, signUp: true };
    const f = await operatorFixture({ config: { operator, phone } });
    const start = (userId: string) =>
      startImpersonation(f.auth.config, {
        operator: f.operator,
        userId,
        reason: "Support case 4711",
        ip: null,
        userAgent: null,
      });
    // A target with a verified address.
    const target = await verifiedSession(f.auth, "target@example.com");
    const r = await start(target.user.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.session.proved).toBe(true);
    // A target with no address: a phone user, by the code of its sign-up.
    const sent = await requestPhone(f.auth.config, { phone: PHONE, ip: null });
    expect(sent.ok).toBe(true);
    const code = /^(\d+) is your /.exec(sms.sent.findLast((x) => x.to === PHONE)?.text ?? "")?.[1];
    const signed = await verifyPhone(f.auth.config, {
      phone: PHONE,
      code: code ?? "",
      ip: null,
      userAgent: null,
    });
    if (!signed.ok || !("token" in signed.value)) throw new Error("no phone session");
    const phoned = await start(signed.value.user.id);
    if (!phoned.ok) throw new Error(phoned.code);
    expect(phoned.value.session.proved).toBe(true);
  });

  it("refuses a session.beforeCreate patch that names proved (decision 9)", async () => {
    const beforeCreate = vi.fn(() => ({ proved: true }) as never);
    const w = world({ extra: { hooks: { session: { beforeCreate } } } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const up = await w.claimant.handle(
      req("POST", "/password/sign-up", { email: CLAIMED, password: PW }),
    );
    expect(await answer(up)).toBe("500 hook_failed");
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([["authtempo: session patch refused", "the field proved"]]);
    log.mockRestore();
    expect(await w.storage.findMany("session", [])).toEqual([]);
  });
});

describe("the rule of the helpers (plan 12p decision 3)", () => {
  it("reads the session flag with the user's flag, and keeps the user row's rule for a caller with no session", async () => {
    const w = world();
    const token = await claimant(w);
    const unverified = await resolveSession(w.config, token);
    if (!unverified) throw new Error("no session");
    let atFlip: ProofCaller | null = null;
    w.armed.run = async () => {
      // The rows as the claim leaves them at its flip. A session read now ends
      // the session (ruling 13 of plan 12q), so the rows come from the store.
      const session = await rowOf(w, token);
      if (session) atFlip = { user: await userAt(w, CLAIMED), session };
    };
    const ownerToken = setToken(await w.owner.handle(await ownerLink(w)));
    const owner = await resolveSession(w.config, ownerToken ?? "");
    if (!atFlip || !owner) throw new Error("no session");
    const claimantAtFlip: ProofCaller = atFlip;
    const rule = async (caller: ProofCaller) => [
      sessionProved(caller),
      await handleProved(w.config, w.storage, caller),
      provedAccount(caller),
      provedAddress(caller),
      verified(caller).ok,
    ];
    // Before the claim: an unverified user and an unproved session.
    expect(await rule(unverified)).toEqual([false, false, false, false, false]);
    // At the flip: a verified user and the unproved session of the claimant.
    expect(claimantAtFlip.user.emailVerified).toBe(true);
    expect(await rule(claimantAtFlip)).toEqual([false, false, false, false, false]);
    // The same user with no session (a token caller, or an app's own read): the user row's rule.
    expect(await rule({ user: claimantAtFlip.user })).toEqual([true, true, true, true, true]);
    // The owner's session after the proof.
    expect(await rule(owner)).toEqual([true, true, true, true, true]);
  });
});

describe("the claim's order (ruling 16 of plan 12p)", () => {
  for (const hook of [false, true])
    it(`takes the lease, deletes every row a sign-in trusts, flips the flag, and ends the sessions last (afterEnd hook ${hook})`, async () => {
      const w = world({ hook });
      await claimant(w);
      const verify = await ownerLink(w);
      w.log.writes = [];
      expect(await answer(await w.owner.handle(verify))).toBe("200 ok");
      const writes = w.log.writes;
      w.log.writes = null;
      // The memory store has no isolation, so the first write of the claim is the lease.
      const lease = writes.indexOf("create:verification");
      expect(lease).toBeGreaterThanOrEqual(0);
      // The sessions last: a chunk delete of the read ids with the hook, then the delete by user id.
      const sessions = hook ? ["deleteRows:session", "delete:session"] : ["delete:session"];
      expect(writes.slice(lease, lease + 7 + sessions.length)).toEqual([
        "create:verification",
        "delete:identity",
        "delete:password",
        "delete:passkey",
        "delete:verification",
        "delete:verification",
        "flip:user",
        ...sessions,
      ]);
      const user = await userAt(w, CLAIMED);
      const row = await w.storage.findOne("verification", [
        { field: "id", op: "eq", value: claimLeaseId(user.id) },
      ]);
      expect(row).toMatchObject({ purpose: "claim-lease", identifier: user.id });
    });
});

/** A deferred promise: `wait` settles when the test calls `open`. */
function latch() {
  let open = () => {};
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

/** The ids of the sessions of the claimed user. */
async function sessionIds(w: World): Promise<string[]> {
  const user = await userAt(w, CLAIMED);
  const rows = await w.storage.findMany("session", [{ field: "userId", op: "eq", value: user.id }]);
  return rows.map((x) => x.id).sort();
}

/** The answer of a token create by the session of `token`. */
async function tokenCreate(w: World, token: string): Promise<string> {
  return answer(await w.claimant.handle(req("POST", "/tokens", { name: "ci" }, cookieOf(token))));
}

describe("a password sign-in that straddles the claim (ruling 16 of plan 12p)", () => {
  it("(a) reads the user after the flip, finds no password row, and opens no session", async () => {
    const w = world();
    const token = await claimant(w);
    const verify = await ownerLink(w);
    let late: string | null = null;
    w.armed.run = async () => {
      const res = await w.claimant.handle(
        req("POST", "/password/sign-in", { email: CLAIMED, password: PW }),
      );
      late = `${await answer(res)} ${setToken(res) === null ? "no session" : "a session"}`;
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(w.armed.run).toBeNull();
    expect(late).toBe("401 invalid_credentials no session");
    expect(await rowOf(w, token)).toBeNull();
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });

  it("(b) reads the user before the flip, commits an unproved session, and the claim's session delete removes it", async () => {
    const w = world();
    await claimant(w);
    const verify = await ownerLink(w);
    let inside: { signIn: string; proved: boolean | undefined; token: string } | null = null;
    w.armed.at = "lease";
    w.armed.run = async () => {
      // The claim took its lease and deleted nothing yet: the sign-in reads the user unverified.
      const res = await w.claimant.handle(
        req("POST", "/password/sign-in", { email: CLAIMED, password: PW }),
      );
      const made = setToken(res) ?? "";
      inside = {
        signIn: await answer(res),
        proved: (await rowOf(w, made))?.proved,
        token: await tokenCreate(w, made),
      };
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(inside).toEqual({ signIn: "200 ok", proved: false, token: "403 email_unverified" });
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
    expect(await w.storage.findMany("apiToken", [])).toEqual([]);
  });

  it("undoes the session of a sign-in that read its password before the claim's delete and inserts after the claim (decision 6)", async () => {
    const w = world();
    const token = await claimant(w);
    const verify = await ownerLink(w);
    const atInsert = latch();
    const release = latch();
    let signIn: Promise<Response> | null = null;
    w.armed.at = "lease";
    w.armed.run = async () => {
      // The claimant's sign-in reads the user and the password row, checks the
      // password, and stops before its session insert, while the claim goes on.
      w.gate.session = async () => {
        atInsert.open();
        await release.wait;
      };
      signIn = w.claimant.handle(
        req("POST", "/password/sign-in", { email: CLAIMED, password: PW }),
      );
      await atInsert.wait;
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    // The claim ran to its end: the password rows and the sessions are gone.
    const user = await userAt(w, CLAIMED);
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user.id }]),
    ).toEqual([]);
    release.open();
    const late = await (signIn as Promise<Response> | null);
    if (!late) throw new Error("the sign-in did not start");
    expect(await answer(late)).toBe("401 invalid_credentials");
    expect(setToken(late)).toBeNull();
    // Only the owner's session of the proof is left.
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
    expect(await rowOf(w, token)).toBeNull();
  });
});

/** A handoff code that the claimant's browser session mints before the claim, with its verifier. */
async function claimantCode(w: World, token: string) {
  const live = await resolveSession(w.config, token);
  if (!live) throw new Error("no browser session");
  const verifier = recordCredential("s".repeat(43));
  const started = await startHandoff(w.config, {
    challenge: await sha256Base64UrlOf(verifier),
    redirect: "consumera://auth",
    ip: null,
  });
  if (!started.ok) throw new Error(started.code);
  const cont = await continueHandoff(w.config, {
    handoffId: started.value.handoffId,
    userId: live.user.id,
    sessionId: live.session.id,
  });
  if (!cont.ok) throw new Error(cont.code);
  const code = recordCredential(new URL(cont.value.location).searchParams.get("code") ?? "");
  return { code, verifier };
}

describe("a handoff redeem that straddles the claim (ruling 16 of plan 12p)", () => {
  it("(a) runs after the flip, finds no code, and opens no session", async () => {
    const w = world();
    const minted = await claimantCode(w, await claimant(w));
    const verify = await ownerLink(w);
    let late: { codes: number; redeem: string } | null = null;
    w.armed.run = async () => {
      // The claim deleted the codes of the user before the flip. The start row names no user.
      const user = await userAt(w, CLAIMED);
      const codes = await w.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "handoff-code" },
        { field: "identifier", op: "eq", value: user.id },
      ]);
      const r = await redeemHandoff(w.config, { ...minted, ip: null, userAgent: null });
      late = { codes: codes.length, redeem: r.ok ? "ok" : r.code };
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(late).toEqual({ codes: 0, redeem: "invalid_token" });
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });

  it("(b) runs before the delete of the code, commits an unproved session, and the claim's session delete removes it", async () => {
    const w = world();
    const minted = await claimantCode(w, await claimant(w));
    const verify = await ownerLink(w);
    let inside: { code: string; proved: boolean | undefined; token: string } | null = null;
    w.armed.at = "lease";
    w.armed.run = async () => {
      const r = await redeemHandoff(w.config, { ...minted, ip: null, userAgent: null });
      if (!r.ok) throw new Error(r.code);
      const made = recordCredential(r.value.token);
      inside = {
        code: "ok",
        proved: (await rowOf(w, made))?.proved,
        token: await tokenCreate(w, made),
      };
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(inside).toEqual({ code: "ok", proved: false, token: "403 email_unverified" });
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
    expect(await w.storage.findMany("apiToken", [])).toEqual([]);
  });
});

/**
 * A world with Google sign-in. `callback` runs one Google sign-in on
 * `config`: the subject `g-claimant`, the claimed address, and the address
 * unverified, as some providers report it.
 */
function socialWorld() {
  const tokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = tokenEndpoint("idtok-default");
  const w = world({ extra: { social: { google: GOOGLE, fetch: fetchFn }, jwt: fakeJwt(tokens) } });
  const callback = async (config: ResolvedConfig = w.config) => {
    const started = await startSocial(config, { provider: "google", next: "/home", ip: "1.1.1.1" });
    if (!started.ok) throw new Error(started.code);
    const url = new URL(started.value.location);
    tokens["idtok-default"] = googleClaims(url.searchParams.get("nonce") ?? "", {
      sub: "g-claimant",
      email: CLAIMED,
      email_verified: false,
    });
    const done = await completeSocial(config, {
      provider: "google",
      state: url.searchParams.get("state") ?? "",
      code: "c",
      error: null,
      bindToken: started.value.bindToken,
      ip: null,
      userAgent: null,
    });
    if (!done.ok) return { code: done.code, token: null };
    if (!("token" in done.value)) throw new Error("the sign-in answered a challenge");
    return { code: "ok", token: recordCredential(done.value.token) };
  };
  return { w, callback };
}

describe("a social sign-in that straddles the claim (ruling 16 of plan 12p)", () => {
  it("(a) reads the user after the flip, finds no identity, and opens no session", async () => {
    const { w, callback } = socialWorld();
    const first = await callback();
    expect(first.code).toBe("ok");
    const verify = await ownerLink(w);
    let late: { code: string; token: string | null } | null = null;
    w.armed.run = async () => {
      late = await callback();
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(w.armed.run).toBeNull();
    expect(late).toEqual({ code: "email_taken_unverified", token: null });
    expect(await rowOf(w, first.token ?? "")).toBeNull();
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
    const user = await userAt(w, CLAIMED);
    expect(
      (await w.storage.findMany("identity", [{ field: "userId", op: "eq", value: user.id }])).map(
        (i) => i.provider,
      ),
    ).toEqual(["email"]);
  });

  it("(b) reads the user before the flip, commits an unproved session, and the claim's session delete removes it", async () => {
    const { w, callback } = socialWorld();
    expect((await callback()).code).toBe("ok");
    const verify = await ownerLink(w);
    let inside: { code: string; proved: boolean | undefined; token: string } | null = null;
    w.armed.at = "lease";
    w.armed.run = async () => {
      const signed = await callback();
      inside = {
        code: signed.code,
        proved: (await rowOf(w, signed.token ?? ""))?.proved,
        token: await tokenCreate(w, signed.token ?? ""),
      };
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(inside).toEqual({ code: "ok", proved: false, token: "403 email_unverified" });
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
    expect(await w.storage.findMany("apiToken", [])).toEqual([]);
  });
});

/**
 * A flow that creates a row of a new user that the claim deletes (deviation
 * of Task 2b). The claim runs between the user create and that row's
 * create. The claim's delete then finds no row, and its flip comes after the
 * flow's guard. The guard reads the lease, so the row goes.
 */
describe("a sign-up that straddles the claim (ruling 16 of plan 12p, the lease read)", () => {
  it("the password sign-up: its password row does not outlive the claim", async () => {
    const w = world();
    // The owner asks for a magic link before any user holds the address.
    const verify = await ownerLink(w);
    const atPassword = latch();
    const release = latch();
    w.gate.password = async () => {
      atPassword.open();
      await release.wait;
    };
    const up = w.claimant.handle(
      req("POST", "/password/sign-up", { email: CLAIMED, password: PW }),
    );
    // The sign-up created its user and waits before its password create.
    await atPassword.wait;
    let signUp: string | null = null;
    w.armed.at = "password-delete";
    w.armed.run = async () => {
      release.open();
      const res = await up;
      signUp = `${await answer(res)} ${setToken(res) === null ? "no session" : "a session"}`;
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(signUp).toBe("409 email_taken_unverified no session");
    const user = await userAt(w, CLAIMED);
    expect(user.emailVerified).toBe(true);
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user.id }]),
    ).toEqual([]);
    const again = await w.claimant.handle(
      req("POST", "/password/sign-in", { email: CLAIMED, password: PW }),
    );
    expect(await answer(again)).toBe("401 invalid_credentials");
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });

  it("the uniform sign-up: its password row does not outlive the claim", async () => {
    const w = world({ extra: { password: { hash: FAST, uniformSignUp: true } } });
    const verify = await ownerLink(w);
    const atPassword = latch();
    const release = latch();
    w.gate.password = async () => {
      atPassword.open();
      await release.wait;
    };
    const up = w.claimant.handle(
      req("POST", "/password/sign-up", { email: CLAIMED, password: PW }),
    );
    await atPassword.wait;
    let signUp: string | null = null;
    w.armed.at = "password-delete";
    w.armed.run = async () => {
      release.open();
      signUp = await answer(await up);
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    // The uniform answer tells nothing.
    expect(signUp).toBe("200 ok");
    const user = await userAt(w, CLAIMED);
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user.id }]),
    ).toEqual([]);
    const again = await w.claimant.handle(
      req("POST", "/password/sign-in", { email: CLAIMED, password: PW }),
    );
    expect(await answer(again)).toBe("401 invalid_credentials");
  });

  it("the social sign-up of a new user: its identity does not outlive the claim", async () => {
    const { w, callback } = socialWorld();
    const verify = await ownerLink(w);
    const atIdentity = latch();
    const release = latch();
    w.gate.identity = async () => {
      atIdentity.open();
      await release.wait;
    };
    const up = callback();
    await atIdentity.wait;
    let signUp: { code: string; token: string | null } | null = null;
    w.armed.at = "identity-delete";
    w.armed.run = async () => {
      release.open();
      signUp = await up;
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(signUp).toEqual({ code: "email_taken_unverified", token: null });
    const user = await userAt(w, CLAIMED);
    expect(
      (await w.storage.findMany("identity", [{ field: "userId", op: "eq", value: user.id }])).map(
        (i) => i.provider,
      ),
    ).toEqual(["email"]);
    // The claimant's Google account signs in to nothing.
    expect(await callback()).toEqual({ code: "email_taken_unverified", token: null });
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });
});

/** Every row of every table, but the magic links: a flow that answers 409 mails a new one. */
async function tables(w: World) {
  const out: Record<string, unknown[]> = {};
  for (const model of Object.keys(schema) as ModelName[]) {
    const rows = await w.storage.findMany(model, []);
    out[model] =
      model === "verification"
        ? rows.filter((r) => (r as VerificationRow).purpose !== "magic-link")
        : rows;
  }
  return out;
}

/** The token of a new magic link of the owner's address. */
async function ownerLinkToken(w: World): Promise<string> {
  const sent = await w.owner.handle(req("POST", "/magic-link/request", { email: CLAIMED }));
  expect(sent.status).toBe(200);
  return tokenFromMail(w.mail.findLast((m) => m.to === CLAIMED)?.text ?? "");
}

describe("the lease of a claim (ruling 16 of plan 12p)", () => {
  it("answers 409 conflict to a second claim while the lease is held, and the second claim writes nothing", async () => {
    const w = world();
    await claimant(w);
    const first = await ownerLink(w);
    const second = await ownerLink(w);
    let before: Record<string, unknown[]> | null = null;
    let after: Record<string, unknown[]> | null = null;
    let rival: string | null = null;
    w.armed.at = "lease";
    w.armed.run = async () => {
      before = await tables(w);
      rival = await answer(await w.claimant.handle(second));
      after = await tables(w);
    };
    const owner = await w.owner.handle(first);
    expect(await answer(owner)).toBe("200 ok");
    expect(rival).toBe("409 conflict");
    expect(before).not.toBeNull();
    expect(after).toEqual(before);
    // The first claim completed.
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });

  it("takes a stale lease: a claim that ran out of queries after its lease left it, and a claim 60 seconds later claims", async () => {
    const w = world();
    const token = await claimant(w);
    const user = await userAt(w, CLAIMED);
    const link = await ownerLinkToken(w);
    // The owner's first proof runs out of queries right after its lease, as a
    // D1 request at query 51 does. Its undo runs out too, so the lease stays.
    w.armed.at = "lease";
    w.armed.run = async () => {
      w.cap.on = true;
    };
    const failed = await verifyMagicLink(d1Like(w.ownerConfig), {
      token: link,
      ip: null,
      userAgent: null,
    }).then(
      (r) => (r.ok ? "ok" : r.code),
      (e: unknown) => (e instanceof StorageError ? e.code : String(e)),
    );
    w.cap.on = false;
    expect(failed).toBe("rollback_failed");
    const lease = () =>
      w.storage.findOne("verification", [{ field: "id", op: "eq", value: claimLeaseId(user.id) }]);
    const left = await lease();
    expect(left?.expiresAt).toEqual(new Date(w.clock.now().getTime() + CLAIM_LEASE_MS));
    // The claim wrote nothing else: the claimant keeps its password and session.
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(false);
    expect((await rowOf(w, token))?.userId).toBe(user.id);
    // Inside the 60 seconds a proof meets the live lease.
    expect(await answer(await w.owner.handle(await ownerLink(w)))).toBe("409 conflict");
    w.clock.advance(CLAIM_LEASE_MS + 1);
    const owner = await w.owner.handle(await ownerLink(w));
    expect(await answer(owner)).toBe("200 ok");
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
    expect((await lease())?.expiresAt).toEqual(new Date(w.clock.now().getTime() + CLAIM_LEASE_MS));
    expect(await rowOf(w, token)).toBeNull();
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user.id }]),
    ).toEqual([]);
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });

  it("takes a stale lease with an expiry from the clock at the take, after a flow that waited 61 seconds (ruling 35 of plan 12p)", async () => {
    // A capped claim leaves its lease, and 61 seconds go by. Then a proof
    // fixes its time and waits 61 seconds more in user.beforeVerify. Its
    // take of the stale lease must count the life from the clock there.
    const late = { armed: false };
    const w = world({
      extra: {
        hooks: {
          user: {
            beforeVerify: async () => {
              if (!late.armed) return;
              late.armed = false;
              w.clock.advance(CLAIM_LEASE_MS + 1_000);
            },
          },
        },
      },
    });
    await claimant(w);
    const user = await userAt(w, CLAIMED);
    const link = await ownerLinkToken(w);
    w.armed.at = "lease";
    w.armed.run = async () => {
      w.cap.on = true;
    };
    const failed = await verifyMagicLink(d1Like(w.ownerConfig), {
      token: link,
      ip: null,
      userAgent: null,
    }).then(
      (r) => (r.ok ? "ok" : r.code),
      (e: unknown) => (e instanceof StorageError ? e.code : String(e)),
    );
    w.cap.on = false;
    expect(failed).toBe("rollback_failed");
    w.clock.advance(CLAIM_LEASE_MS + 1);
    const proof = await ownerLink(w);
    late.armed = true;
    const owner = await w.owner.handle(proof);
    expect(await answer(owner)).toBe("200 ok");
    expect(late.armed).toBe(false);
    const lease = () =>
      w.storage.findOne("verification", [{ field: "id", op: "eq", value: claimLeaseId(user.id) }]);
    expect((await lease())?.expiresAt).toEqual(new Date(w.clock.now().getTime() + CLAIM_LEASE_MS));
    // So a sweep at that time keeps it.
    await sweepExpired(w.config);
    expect(await lease()).not.toBeNull();
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
  });

  it("undoes the deletes of a late claim whose lease came after a rival claim ended: the rival's password is back", async () => {
    // The rival, the owner's reset, takes its lease. Then 61 seconds go by
    // before its deletes, so its lease is stale. A claim runs no hook after
    // its lease, so only slow statements make that wait. The test forces it.
    // The late claim, a magic link, starts in that wait and reads the user
    // unverified. It lets the rival end, takes the stale lease, deletes, and
    // its flip matches no row. The D1 view undoes only what the late claim
    // wrote. A wait before the rival's lease makes no stale lease (ruling 35
    // of plan 12p): the next test holds that scene.
    const rival = { done: latch() };
    const arrived = latch();
    const w = world({
      extra: {
        hooks: {
          user: {
            beforeVerify: async ({ via }) => {
              if (via !== "magic_link") return;
              arrived.open();
              await rival.done.wait;
            },
          },
        },
      },
    });
    await claimant(w);
    const link = await ownerLinkToken(w);
    const NEW = recordCredential("the owner's new password");
    const asked = await w.claimant.handle(
      req("POST", "/password/reset/request", { email: CLAIMED }),
    );
    expect(asked.status).toBe(200);
    const resetToken = tokenFromMail(w.mail.findLast((m) => m.to === CLAIMED)?.text ?? "");
    // The rival runs on the owner's store. Right after its lease, the clock
    // moves, and the late claim starts on the D1 view with no lock.
    let late: ReturnType<typeof verifyMagicLink> | null = null;
    w.armed.at = "lease";
    w.armed.run = async () => {
      w.clock.advance(CLAIM_LEASE_MS + 1);
      late = verifyMagicLink(d1Like(w.ownerConfig), { token: link, ip: null, userAgent: null });
      await arrived.wait;
    };
    const res = await w.owner.handle(
      req("POST", "/password/reset", { token: resetToken, password: NEW }),
    );
    const won = { answer: await answer(res), token: setToken(res) };
    expect(won.answer).toBe("200 ok");
    // The writes of the late claim, from here.
    w.log.writes = [];
    rival.done.open();
    const lateAnswer = await (late as ReturnType<typeof verifyMagicLink> | null);
    const writes = w.log.writes ?? [];
    w.log.writes = null;
    // It took the stale lease and deleted. Its flip matched no row, so it
    // threw and undid its deletes. Its retry found the verified user and signed in.
    const take = writes.indexOf("update:verification");
    expect(take).toBeGreaterThan(writes.indexOf("create:verification"));
    expect(writes.indexOf("delete:password")).toBeGreaterThan(take);
    expect(writes.indexOf("flip:user")).toBeGreaterThan(writes.indexOf("delete:password"));
    expect(lateAnswer?.ok).toBe(true);
    const user = await userAt(w, CLAIMED);
    expect(user.emailVerified).toBe(true);
    // The rival's kept rows are back: its password signs in, and its session lives.
    expect((await rowOf(w, won.token ?? ""))?.userId).toBe(user.id);
    const signIn = await w.claimant.handle(
      req("POST", "/password/sign-in", { email: CLAIMED, password: NEW }),
    );
    expect(await answer(signIn)).toBe("200 ok");
  });

  it("keeps the lease of a claim whose flow waited 61 seconds through a sweep, and a second claim answers 409 (ruling 35 of plan 12p)", async () => {
    // A flow fixes its time at its start. The owner's magic link then waits
    // 61 seconds in user.beforeVerify, as a slow hook does. Its lease lives
    // 60 seconds from the clock at its write. So a sweep inside the claim
    // keeps it, and a second proof meets it and writes nothing.
    let waited = false;
    const w = world({
      extra: {
        hooks: {
          user: {
            beforeVerify: async () => {
              if (waited) return;
              waited = true;
              w.clock.advance(CLAIM_LEASE_MS + 1_000);
            },
          },
        },
      },
    });
    const token = await claimant(w);
    const user = await userAt(w, CLAIMED);
    const first = await ownerLink(w);
    const second = await ownerLink(w);
    const lease = () =>
      w.storage.findOne("verification", [{ field: "id", op: "eq", value: claimLeaseId(user.id) }]);
    const seen: { atLease: unknown; afterSweep: unknown; rival: string | null } = {
      atLease: null,
      afterSweep: null,
      rival: null,
    };
    // Right after the lease: the sweep, then the second proof.
    w.armed.at = "lease";
    w.armed.run = async () => {
      seen.atLease = await lease();
      await sweepExpired(w.config);
      seen.afterSweep = await lease();
      seen.rival = await answer(await w.claimant.handle(second));
    };
    const start = w.clock.now();
    const owner = await w.owner.handle(first);
    expect(await answer(owner)).toBe("200 ok");
    expect(waited).toBe(true);
    // The answers first. After a sweep that took the lease, the second claim would claim.
    expect(seen.rival).toBe("409 conflict");
    expect(seen.afterSweep).toEqual(seen.atLease);
    // The flow's time is 61 seconds old at the lease. The expiry counts from the clock there.
    expect((seen.atLease as VerificationRow | null)?.expiresAt).toEqual(
      new Date(start.getTime() + CLAIM_LEASE_MS + 1_000 + CLAIM_LEASE_MS),
    );
    // The first claim completed: the claimant keeps no session and no password.
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
    expect(await rowOf(w, token)).toBeNull();
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user.id }]),
    ).toEqual([]);
    expect(await sessionIds(w)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
  });

  it("waits before the retry of a held lease, so a second proof at once signs in (ruling 24 of plan 12p)", async () => {
    // Two magic links of the owner's address at once, on the D1 view of the
    // memory store. It has no transaction lock, an undo log, and claim
    // retries, as the SQLite drivers have. The first proof takes the lease.
    // It waits until the second met the lease at each of its runs, or 50 ms.
    const w = world();
    const token = await claimant(w);
    const first = await ownerLinkToken(w);
    const second = await ownerLinkToken(w);
    const held = { count: 0, every: latch() };
    const raw = w.ownerConfig.storage;
    const counted: StorageAdapter = {
      ...raw,
      create: async (m, d) => {
        try {
          return await raw.create(m, d);
        } catch (err) {
          if (isLease(m, d) && err instanceof StorageError && err.code === "unique_violation") {
            held.count++;
            if (held.count > CLAIM_RUNS) held.every.open();
          }
          throw err;
        }
      },
    };
    let rival: Promise<string> | null = null;
    w.armed.at = "lease";
    w.armed.run = async () => {
      rival = verifyMagicLink(d1Like({ ...w.ownerConfig, storage: counted }), {
        token: second,
        ip: null,
        userAgent: null,
      }).then((r) => (r.ok ? "ok" : r.code));
      await Promise.race([held.every.wait, new Promise((r) => setTimeout(r, 50))]);
    };
    const won = await verifyMagicLink(d1Like(w.ownerConfig), {
      token: first,
      ip: null,
      userAgent: null,
    });
    expect(won.ok).toBe(true);
    expect(rival).not.toBeNull();
    // The second proof met the lease once. After the wait, its retry found the verified user.
    expect(await rival).toBe("ok");
    expect(held.count).toBe(1);
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
    expect(await rowOf(w, token)).toBeNull();
    const rows = await w.storage.findMany("session", []);
    expect(rows.map((x) => x.proved)).toEqual([true, true]);
  });

  it("stays after the claim, and the sweep deletes it after 60 seconds", async () => {
    const w = world();
    await claimant(w);
    expect(await answer(await w.owner.handle(await ownerLink(w)))).toBe("200 ok");
    const user = await userAt(w, CLAIMED);
    const id = claimLeaseId(user.id);
    const lease = () => w.storage.findOne("verification", [{ field: "id", op: "eq", value: id }]);
    expect(await lease()).toEqual({
      id,
      purpose: "claim-lease",
      identifier: user.id,
      valueHash: await sha256Hex(id),
      expiresAt: new Date(w.clock.now().getTime() + CLAIM_LEASE_MS),
      consumedAt: null,
      data: null,
      secretVersion: 1,
      createdAt: w.clock.now(),
      updatedAt: w.clock.now(),
    });
    await sweepExpired(w.config);
    expect(await lease()).not.toBeNull();
    w.clock.advance(CLAIM_LEASE_MS + 1);
    const swept = await sweepExpired(w.config);
    expect(await lease()).toBeNull();
    expect(swept.verificationExpired).toBeGreaterThanOrEqual(1);
  });
});

describe("the lease row in the answers (open point 7 of the Task 2b report of plan 12p)", () => {
  it("is in no client answer and no list, and the operator reads of verification rows skip it", async () => {
    const operator: AuthConfig["operator"] = {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(recordCredential(OPERATOR_SECRETS.support)),
          scopes: ["users", "sessions", "audit", "keys", "secrets"],
        },
      ],
      users: true,
    };
    const w = world({ extra: { operator } });
    await claimant(w);
    const ownerToken = setToken(await w.owner.handle(await ownerLink(w))) ?? "";
    const user = await userAt(w, CLAIMED);
    const lease = await w.storage.findOne("verification", [
      { field: "id", op: "eq", value: claimLeaseId(user.id) },
    ]);
    if (!lease) throw new Error("no lease");
    // The owner makes an organization and invites a person, so the lists have rows.
    const cookie = cookieOf(ownerToken);
    const made = await w.claimant.handle(
      req("POST", "/organizations/create", { slug: "ada-co", name: "Ada Co" }, cookie),
    );
    expect(await answer(made)).toBe("200 ok");
    const organizationId = ((await made.json()) as { organization: { id: string } }).organization
      .id;
    const invited = await w.claimant.handle(
      req(
        "POST",
        "/organizations/invite",
        { organizationId, email: recordAddress("bob@example.com"), role: "member" },
        cookie,
      ),
    );
    expect(await answer(invited)).toBe("200 ok");
    // The query of each route that reads one; every other route gets none.
    const queries: Record<string, string> = {
      "/operator/users/get": `userId=${user.id}`,
      "/operator/users/search": `email=${encodeURIComponent(CLAIMED)}`,
    };
    for (const path of [
      "/organizations/members",
      "/organizations/invitations",
      "/organizations/permissions",
      "/organizations/tokens",
      "/organizations/roles",
      "/organizations/teams",
    ])
      queries[path] = `organizationId=${organizationId}`;
    const marks = [lease.purpose, lease.id, lease.valueHash];
    const answered = new Set<string>();
    // Each GET route that this deployment mounts, with no path parameter.
    const reads = coreRoutes(w.config).filter((r) => r.method === "GET" && !r.path.includes(":"));
    for (const { path } of reads)
      for (const headers of [{ cookie }, operatorHeader(OPERATOR_SECRETS.support)]) {
        const query = queries[path] ? `?${queries[path]}` : "";
        const res = await w.claimant.handle(
          new Request(`${BASE_URL}/auth${path}${query}`, {
            headers: { ...headers, "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}` },
          }),
        );
        const text = await res.text();
        for (const mark of marks) expect(text, `GET ${path}`).not.toContain(mark);
        if (res.status === 200) answered.add(path);
      }
    // The lists of the person and of the operator answered, so the check read real answers.
    expect([...answered]).toEqual(
      expect.arrayContaining([
        "/session",
        "/sessions",
        "/identities",
        "/tokens",
        "/organizations",
        "/organizations/members",
        "/organizations/invitations",
        "/operator/users",
        "/operator/users/get",
        "/operator/users/search",
        "/operator/audit",
        "/operator/secrets/status",
      ]),
    );
    // The operator reads of verification rows by the user id: each skips the lease.
    expect(await hasPendingEnd(w.storage, user.id)).toBe(false);
    const session = await rowOf(w, ownerToken);
    if (!session) throw new Error("no owner session");
    expect(await revokedFor(w.config, user, session)).toBe(false);
    const pending = await readPendingEnds(w.storage, meterOf(w.storage, 0), 50, [
      "organization-rest",
    ]);
    expect(pending.map((r) => r.id)).not.toContain(lease.id);
  });
});

describe("the port flag on the memory store (plan 12p)", () => {
  it("is false on the store and on its transaction, where keep answers true", async () => {
    const storage = createMemoryAdapter();
    expect(storage.isolated).toBe(false);
    const seen = await storage.transaction(async (tx) => [tx.isolated, await tx.keep()]);
    expect(seen).toEqual([false, true]);
  });
});

/** A phone user: the sign-up by a code. Answers the session token. */
async function phoneUser(w: World): Promise<string> {
  expect((await w.claimant.handle(req("POST", "/phone/request", { phone: PHONE }))).status).toBe(
    200,
  );
  const code = /^(\d+) is your /.exec(w.sms.sent.findLast((x) => x.to === PHONE)?.text ?? "")?.[1];
  const phoned = await w.claimant.handle(req("POST", "/phone/verify", { phone: PHONE, code }));
  expect(await answer(phoned)).toBe("200 ok");
  const token = setToken(phoned);
  if (!token) throw new Error("the phone sign-up set no session cookie");
  return token;
}

/** A first password of the user of `cookie`, by the password change. */
async function firstPassword(w: World, cookie: string): Promise<void> {
  const set = await w.claimant.handle(req("POST", "/password/change", { newPassword: PW }, cookie));
  expect(await answer(set)).toBe("200 ok");
}

/**
 * A user with a username and a password and no address, phone, or passkey,
 * through the routes in the order of probe P6 of rr-task2.md. A phone
 * sign-up sets a username and a first password, then removes the phone.
 * Answers the phone session and the session of a sign-in by the username.
 */
async function usernameUser(w: World) {
  const first = await phoneUser(w);
  const named = await w.claimant.handle(
    req("POST", "/user/username", { username: "pat" }, cookieOf(first)),
  );
  expect(await answer(named)).toBe("200 ok");
  await firstPassword(w, cookieOf(first));
  const removed = await w.claimant.handle(req("POST", "/phone/remove", {}, cookieOf(first)));
  expect(await answer(removed)).toBe("200 ok");
  const signIn = await w.claimant.handle(
    req("POST", "/password/sign-in", { username: "pat", password: PW }),
  );
  expect(await answer(signIn)).toBe("200 ok");
  const second = setToken(signIn);
  if (!second) throw new Error("no session");
  return { first, second };
}

describe("the flag of a user with no address (ruling 20 of plan 12p)", () => {
  it("proves the session of a phone user's password sign-in: a token create passes", async () => {
    const w = world();
    await firstPassword(w, cookieOf(await phoneUser(w)));
    const signIn = await w.claimant.handle(
      req("POST", "/password/sign-in", { phone: PHONE, password: PW }),
    );
    expect(await answer(signIn)).toBe("200 ok");
    const token = setToken(signIn) ?? "";
    expect((await rowOf(w, token))?.proved).toBe(true);
    expect(await tokenCreate(w, token)).toBe("200 ok");
  });

  it("proves the session of a username-only user's password sign-in: the password change passes, and a token create answers email_unverified", async () => {
    const w = world();
    const { second } = await usernameUser(w);
    const user = await w.storage.findOne("user", [{ field: "username", op: "eq", value: "pat" }]);
    expect(user).toMatchObject({ email: null, phone: null, isAnonymous: false });
    expect((await rowOf(w, second))?.proved).toBe(true);
    // `provedAccount` passes: the user is not anonymous, and the session is proved.
    const changed = await w.claimant.handle(
      req(
        "POST",
        "/password/change",
        { currentPassword: PW, newPassword: recordCredential("username only password 2") },
        cookieOf(second),
      ),
    );
    expect(await answer(changed)).toBe("200 ok");
    // `handleProved` still reads the user row: no phone, no passkey, so no verified handle.
    expect(await tokenCreate(w, second)).toBe("403 email_unverified");
  });

  it("keeps an anonymous session unproved, and the session of its upgrade to an unverified address too", async () => {
    const w = world();
    const anon = await w.claimant.handle(req("POST", "/anonymous/sign-in", {}));
    expect(await answer(anon)).toBe("200 ok");
    const anonToken = setToken(anon) ?? "";
    expect((await rowOf(w, anonToken))?.proved).toBe(false);
    // The upgrade: a password sign-up from the anonymous session, of an
    // address that no proof verified.
    const up = await w.claimant.handle(
      req("POST", "/password/sign-up", { email: CLAIMED, password: PW }, cookieOf(anonToken)),
    );
    expect(await answer(up)).toBe("200 ok");
    const upToken = setToken(up) ?? "";
    const upgraded = await rowOf(w, upToken);
    expect(upgraded?.userId).toBe((await userAt(w, CLAIMED)).id);
    expect(upgraded?.proved).toBe(false);
    expect(await tokenCreate(w, upToken)).toBe("403 email_unverified");
    // The upgrade ended the anonymous session, and no session of the address is proved.
    expect(await rowOf(w, anonToken)).toBeNull();
    expect((await w.storage.findMany("session", [])).map((x) => x.proved)).toEqual([false]);
  });

  it("proves the session of a challenge after a phone user's password sign-in", async () => {
    const w = world();
    const first = await phoneUser(w);
    const cookie = cookieOf(first);
    await firstPassword(w, cookie);
    const setup = await w.claimant.handle(req("POST", "/totp/setup", { password: PW }, cookie));
    expect(await answer(setup)).toBe("200 ok");
    const secret = base32Decode(((await setup.json()) as { secret: string }).secret);
    const on = await w.claimant.handle(
      req("POST", "/totp/enable", { code: await totpCode(secret, w.clock.now()) }, cookie),
    );
    expect(await answer(on)).toBe("200 ok");
    w.clock.advance(90_000);
    const gated = await w.claimant.handle(
      req("POST", "/password/sign-in", { phone: PHONE, password: PW }),
    );
    expect(gated.status).toBe(200);
    const challenge = ((await gated.json()) as { twoFactor: { challenge: string } }).twoFactor
      .challenge;
    const done = await w.claimant.handle(
      req("POST", "/totp/verify", { challenge, code: await totpCode(secret, w.clock.now()) }),
    );
    expect(await answer(done)).toBe("200 ok");
    const token = setToken(done) ?? "";
    expect((await rowOf(w, token))?.proved).toBe(true);
    expect(await tokenCreate(w, token)).toBe("200 ok");
  });
});

describe("the flag of a session that a second factor opens (plan 12p decision 2)", () => {
  it("is true after the challenge of a phone sign-in of a user with no address", async () => {
    const w = world();
    const first = await phoneUser(w);
    const cookie = cookieOf(first);
    expect(
      await answer(
        await w.claimant.handle(req("POST", "/password/change", { newPassword: PW }, cookie)),
      ),
    ).toBe("200 ok");
    const setup = await w.claimant.handle(req("POST", "/totp/setup", { password: PW }, cookie));
    expect(await answer(setup)).toBe("200 ok");
    const secret = base32Decode(((await setup.json()) as { secret: string }).secret);
    const on = await w.claimant.handle(
      req("POST", "/totp/enable", { code: await totpCode(secret, w.clock.now()) }, cookie),
    );
    expect(await answer(on)).toBe("200 ok");
    w.clock.advance(30_000);
    // A phone sign-in now answers a challenge; its verify opens the session.
    w.clock.advance(60_000);
    expect((await w.claimant.handle(req("POST", "/phone/request", { phone: PHONE }))).status).toBe(
      200,
    );
    const smsCode = /^(\d+) is your /.exec(
      w.sms.sent.findLast((x) => x.to === PHONE)?.text ?? "",
    )?.[1];
    const gated = await w.claimant.handle(
      req("POST", "/phone/verify", { phone: PHONE, code: smsCode }),
    );
    expect(gated.status).toBe(200);
    const challenge = ((await gated.json()) as { twoFactor: { challenge: string } }).twoFactor
      .challenge;
    const done = await w.claimant.handle(
      req("POST", "/totp/verify", { challenge, code: await totpCode(secret, w.clock.now()) }),
    );
    expect(await answer(done)).toBe("200 ok");
    const token = setToken(done);
    expect(token && (await rowOf(w, token))?.proved).toBe(true);
  });
});

describe("the door of a claimed session (ruling 13 of plan 12q)", () => {
  // The claim's gap on the memory store: a verified user, and the claimant's
  // session from before the proof, still there. The engine leaves this state
  // between the flip and the session delete, as D1 does.
  it("answers null to a read-only read and ends nothing, then GET /session answers 401 and ends the session once", async () => {
    const w = world({ hook: true });
    const token = await claimant(w);
    const cookie = cookieOf(token);
    const verify = await ownerLink(w);
    const gap: Record<string, unknown> = {};
    w.armed.run = async () => {
      gap.verified = (await userAt(w, CLAIMED)).emailVerified;
      gap.proved = (await rowOf(w, token))?.proved;
      gap.readOnly = await resolveSession(w.config, token, "read-only");
      gap.keptByReadOnly = (await rowOf(w, token)) !== null;
      gap.endsByReadOnly = [...w.ended];
      gap.read = await answer(await w.claimant.handle(req("GET", "/session", undefined, cookie)));
      gap.keptByRead = (await rowOf(w, token)) !== null;
      gap.endsByRead = [...w.ended];
    };
    const owner = await w.owner.handle(verify);
    expect(await answer(owner)).toBe("200 ok");
    expect(gap).toEqual({
      verified: true,
      proved: false,
      readOnly: null,
      keptByReadOnly: true,
      endsByReadOnly: [],
      read: "401 unauthorized",
      keptByRead: false,
      endsByRead: ["claimed"],
    });
    // The claim's own delete found no session of the claimant, so the hook fired once.
    expect(w.ended).toEqual(["claimed"]);
    // The owner's session came after the proof, so it passes the door.
    const ownerToken = setToken(owner) ?? "";
    expect((await resolveSession(w.config, ownerToken))?.session.proved).toBe(true);
  });

  it("ends the session at the claim's gap in the mode of a bag read too", async () => {
    const w = world({ hook: true });
    const token = await claimant(w);
    const verify = await ownerLink(w);
    const gap: Record<string, unknown> = {};
    w.armed.run = async () => {
      gap.bag = await resolveSession(w.config, token, "no-slide");
      gap.kept = (await rowOf(w, token)) !== null;
    };
    expect(await answer(await w.owner.handle(verify))).toBe("200 ok");
    expect(gap).toEqual({ bag: null, kept: false });
    expect(w.ended).toEqual(["claimed"]);
  });

  // The confirm of a change of address proves the session that it keeps. A
  // user with no address gains a verified one there, and the session passes.
  const MOVED = recordAddress("pat@example.org");
  for (const method of ["link", "code"] as const)
    it(`keeps the session that the confirm of a change of address by ${method} proves`, async () => {
      const w = world({ hook: true });
      const token = await phoneUser(w);
      const cookie = cookieOf(token);
      const asked = await w.claimant.handle(
        req(
          "POST",
          "/user/change-email",
          method === "code" ? { newEmail: MOVED, method } : { newEmail: MOVED },
          cookie,
        ),
      );
      expect(await answer(asked)).toBe("200 ok");
      const text = w.mail.findLast((m) => m.to === MOVED)?.text ?? "";
      const confirmed =
        method === "link"
          ? await w.claimant.handle(
              formReq("/user/change-email/confirm", { token: tokenFromMail(text) }),
            )
          : await w.claimant.handle(
              req(
                "POST",
                "/user/change-email/verify",
                { code: /\b(\d{6})\b/.exec(text)?.[1] ?? "" },
                cookie,
              ),
            );
      expect(confirmed.status).toBe(method === "link" ? 302 : 200);
      const user = await userAt(w, MOVED);
      expect(user.emailVerified).toBe(true);
      expect((await rowOf(w, token))?.proved).toBe(true);
      expect(await answer(await w.claimant.handle(req("GET", "/session", undefined, cookie)))).toBe(
        "200 ok",
      );
      expect(await rowOf(w, token)).not.toBeNull();
      expect(w.ended).toEqual([]);
    });
});
