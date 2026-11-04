import { describe, expect, it, vi } from "vitest";
import { type AuthConfig, type MailMessage, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  handleProved,
  type ProofCaller,
  provedAccount,
  provedAddress,
  sessionProved,
} from "../src/engine/address.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { verified } from "../src/engine/organizations.js";
import { requestPhone, verifyPhone } from "../src/engine/phone.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import type { SessionRow, UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, BASE_URL, recordAddress, recordCredential, tokenFromMail } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
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
   * The claimant's requests to run inside the owner's flow: at the flip, or
   * right after the claim's delete of the handoff codes.
   */
  const armed: { run: (() => Promise<void>) | null; at: "flip" | "handoff-delete" } = {
    run: null,
    at: "flip",
  };
  /** Each write of the owner's flows as `op:model`, in order, while a test sets it. */
  const log: { writes: string[] | null } = { writes: null };
  const wrote = (op: string, model: string) => log.writes?.push(`${op}:${model}`);
  const wrap = (a: StorageAdapter): StorageAdapter => ({
    createMany: (m, r) => a.createMany(m, r),
    rowsPerInsert: (m) => a.rowsPerInsert(m),
    create: (m, d) => {
      wrote("create", m);
      return a.create(m, d);
    },
    findOne: (m, w) => a.findOne(m, w),
    findMany: (m, w, o) => a.findMany(m, w, o),
    update: async (m, w, d) => {
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
      wrote("delete", m);
      const n = await a.delete(m, w);
      const run = armed.run;
      const codes =
        m === "verification" && w.some((x) => x.field === "purpose" && x.value === "handoff-code");
      if (run && armed.at === "handoff-delete" && codes) {
        armed.run = null;
        await run();
      }
      return n;
    },
    deleteRows: (m, w) => {
      wrote("deleteRows", m);
      return a.deleteRows(m, w);
    },
    keep: () => a.keep(),
    transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
  });
  /** A wait before the next session insert of the claimant's store, while a test sets it. */
  const gate: { session: (() => Promise<void>) | null } = { session: null };
  const open: StorageAdapter = {
    createMany: (m, r) => inner.createMany(m, r),
    rowsPerInsert: (m) => inner.rowsPerInsert(m),
    create: async (m, d) => {
      const wait = gate.session;
      if (m === "session" && wait) {
        gate.session = null;
        await wait();
      }
      return inner.create(m, d);
    },
    findOne: (m, w) => inner.findOne(m, w),
    findMany: (m, w, o) => inner.findMany(m, w, o),
    update: (m, w, d) => inner.update(m, w, d),
    delete: (m, w) => inner.delete(m, w),
    deleteRows: (m, w) => inner.deleteRows(m, w),
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
  const v = await w.claimant.handle(
    req("POST", "/password/verify", { token: tokenFromMail(mail?.text ?? "") }),
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
 * claimant's session, and the answer that the rule gives at the flip. The
 * nine open flows come first (inventory-window.md section 1).
 */
function gateRequests(cookie: string, ctx: { clientId: string; userCode: string }) {
  return [
    [
      "the API token create",
      req("POST", "/tokens", { name: "ci" }, cookie),
      "403 email_unverified",
    ],
    [
      "the change of address",
      req("POST", "/user/change-email", { newEmail: "mallory@example.net" }, cookie),
      "403 email_unverified",
    ],
    [
      "the passkey registration options",
      req("POST", "/passkey/register/options", {}, cookie),
      "403 email_unverified",
    ],
    [
      "the passkey registration verify",
      req(
        "POST",
        "/passkey/register/verify",
        { response: { id: "x", response: { clientDataJSON: "e30" } } },
        cookie,
      ),
      "403 email_unverified",
    ],
    [
      "the TOTP setup",
      req("POST", "/totp/setup", { password: PW }, cookie),
      "403 email_unverified",
    ],
    [
      "the TOTP enable",
      req("POST", "/totp/enable", { code: "123456" }, cookie),
      "403 email_unverified",
    ],
    [
      "the email method enable",
      req("POST", "/second-factor/email/enable", { password: PW }, cookie),
      "403 email_unverified",
    ],
    [
      "the passkey method enable",
      req("POST", "/second-factor/passkey/enable", { password: PW, response: { id: "x" } }, cookie),
      "403 email_unverified",
    ],
    [
      "the organization token create",
      req(
        "POST",
        "/organizations/tokens",
        { organizationId: "01JZZZZZZZZZZZZZZZZZZZZZZZ", name: "ci", permissions: {} },
        cookie,
      ),
      "403 email_unverified",
    ],
    [
      "the username set",
      req("POST", "/user/username", { username: "mallory" }, cookie),
      "403 email_unverified",
    ],
    ["the phone add", req("POST", "/phone/add", { phone: PHONE }, cookie), "403 email_unverified"],
    [
      "the phone add verify",
      req("POST", "/phone/add/verify", { code: "123456" }, cookie),
      "403 email_unverified",
    ],
    ["the token list", req("GET", "/tokens", undefined, cookie), "403 email_unverified"],
    [
      "the profile update",
      req("POST", "/user/update", { name: "Mallory" }, cookie),
      "403 email_unverified",
    ],
    [
      "the password change",
      req(
        "POST",
        "/password/change",
        { currentPassword: PW, newPassword: "another long one" },
        cookie,
      ),
      "403 email_unverified",
    ],
    [
      "the organization create",
      req("POST", "/organizations/create", { slug: "mallory", name: "Mallory" }, cookie),
      "403 email_unverified",
    ],
    [
      "the slug check",
      req("POST", "/organizations/check-slug", { slug: "mallory" }, cookie),
      "403 email_unverified",
    ],
    [
      "the OAuth device approval",
      formReq("/oauth/device", { user_code: ctx.userCode, decision: "allow" }, cookie),
      "200 page",
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
    .filter((p) => p !== "magic-link");
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
    it(`refuses every verified-only action, leaves no row of it, and the claim ends the session (afterEnd hook ${hook})`, async () => {
      const w = world({ hook });
      const token = await claimant(w);
      const cookie = cookieOf(token);
      const clientId = await client(w);
      const userCode = await deviceCode(w, clientId);
      const verify = await ownerLink(w);
      const seen: Record<string, string> = {};
      let window: { verified: boolean; proved: boolean } | null = null;
      let authorize: { status: number; error: string | null } | null = null;
      w.armed.run = async () => {
        // The window: the user reads as verified, and the claimant's session is still live.
        const live = await resolveSession(w.config, token);
        window = live ? { verified: live.user.emailVerified, proved: live.session.proved } : null;
        for (const [name, request, _want] of gateRequests(cookie, { clientId, userCode }))
          seen[name] = await answer(await w.claimant.handle(request));
        const res = await w.claimant.handle(await authorizeGet(clientId, cookie));
        const location = new URL(res.headers.get("location") ?? `${REDIRECT}?none=1`);
        authorize = { status: res.status, error: location.searchParams.get("error") };
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
      expect(authorize).toEqual({ status: 302, error: "access_denied" });
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
      expect(w.ended).toEqual(hook ? ["claim"] : []);
      // The owner's own session passes the same gate.
      const made = await w.claimant.handle(
        req("POST", "/tokens", { name: "owner" }, cookieOf(ownerToken ?? "")),
      );
      expect(await answer(made)).toBe("200 ok");
    });

  it("mints a session JWT that says email_verified false at the flip", async () => {
    const w = world();
    const token = await claimant(w);
    const verify = await ownerLink(w);
    let claim: unknown = "not minted";
    w.armed.run = async () => {
      const res = await w.claimant.handle(req("GET", "/token", undefined, cookieOf(token)));
      expect(res.status).toBe(200);
      const jwt = ((await res.json()) as { token: string }).token;
      claim = decodeJws(jwt)?.payload.email_verified;
    };
    expect(await answer(await w.owner.handle(verify))).toBe("200 ok");
    expect(claim).toBe(false);
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
      atFlip = await resolveSession(w.config, token);
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

describe("the claim's order (plan 12p decision 5)", () => {
  for (const hook of [false, true])
    it(`deletes every row a sign-in trusts after the flip and before the sessions (afterEnd hook ${hook})`, async () => {
      const w = world({ hook });
      await claimant(w);
      const verify = await ownerLink(w);
      w.log.writes = [];
      expect(await answer(await w.owner.handle(verify))).toBe("200 ok");
      const writes = w.log.writes;
      w.log.writes = null;
      const flip = writes.indexOf("flip:user");
      expect(flip).toBeGreaterThanOrEqual(0);
      // The sessions last: a chunk delete of the read ids with the hook, then the delete by user id.
      const sessions = hook ? ["deleteRows:session", "delete:session"] : ["delete:session"];
      expect(writes.slice(flip, flip + 6 + sessions.length)).toEqual([
        "flip:user",
        "delete:identity",
        "delete:password",
        "delete:passkey",
        "delete:verification",
        "delete:verification",
        ...sessions,
      ]);
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

describe("the password sign-in guard on the verified path (plan 12p decision 6)", () => {
  it("undoes the session of a claimant sign-in that read the user after the flip and inserts after the claim", async () => {
    const w = world();
    const token = await claimant(w);
    const verify = await ownerLink(w);
    const atInsert = latch();
    const release = latch();
    let signIn: Promise<Response> | null = null;
    w.armed.run = async () => {
      // The claimant's sign-in reads the user verified, checks the password,
      // and stops before its session insert, while the claim goes on.
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
    const sessions = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(sessions.map((x) => x.id)).toEqual([(await rowOf(w, setToken(owner) ?? ""))?.id]);
    expect(await rowOf(w, token)).toBeNull();
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

describe("the confirm of a change of address (plan 12p decision 7)", () => {
  it("sets proved on the session that the confirm keeps, for a user who had no address", async () => {
    const w = world();
    const first = await phoneUser(w);
    // A first password, then a sign-in by the phone and the password: no handle proved, so not proved.
    const set = await w.claimant.handle(
      req("POST", "/password/change", { newPassword: PW }, cookieOf(first)),
    );
    expect(await answer(set)).toBe("200 ok");
    const signIn = await w.claimant.handle(
      req("POST", "/password/sign-in", { phone: PHONE, password: PW }),
    );
    expect(await answer(signIn)).toBe("200 ok");
    const second = setToken(signIn);
    if (!second) throw new Error("no session");
    expect((await rowOf(w, second))?.proved).toBe(false);
    const refused = await w.claimant.handle(
      req("POST", "/tokens", { name: "ci" }, cookieOf(second)),
    );
    expect(await answer(refused)).toBe("403 email_unverified");
    // The proved session asks for the address; the second session confirms the code and stays.
    const asked = await w.claimant.handle(
      req(
        "POST",
        "/user/change-email",
        { newEmail: "pat@example.com", method: "code" },
        cookieOf(first),
      ),
    );
    expect(await answer(asked)).toBe("200 ok");
    const code = /\b(\d{6})\b/.exec(
      w.mail.findLast((m) => m.to === "pat@example.com")?.text ?? "",
    )?.[1];
    const confirmed = await w.claimant.handle(
      req(
        "POST",
        "/user/change-email/verify",
        { code: recordCredential(code ?? "") },
        cookieOf(second),
      ),
    );
    expect(await answer(confirmed)).toBe("200 ok");
    expect(await rowOf(w, first)).toBeNull();
    expect((await rowOf(w, second))?.proved).toBe(true);
    const made = await w.claimant.handle(req("POST", "/tokens", { name: "ci" }, cookieOf(second)));
    expect(await answer(made)).toBe("200 ok");
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
