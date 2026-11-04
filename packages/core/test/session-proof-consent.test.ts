import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import type { SessionRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { APP_ORIGIN, BASE_URL, recordCredential } from "./helpers.js";
import { requestIdOf } from "./oauth-helpers.js";

// The gate of the consent decision (plan 12p, ruling 28). `decideAuthorize`
// reads `provedAccount` of the caller's session, not of the user row alone.
// A claimant never reaches this gate: the GET binds a held request only
// after its own gate. One state reaches it. A user with no address holds a
// proved session and an unproved one from before version 16.
//
// The fill of decision 1 leaves that state. Migration 0016 marks a session
// proved only when its user has a verified address. So the session of a
// phone user from version 15 reads false, and that user signs in again for
// verified powers. A Worker of version 15 that writes a session during the
// deploy leaves the same row. The test writes that row through the storage,
// as the D1 test of decision 7 does with the SQL of version 15.

const PHONE = "+14155550100";
const REDIRECT = "https://client.example.com/callback";
const RESOURCE = `${BASE_URL}/mcp`;
const COOKIE = "__Host-tempo_session";
const DAY = 86_400_000;
/** The token of the session of version 15: the form of a session token. */
const OLD = recordCredential(`ts_${"o".repeat(43)}`);

function world() {
  let current = new Date("2026-11-04T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const storage = createMemoryAdapter();
  const sms = createRecordingSms();
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    limiter: createMemoryLimiter(clock),
    clock,
    mail: { send: async () => {} },
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    oauth: {
      resources: [RESOURCE],
      scopes: { "mcp:read": "Read your documents" },
      registration: { cimd: false, dynamic: true },
    },
  };
  const auth = createAuth(input);
  /** `handle` that waits for the work after the answer too, such as the text of a code. */
  const handle = async (request: Request): Promise<Response> => {
    const after: Promise<unknown>[] = [];
    const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
    await Promise.all(after);
    return res;
  };
  return { auth: { handle }, storage, sms, clock };
}
type World = ReturnType<typeof world>;

let ip = 0;
const nextIp = () => `198.51.100.${(++ip % 250) + 1}`;
const cookieOf = (token: string) => `${COOKIE}=${token}`;

/** A JSON request of the routes, with the Origin of the app. */
function req(path: string, body: unknown, cookie?: string) {
  return new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": nextIp(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** A phone sign-up by a code, through the routes. Answers the user id and the session token. */
async function phoneUser(w: World): Promise<{ userId: string; token: string }> {
  expect((await w.auth.handle(req("/phone/request", { phone: PHONE }))).status).toBe(200);
  const code = /^(\d+) is your /.exec(w.sms.sent.findLast((x) => x.to === PHONE)?.text ?? "")?.[1];
  const res = await w.auth.handle(req("/phone/verify", { phone: PHONE, code }));
  expect(res.status).toBe(200);
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? "";
  const token = recordCredential(line.slice(COOKIE.length + 1).split(";")[0] ?? "");
  const user = await w.storage.findOne("user", [{ field: "phone", op: "eq", value: PHONE }]);
  if (!user || token === "") throw new Error("the phone sign-up opened no session");
  expect(user.email).toBeNull();
  expect(user.isAnonymous).toBe(false);
  return { userId: user.id, token };
}

/** The session row of version 15 after the fill of 0016: `proved` false. */
async function sessionOfVersion15(w: World, userId: string): Promise<SessionRow> {
  const now = w.clock.now();
  return w.storage.create("session", {
    id: newId(now),
    userId,
    tokenHash: await sha256Hex(OLD),
    expiresAt: new Date(now.getTime() + DAY),
    lastSeenAt: now,
    ip: null,
    userAgent: null,
    activeOrganizationId: null,
    freshAt: now,
    actorId: null,
    activeTeamId: null,
    proved: false,
    createdAt: now,
    updatedAt: now,
  });
}

/** A public client of the register route. */
async function client(w: World): Promise<string> {
  const res = await w.auth.handle(
    new Request(`${BASE_URL}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The authorize GET of `clientId` with a PKCE challenge, for the session of `cookie`. */
function authorizeGet(clientId: string, cookie: string): Request {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "mcp:read",
    resource: RESOURCE,
    state: "st-1",
  });
  return new Request(`${BASE_URL}/auth/oauth/authorize?${query}`, {
    headers: { cookie, "cf-connecting-ip": nextIp() },
  });
}

/** The consent form as the page posts it: same origin, form encoded. */
function consentPost(requestId: string, cookie: string): Request {
  return new Request(`${BASE_URL}/auth/oauth/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      "cf-connecting-ip": nextIp(),
      cookie,
    },
    body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
  });
}

/** The grant rows of the user: its consents and its codes. */
async function grants(w: World, userId: string) {
  const consents = await w.storage.findMany("oauthConsent", [
    { field: "userId", op: "eq", value: userId },
  ]);
  const codes = await w.storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "oauth-code" },
    { field: "identifier", op: "eq", value: userId },
  ]);
  return { consents: consents.length, codes: codes.length };
}

/** The proved session's GET: the consent page, and the held request that it binds to the user. */
async function boundRequest(w: World, clientId: string, cookie: string, userId: string) {
  const page = await w.auth.handle(authorizeGet(clientId, cookie));
  expect(page.status).toBe(200);
  const requestId = requestIdOf(await page.text());
  const held = await w.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(requestId) },
    { field: "purpose", op: "eq", value: "oauth-request" },
  ]);
  expect(held?.data?.userId).toBe(userId);
  expect(held?.consumedAt).toBeNull();
  return requestId;
}

describe("the consent decision of an unproved session of a user with no address (plan 12p, ruling 28)", () => {
  it("refuses the POST of the session of version 15 on a request that a proved session bound", async () => {
    const w = world();
    const { userId, token } = await phoneUser(w);
    const old = await sessionOfVersion15(w, userId);
    const clientId = await client(w);
    const requestId = await boundRequest(w, clientId, cookieOf(token), userId);
    // The old session is live, and it decides the request of the same user.
    const done = await w.auth.handle(consentPost(requestId, cookieOf(OLD)));
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("code")).toBeNull();
    // No grant: no consent row and no code. The decision spent the held request.
    expect(await grants(w, userId)).toEqual({ consents: 0, codes: 0 });
    const spent = await w.storage.findOne("verification", [
      { field: "valueHash", op: "eq", value: await sha256Hex(requestId) },
    ]);
    expect(spent?.consumedAt).not.toBeNull();
    // The old session stays live and unproved.
    const row = await w.storage.findOne("session", [{ field: "id", op: "eq", value: old.id }]);
    expect(row?.proved).toBe(false);
  });

  it("grants the POST of the proved session on the same kind of request (the control)", async () => {
    const w = world();
    const { userId, token } = await phoneUser(w);
    await sessionOfVersion15(w, userId);
    const clientId = await client(w);
    const requestId = await boundRequest(w, clientId, cookieOf(token), userId);
    const done = await w.auth.handle(consentPost(requestId, cookieOf(token)));
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBeNull();
    expect(back.searchParams.get("code")).not.toBeNull();
    expect(await grants(w, userId)).toEqual({ consents: 1, codes: 1 });
  });
});
