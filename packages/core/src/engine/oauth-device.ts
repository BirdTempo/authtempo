import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { hmacSha256Hex, randomToken, sha256Hex } from "../primitives/crypto.js";
import type { DpopBinding } from "../primitives/dpop.js";
import { newId } from "../primitives/ids.js";
import { currentSecret } from "../primitives/keyring.js";
import { namedResource } from "../primitives/resource.js";
import type { OAuthClientRow, OAuthDeviceRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { issuerOf } from "./jwt.js";
import { authTimeOf, consentCovers, grantConsent } from "./oauth-authorize.js";
import type { AuthedClient } from "./oauth-client-auth.js";
import { DEVICE_GRANT } from "./oauth-clients.js";
import { type OAuthResult, oauthFail, oauthOf, oauthOk } from "./oauth-result.js";
import { issueDeviceTokens, liveUser, type TokenAnswer } from "./oauth-token.js";
import type { ResolvedSession } from "./sessions.js";

/**
 * The device grant of RFC 8628 (plan 12e, read 2026-10-20). A device without
 * a browser asks for a device code and a user code. The person types the
 * user code on the device page of this server, signed in, and allows or
 * denies. The device polls the token endpoint with the device code. Both
 * codes are credentials: the table holds their hashes, and no code here
 * logs one.
 */

export { DEVICE_GRANT };
export const DEVICE_PREFIX = "od_";
const DEVICE_RE = /^od_[A-Za-z0-9_-]{43}$/;
/** RFC 8628 section 6.1: base 20, no vowel, so a code spells no word. Case does not count. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
/** RFC 8628 section 5.1: 8 characters of the base-20 set. */
export const USER_CODE_LENGTH = 8;
/** A user code as core shows it and as a URL carries it: two groups of four. */
export const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
/** RFC 8628 section 3.5: a poll that comes too early adds 5 seconds to the interval. */
const SLOW_DOWN_S = 5;
/** A clash of either hash draws both codes again, at most this often. */
const DRAWS = 3;

/*
 * The odds of a guessed user code. 20^8 is about 2^34.5. With n live codes
 * one guess passes with p = n / 20^8, about n × 3.9 × 10⁻¹¹.
 *
 * The limiter port promises no window shape (limiter/port.ts). The three
 * limiters of the repo (memory, D1, Postgres) keep a fixed window, which
 * opens at its first call. A window that opened just before a code started
 * still takes guesses in the first seconds of the code. More windows open in
 * its life: a 10-minute code meets two windows, and a 30-minute code three.
 * So one key gets at most max − 1 + max × ceil(life / 15 minutes) guesses at
 * one code (ruling 48 of plan 12e).
 *
 * - A 10-minute code (the default): 9 guesses per session, p ≈ n × 3.5 × 10⁻¹⁰.
 *   39 guesses per IP, p ≈ n × 1.5 × 10⁻⁹.
 * - A 30-minute code (the maximum): 14 guesses per session, p ≈ n × 5.5 × 10⁻¹⁰.
 *   59 guesses per IP, p ≈ n × 2.3 × 10⁻⁹.
 *
 * A custom limiter whose windows start at fixed clock times gives at most
 * max × (ceil(life / 15 minutes) + 1) guesses. That is 10 per session and 40
 * per IP for a 10-minute code, and 15 and 60 for a 30-minute code. The odds
 * stay below n × 2.4 × 10⁻⁹. A limiter of another shape holds its own bound.
 *
 * An attacker with k addresses multiplies the IP bound by k. A limiter that
 * counts per isolate, as the memory limiter on Workers does, multiplies each
 * bound by the count of isolates. Core keeps the fixed window: a sliding
 * count needs a new call of the limiter port in every adapter, and these
 * bounds stay small.
 *
 * The keyed hash guards a leaked table. 34.5 bits fall to a search of every
 * value in seconds, and the key is the app secret (spec 22 items 3 to 5).
 */

/** The device authorization requests of one IP: the route asks before the client auth, so a failed auth counts. */
export const DEVICE_START_PER_IP = { seconds: 900, max: 30 };
/** The code forms of one session: a guess of a user code costs one. */
export const DEVICE_VERIFY_PER_SESSION = { seconds: 900, max: 5 };
/** The code forms of one IP, over all its sessions. */
export const DEVICE_VERIFY_PER_IP = { seconds: 900, max: 20 };
/**
 * The forms that find one live code, by its keyed hash (ruling 44). A guess
 * finds no code, so this count does not bound a guess. It bounds how many
 * sessions see the consent of one code, as when a phishing link goes to
 * many people.
 */
export const DEVICE_VERIFY_PER_CODE = { seconds: 900, max: 10 };

/** The answer of RFC 8628 section 3.2. */
export interface DeviceAuthorizationAnswer {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** One letter of the alphabet per byte under 240: 240 is the largest multiple of 20 under 256, so each letter is uniform. */
function newUserCode(): string {
  let out = "";
  const buf = new Uint8Array(USER_CODE_LENGTH * 2);
  while (out.length < USER_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 240) continue;
      out += USER_CODE_ALPHABET[b % 20];
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out;
}

/** `XXXX-XXXX` of 8 letters. */
const shown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * The typed code as `XXXX-XXXX`, or null. The input is upper-cased, and
 * each character outside the alphabet goes, so a space, a dash, or a vowel
 * changes nothing. Then exactly 8 letters must remain.
 */
export function normalizeUserCode(input: string): string | null {
  const letters = [...input.toUpperCase()].filter((c) => USER_CODE_ALPHABET.includes(c)).join("");
  return letters.length === USER_CODE_LENGTH ? shown(letters) : null;
}

/** The keyed hash of a user code in its `XXXX-XXXX` form, under one secret value. */
const userCodeHash = (secret: string, code: string) => hmacSha256Hex(secret, code.replace("-", ""));

/** The device page URL that the answer names (RFC 8628 section 3.2). */
const verificationUri = (config: ResolvedConfig) => `${issuerOf(config)}/oauth/device`;

/**
 * The device authorization request of RFC 8628 section 3.1, for a client
 * that `authenticateClient` checked. The client must hold the device grant.
 * A pairwise client is refused: the grant has no redirect, so nothing ties a
 * sector to the client (ruling 34). `scope` and `resource` are checked as the
 * authorize step checks them. `dpop` is the key of an optional proof: the
 * poll then needs a proof of that key.
 */
export async function startDevice(
  config: ResolvedConfig,
  input: {
    client: AuthedClient;
    scope: string | null;
    resource: string | null;
    dpop: DpopBinding | null;
  },
): Promise<OAuthResult<DeviceAuthorizationAnswer>> {
  const oauth = oauthOf(config);
  const device = oauth.device;
  const { client } = input.client;
  if (!device || !client.grantTypes.includes(DEVICE_GRANT) || client.subjectType === "pairwise")
    return oauthFail("unauthorized_client");
  // oauth.defaultResource takes the place of an absent resource; else the 9g rule (ruling 52 of plan 12e).
  const resource = namedResource(input.resource) ?? oauth.defaultResource;
  if (resource === null || !oauth.resources.includes(resource)) return oauthFail("invalid_target");
  const scopes = [...new Set((input.scope ?? "").split(" ").filter((s) => s.length > 0))];
  if (scopes.length === 0 || scopes.some((s) => !oauth.scopes.has(s)))
    return oauthFail("invalid_scope");
  const now = config.clock.now();
  for (let draw = 1; ; draw++) {
    const deviceCode = randomToken(DEVICE_PREFIX);
    const userCode = shown(newUserCode());
    try {
      await config.storage.create("oauthDevice", {
        id: newId(now),
        deviceCodeHash: await sha256Hex(deviceCode),
        userCodeHash: await userCodeHash(currentSecret(config.keyring), userCode),
        secretVersion: config.keyring.current,
        clientId: client.id,
        scopes,
        resource: resource,
        status: "pending",
        userId: null,
        sessionId: null,
        interval: device.interval,
        lastPolledAt: null,
        dpopJkt: input.dpop?.jkt ?? null,
        expiresAt: new Date(now.getTime() + device.codeTtlMinutes * 60_000),
        createdAt: now,
        updatedAt: now,
      });
    } catch (e) {
      if (e instanceof StorageError && e.code === "unique_violation" && draw < DRAWS) continue;
      throw e;
    }
    const uri = verificationUri(config);
    return oauthOk({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: uri,
      verification_uri_complete: `${uri}?user_code=${userCode}`,
      expires_in: device.codeTtlMinutes * 60,
      interval: device.interval,
    });
  }
}

/**
 * The live pending row of a user code in its `XXXX-XXXX` form, or null. The
 * code is hashed under each version that the keyring holds, so a code from
 * before a new secret version still matches. The keyring holds distinct
 * values, so the hash under one value finds only a row of that value. A
 * check of `secretVersion` would decide nothing (ruling 48 of plan 12e).
 */
export async function findUserCode(
  config: ResolvedConfig,
  userCode: string,
): Promise<OAuthDeviceRow | null> {
  const now = config.clock.now().getTime();
  for (const version of config.keyring.versions) {
    const secret = config.keyring.valueOf(version);
    if (secret === null) continue;
    const row = await config.storage.findOne("oauthDevice", [
      { field: "userCodeHash", op: "eq", value: await userCodeHash(secret, userCode) },
    ]);
    if (row && row.status === "pending" && row.expiresAt.getTime() > now) return row;
  }
  return null;
}

/** The answer of the device page to one post. */
export type DeviceStep =
  | { kind: "error"; error: "rate_limited" | "invalid_request" }
  | { kind: "code"; userCode: string; error: "invalid_code" | "unverified" }
  | { kind: "consent"; userCode: string; row: OAuthDeviceRow; client: OAuthClientRow }
  | { kind: "done"; approved: boolean };

/**
 * One post of the device page (RFC 8628 section 3.3). The route checked the
 * Origin and the session. The counts run first, per IP and per session, so a
 * guess costs one form. A found code also counts on its own key. Without
 * `decision` the step shows the consent. With `allow` or `deny` it decides,
 * by one conditional update on `status`: of two parallel decisions, one wins.
 */
export async function decideDevice(
  config: ResolvedConfig,
  input: {
    userCode: string;
    decision: string | null;
    session: ResolvedSession;
    ip: string | null;
  },
): Promise<DeviceStep> {
  const { limiter } = config;
  if (!(await limiter.allow(`oauth-device-verify:ip:${ipKey(input.ip)}`, DEVICE_VERIFY_PER_IP)))
    return { kind: "error", error: "rate_limited" };
  const sessionKey = `oauth-device-verify:session:${input.session.session.id}`;
  if (!(await limiter.allow(sessionKey, DEVICE_VERIFY_PER_SESSION)))
    return { kind: "error", error: "rate_limited" };
  if (input.decision !== null && input.decision !== "allow" && input.decision !== "deny")
    return { kind: "error", error: "invalid_request" };
  const userCode = normalizeUserCode(input.userCode);
  const row = userCode === null ? null : await findUserCode(config, userCode);
  if (userCode === null || row === null)
    return { kind: "code", userCode: userCode ?? "", error: "invalid_code" };
  if (
    !(await limiter.allow(`oauth-device-verify:code:${row.userCodeHash}`, DEVICE_VERIFY_PER_CODE))
  )
    return { kind: "error", error: "rate_limited" };
  const { user } = input.session;
  // A grant would outlive a claim of the address (spec 8.7), as at the authorize step.
  if (!user.emailVerified) return { kind: "code", userCode, error: "unverified" };
  const client = await config.storage.findOne("oauthClient", [
    { field: "id", op: "eq", value: row.clientId },
  ]);
  if (!client) return { kind: "code", userCode, error: "invalid_code" };
  if (input.decision === null) return { kind: "consent", userCode, row, client };
  const approved = input.decision === "allow";
  // The consent first: a poll that sees `approved` then finds it.
  if (approved) await grantConsent(config, user.id, client.id, row.scopes);
  const now = config.clock.now();
  const n = await config.storage.update(
    "oauthDevice",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "status", op: "eq", value: "pending" },
      { field: "expiresAt", op: "gt", value: now },
    ],
    {
      status: approved ? "approved" : "denied",
      userId: user.id,
      sessionId: input.session.session.id,
      updatedAt: now,
    },
  );
  if (n !== 1) return { kind: "code", userCode, error: "invalid_code" };
  return { kind: "done", approved };
}

/**
 * The device access token request of RFC 8628 section 3.4, for a client
 * that `authenticateClient` checked. Only the client of the row may poll.
 * A row of a DPoP key needs a proof of that key. The answers follow section
 * 3.5. A poll within `interval` of the last answers `slow_down` and adds 5
 * seconds. The approved row is spent by one conditional update on `status`,
 * so of two parallel polls one gets the tokens. A later poll answers
 * `invalid_grant`.
 */
export async function pollDevice(
  config: ResolvedConfig,
  input: { deviceCode: string; client: AuthedClient; dpop: DpopBinding | null },
): Promise<OAuthResult<TokenAnswer>> {
  const { client } = input.client;
  if (!client.grantTypes.includes(DEVICE_GRANT)) return oauthFail("unauthorized_client");
  if (!DEVICE_RE.test(input.deviceCode)) return oauthFail("invalid_grant");
  const row = await config.storage.findOne("oauthDevice", [
    { field: "deviceCodeHash", op: "eq", value: await sha256Hex(input.deviceCode) },
  ]);
  if (!row || row.clientId !== client.id) return oauthFail("invalid_grant");
  if (row.dpopJkt !== null && input.dpop?.jkt !== row.dpopJkt)
    return oauthFail("invalid_dpop_proof");
  if (row.status === "spent") return oauthFail("invalid_grant");
  const now = config.clock.now();
  if (row.expiresAt.getTime() <= now.getTime()) return oauthFail("expired_token");
  if (row.status === "denied") return oauthFail("access_denied");
  const last = row.lastPolledAt;
  const early = last !== null && now.getTime() - last.getTime() < row.interval * 1000;
  const polled = await config.storage.update(
    "oauthDevice",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "lastPolledAt", op: "eq", value: last },
    ],
    {
      lastPolledAt: now,
      interval: early ? row.interval + SLOW_DOWN_S : row.interval,
      updatedAt: now,
    },
  );
  // A parallel poll moved `lastPolledAt` first: this one came too early too.
  if (early || polled !== 1) return oauthFail("slow_down");
  if (row.status === "pending" || row.userId === null) return oauthFail("authorization_pending");
  const spent = await config.storage.update(
    "oauthDevice",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "status", op: "eq", value: "approved" },
    ],
    { status: "spent", updatedAt: now },
  );
  if (spent !== 1) return oauthFail("invalid_grant");
  const user = await liveUser(config, row.userId);
  if (!user) return oauthFail("invalid_grant");
  // A grant revoke after the approval deletes the consent, and the row gives nothing.
  if (!(await consentCovers(config, user.id, client.id, row.scopes)))
    return oauthFail("invalid_grant");
  const session =
    row.sessionId === null
      ? null
      : await config.storage.findOne("session", [{ field: "id", op: "eq", value: row.sessionId }]);
  return issueDeviceTokens(config, {
    row,
    user,
    client: input.client,
    authTime: session ? authTimeOf(session) : null,
    dpop: input.dpop,
  });
}
