import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { SESSION_JWT_TYPE } from "../primitives/credentials.js";
import { randomBase64Url } from "../primitives/crypto.js";
import type { OAuthClientRow, OAuthLogoutRow, SessionRow } from "../schema.js";
import { issuerOf, mintConfig, signToken, verifyLocal } from "./jwt.js";
import { findClient } from "./oauth-clients.js";
import { endSessionById, linkSession, queueLogouts } from "./oauth-outbox.js";
import { storedSubject, userOfSubject } from "./oauth-subject.js";
import { sessionsEnded } from "./sessions.js";

/**
 * The end-session route of one IP: 60 per 15 minutes (plan 12e). Each
 * request can verify a hint and read a client. A browser asks it once per
 * sign-out, so 60 leaves room for a shared NAT.
 */
export const END_SESSION_PER_IP = { seconds: 900, max: 60 };

/** True when the IP is past `END_SESSION_PER_IP` at the end-session route. */
export const endSessionLimited = async (config: ResolvedConfig, ip: string | null) =>
  !(await config.limiter.allow(`oauth-end-session:ip:${ipKey(ip)}`, END_SESSION_PER_IP));

/**
 * What a valid `id_token_hint` names. `clientId` is its `aud`. `sid` is the
 * session of the sign-in, or null when the code had no session. `sub` is the
 * user id: a pairwise subject is mapped back to its user.
 */
export interface IdTokenHint {
  clientId: string;
  sid: string | null;
  sub: string;
}

/**
 * The claims of an ID token that this instance signed, or null. The
 * signature verifies under the signing key or a key retired less than 24
 * hours ago. The header `typ` is `JWT`, `iss` is this issuer, and `aud` is
 * one string that names a client. An `aud` of `jwtMint.audience` is
 * refused: a session JWT has the same `typ`, but it is not an ID token.
 * `exp` is not checked: RP-Initiated Logout 1.0 section 2 accepts an
 * expired hint for its `sub` and `aud`.
 */
export async function checkIdTokenHint(
  config: ResolvedConfig,
  hint: string,
): Promise<IdTokenHint | null> {
  const decoded = await verifyLocal(config, hint);
  if (!decoded || decoded.header.typ !== SESSION_JWT_TYPE) return null;
  const p = decoded.payload;
  if (p.iss !== issuerOf(config) || typeof p.sub !== "string") return null;
  if (typeof p.aud !== "string" || mintConfig(config).audience.includes(p.aud)) return null;
  if (p.sid !== undefined && typeof p.sid !== "string") return null;
  const client = await findClient(config, p.aud);
  if (!client) return null;
  const userId = await userOfSubject(config, p.sub, client);
  if (userId === null) return null;
  return { clientId: client.id, sid: p.sid ?? null, sub: userId };
}

/**
 * Ends one session by its id for a relying party (RP-Initiated Logout 1.0).
 * The delete is by id, so the row that `session.afterEnd` names is the row
 * that this call deleted. A parallel end of the same row fires once. True
 * when this call ended the session.
 */
export async function endSession(
  config: ResolvedConfig,
  input: { session: SessionRow },
): Promise<boolean> {
  const { session } = input;
  // The outbox rows of the session's client links, then the delete (Task 16).
  const n = await endSessionById(config.storage, session, config.clock.now());
  if (n !== 1) return false;
  await sessionsEnded(config, [session], "oidc_logout");
  await deliverLogouts(config, session.userId);
  return true;
}

/**
 * The URL that a logout redirects to, or null. Only a valid hint gives one,
 * and only to an exact entry of the client's `postLogoutRedirectUris`
 * (RP-Initiated Logout 1.0 section 3). `state` goes back only here.
 */
export async function logoutRedirect(
  config: ResolvedConfig,
  input: { hint: IdTokenHint | null; uri: string | null; state: string | null },
): Promise<string | null> {
  if (input.hint === null || input.uri === null) return null;
  const client = await findClient(config, input.hint.clientId);
  if (!client?.postLogoutRedirectUris.includes(input.uri)) return null;
  if (input.state === null) return input.uri;
  const url = new URL(input.uri);
  url.searchParams.append("state", input.state);
  return url.toString();
}

// OIDC Back-Channel Logout 1.0 (final, errata set 1, 15 December 2023;
// read 2026-10-20). Each flow that ends a session writes one `oauthLogout`
// row per linked client in its transaction (`endSessions`, `queueLogouts`).
// After its commit the flow calls `deliverLogouts`; the sweep retries.

/** The header `typ` of a logout token (section 2.4: explicit typing). Not `JWT`, so no ID token check takes it. */
export const LOGOUT_TOKEN_TYP = "logout+jwt";

/**
 * A new token signs at each attempt, so no token is stored. Two minutes of
 * life: Back-Channel Logout 4. A captured token cannot replay later.
 */
export const LOGOUT_TOKEN_LIFE_S = 120;

/**
 * The wait after failed attempt 1, 2, 3, and 4 or later: the last value
 * repeats. Section 2.5: send again only for an error that can pass, and
 * after a delay (`retryable`).
 */
export const LOGOUT_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const;

/**
 * The attempts of one row. A row whose next attempt would be the seventh
 * is deleted with one log line. Attempt 6 goes out about 4.6 hours after
 * the first.
 */
export const LOGOUT_MAX_ATTEMPTS = 6;

/**
 * The due rows of one sweep. One sweep stays short; the next one takes the
 * rest. The cap fits the D1 limit of Workers Paid: 1000 queries per
 * invocation, 100 bound parameters per query (D1 limits page updated 21
 * April 2026, read 2026-10-20). One sweep with more links to end and more
 * failing rows than each cap made 775 storage calls for a public client and
 * 825 for a pairwise one (a test, 2026-10-20). Each row costs about 6 calls.
 * The Free plan has 50 queries per invocation, which no useful cap fits.
 * There the step stops at the limit with one log line. A row that the limit
 * stops before its post loses no attempt, so the next sweeps go on.
 */
export const LOGOUT_SWEEP_MAX = 50;

/** The due rows of one delivery: one request per row, all in parallel. */
export const LOGOUT_REQUEST_MAX = 10;

/**
 * The due rows of one client in one sweep (final review of plan 12e, L4).
 * A client whose URI fails or hangs cannot fill the sweep with its rows.
 * With dynamic registration, a stranger's client could otherwise delay the
 * logouts of every other client.
 */
export const LOGOUT_SWEEP_PER_CLIENT = 10;

/**
 * The reads of one sweep step. Each read after the first leaves out each
 * client that an earlier read gave, so it finds the rows of other clients.
 * A read costs one storage call, so the reads add at most 4 calls to the
 * counts of `LOGOUT_SWEEP_MAX`. Its terms are the due time and at most 50
 * clients, under the 100 bound parameters of a D1 statement.
 */
export const LOGOUT_SWEEP_READS = 5;

/** One request: 2 seconds. A client that does not answer in time fails the attempt. */
const LOGOUT_FETCH_MS = 2_000;

/** One delivery of up to `LOGOUT_REQUEST_MAX` rows: every open request aborts at 5 seconds. */
const LOGOUT_DELIVERY_MS = 5_000;

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/**
 * Links the session of an ID token to its client (Task 16). The code
 * exchange and the device grant call it before they sign the ID token. A
 * session end that read the links before this write cannot see the link.
 * So the call reads the session after the write. When the session is gone,
 * the logout goes to the outbox now and is sent. In the other order, the
 * end deletes the session after this read, and the link stays with no
 * session. `endSessions` and the sweep make such a link a logout (ruling
 * 49). A second logout of one session is harmless (section 2.7).
 */
export async function linkIdToken(
  config: ResolvedConfig,
  input: { sessionId: string; clientId: string; userId: string },
): Promise<void> {
  const now = config.clock.now();
  await linkSession(config.storage, input, now);
  const session = await config.storage.findOne("session", [
    { field: "id", op: "eq", value: input.sessionId },
  ]);
  if (session) return;
  await queueLogouts(config.storage, input.userId, [input.sessionId], now);
  await deliverLogouts(config, input.userId);
}

/**
 * The logout token of one outbox row (section 2.4). `sub` is the subject
 * that the client knows. An account delete removes a pairwise subject first.
 * Then the token holds `sid` alone, which section 2.4 allows. It never holds
 * a nonce.
 */
export async function logoutToken(
  config: ResolvedConfig,
  row: OAuthLogoutRow,
  client: OAuthClientRow,
): Promise<string> {
  const iat = Math.floor(config.clock.now().getTime() / 1000);
  const sub = await storedSubject(config, row.userId, client);
  return signToken(config, LOGOUT_TOKEN_TYP, {
    iss: issuerOf(config),
    aud: client.id,
    iat,
    exp: iat + LOGOUT_TOKEN_LIFE_S,
    jti: randomBase64Url(16),
    events: { [LOGOUT_EVENT]: {} },
    ...(sub !== null ? { sub } : {}),
    sid: row.sessionId,
  });
}

/** The wait after `attempts` failed attempts. */
function backoffMs(attempts: number): number {
  return (
    LOGOUT_BACKOFF_MS[Math.min(attempts, LOGOUT_BACKOFF_MS.length) - 1] ?? LOGOUT_BACKOFF_MS[3]
  );
}

/**
 * The result of one post. `retry` is an error that can pass: a throw, a
 * timeout, 408, 429, or 5xx. Section 2.5 allows a retry only then. Any other
 * status is a refusal: 400 says the client refused the token (section 2.8),
 * and a redirect is not followed. Then the row goes.
 */
type Posted = { kind: "sent" } | { kind: "retry" } | { kind: "refused"; status: number };

/** True for an answer that can pass with time (section 2.5). */
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * Posts one logout token as a form (section 2.5). No redirect is followed.
 * The request has 2 seconds, and `deadline` can end it sooner. The wait
 * ends at the abort even when the app's fetch ignores the signal. Core
 * reads no byte of the answer: the status is the whole answer (section 2.8).
 */
async function postLogoutToken(
  fetchFn: typeof fetch | null,
  uri: string,
  token: string,
  deadline: AbortSignal,
): Promise<Posted> {
  // The config can lose its fetch after the URI was registered: wait for it.
  if (!fetchFn) return { kind: "retry" };
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  // setTimeout, not AbortSignal.timeout: a test moves it with fake timers.
  const timer = setTimeout(stop, LOGOUT_FETCH_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  // A rejection after the answer came has no reader: it must not count as unhandled.
  aborted.catch(() => {});
  deadline.addEventListener("abort", stop, { once: true });
  if (deadline.aborted) stop();
  try {
    const res = await Promise.race([
      fetchFn(uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ logout_token: token }).toString(),
        redirect: "manual",
        signal: ctrl.signal,
      }),
      aborted,
    ]);
    await res.body?.cancel().catch(() => {});
    if (res.status === 200 || res.status === 204) return { kind: "sent" };
    return retryable(res.status) ? { kind: "retry" } : { kind: "refused", status: res.status };
  } catch {
    return { kind: "retry" };
  } finally {
    clearTimeout(timer);
    deadline.removeEventListener("abort", stop);
  }
}

type Delivery = "sent" | "dropped" | "failed" | "skipped";

/**
 * One attempt of one row. First the claim: a conditional update moves
 * `nextAttemptAt` from the value that this call read. So of two deliveries
 * of one row, one posts. The claim counts no attempt (ruling 50). A throw
 * before the post, at the signing read or at a storage limit, leaves
 * `attempts` as it was: the row waits and comes again. Only a post that went
 * out and failed adds one attempt. Then 200 or 204 deletes the row.
 */
async function deliverRow(
  config: ResolvedConfig,
  row: OAuthLogoutRow,
  deadline: AbortSignal,
): Promise<Delivery> {
  const { storage } = config;
  const byId = [{ field: "id" as const, op: "eq" as const, value: row.id }];
  if (row.attempts >= LOGOUT_MAX_ATTEMPTS) {
    if ((await storage.delete("oauthLogout", byId)) !== 1) return "skipped";
    // The client id only: never the token, the user, or the session.
    console.error("authtempo: a back-channel logout is dropped after 6 attempts", row.clientId);
    return "dropped";
  }
  const client = await storage.findOne("oauthClient", [
    { field: "id", op: "eq", value: row.clientId },
  ]);
  // An update took the URI away: no client waits for this token.
  if (!client?.backchannelLogoutUri)
    return (await storage.delete("oauthLogout", byId)) === 1 ? "dropped" : "skipped";
  const now = config.clock.now();
  const attempts = row.attempts + 1;
  const claimed = await storage.update(
    "oauthLogout",
    [...byId, { field: "nextAttemptAt", op: "eq", value: row.nextAttemptAt }],
    { nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), updatedAt: now },
  );
  if (claimed !== 1) return "skipped";
  const token = await logoutToken(config, row, client);
  const posted = await postLogoutToken(
    config.oauth?.fetch ?? null,
    client.backchannelLogoutUri,
    token,
    deadline,
  );
  if (posted.kind === "retry") {
    // The post went out, or could not (no fetch), and failed: one attempt.
    await storage.update("oauthLogout", byId, { attempts, updatedAt: now });
    return "failed";
  }
  await storage.delete("oauthLogout", byId);
  if (posted.kind === "sent") return "sent";
  // The client id and the status only: never the token, the user, or the session.
  console.error(
    "authtempo: a back-channel logout is dropped: the client refused it",
    row.clientId,
    posted.status,
  );
  return "dropped";
}

/** Delivers `rows` in parallel inside `LOGOUT_DELIVERY_MS`. Answers the rows sent or dropped. */
async function deliverRows(config: ResolvedConfig, rows: OAuthLogoutRow[]): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOGOUT_DELIVERY_MS);
  try {
    const results = await Promise.allSettled(rows.map((r) => deliverRow(config, r, ctrl.signal)));
    let n = 0;
    for (const r of results) {
      if (r.status === "rejected")
        console.error(
          "authtempo: a back-channel logout attempt failed",
          r.reason instanceof Error ? r.reason.name : typeof r.reason,
        );
      else if (r.value === "sent" || r.value === "dropped") n++;
    }
    return n;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivers the due outbox rows of `userId`, at most `LOGOUT_REQUEST_MAX`.
 * Each flow that ends a session calls it after its commit, beside its
 * `sessionsEnded` call. It never throws: the session end that the person
 * asked for is already done, and the sweep delivers what is left.
 */
export async function deliverLogouts(config: ResolvedConfig, userId: string): Promise<void> {
  try {
    const due = await config.storage.findMany(
      "oauthLogout",
      [
        { field: "userId", op: "eq", value: userId },
        { field: "nextAttemptAt", op: "lte", value: config.clock.now() },
      ],
      { sort: { field: "nextAttemptAt", dir: "asc" }, limit: LOGOUT_REQUEST_MAX },
    );
    if (due.length > 0) await deliverRows(config, due);
  } catch (e) {
    console.error(
      "authtempo: the back-channel logout delivery failed",
      e instanceof Error ? e.name : typeof e,
    );
  }
}

/**
 * The sweep step: at most `LOGOUT_SWEEP_MAX` due rows, at most
 * `LOGOUT_SWEEP_PER_CLIENT` of one client, `LOGOUT_REQUEST_MAX` at a time.
 * Answers the rows sent or dropped.
 */
export async function deliverDueLogouts(config: ResolvedConfig): Promise<number> {
  const now = config.clock.now();
  const due: OAuthLogoutRow[] = [];
  const seen = new Set<string>();
  for (let read = 0; read < LOGOUT_SWEEP_READS && due.length < LOGOUT_SWEEP_MAX; read++) {
    const rows = await config.storage.findMany(
      "oauthLogout",
      [
        { field: "nextAttemptAt", op: "lte", value: now },
        ...[...seen].map((id) => ({ field: "clientId" as const, op: "ne" as const, value: id })),
      ],
      { sort: { field: "nextAttemptAt", dir: "asc" }, limit: LOGOUT_SWEEP_MAX },
    );
    const taken = new Map<string, number>();
    for (const row of rows) {
      const count = taken.get(row.clientId) ?? 0;
      if (count >= LOGOUT_SWEEP_PER_CLIENT || due.length >= LOGOUT_SWEEP_MAX) continue;
      taken.set(row.clientId, count + 1);
      due.push(row);
    }
    for (const row of rows) seen.add(row.clientId);
    // A short read found every due row of the clients that it did not leave out.
    if (rows.length < LOGOUT_SWEEP_MAX) break;
  }
  let n = 0;
  for (let i = 0; i < due.length; i += LOGOUT_REQUEST_MAX)
    n += await deliverRows(config, due.slice(i, i + LOGOUT_REQUEST_MAX));
  return n;
}
