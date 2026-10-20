import type { ResolvedConfig, ResolvedJwtMint } from "../config.js";
import { appErrorName } from "../primitives/app-error.js";
import { SESSION_JWT_TYPE } from "../primitives/credentials.js";
import { newId } from "../primitives/ids.js";
import {
  type DecodedJws,
  decodeJws,
  generateSigningKey,
  importPrivateKey,
  JWKS_RETIRED_MAX,
  JWS_ALGS,
  type JwsAlg,
  openPrivateKeyBytes,
  type PublicJwk,
  RETIRED_KEY_MS,
  sealPrivateKey,
  signJws,
  verifyJws,
} from "../primitives/jwk.js";
import { currentSecret, secretFor } from "../primitives/keyring.js";
import { fail, ok, type Result } from "../result.js";
import type { JwkRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { bannedFor } from "./operator/ban-rule.js";
import { sessionIsLive } from "./sessions.js";

/**
 * JWT minting (plan 9g, spec 8.12). Core owns the keys: it writes the first
 * one at the first use, seals the private half under the app secret, opens
 * it for one signature at a time, and rotates on demand. A session JWT is a
 * signed statement about a session user for a server that cannot call
 * `auth.session`. It is short-lived and not revocable; the session stays
 * the credential of record.
 */

export const SIGNING_SLOT = "signing";
const KID_MAX = 64;
/** A session id is a ULID of 26 characters; a longer value names no row and costs no read. */
const SID_MAX = 64;
/** One day in milliseconds: `jwtMint.rotateEvery` counts days (plan 11c). */
const DAY_MS = 86_400_000;
/**
 * The options of `signingKey` on the signing path (plan 11c). One frozen
 * object, so a signature allocates nothing for it when the timer is off.
 */
const ROTATE_DUE: { readonly rotateDue: true } = Object.freeze({ rotateDue: true });

/** The claims a session JWT carries from core. `jwtMint.claims` adds names, never these. */
export const RESERVED_CLAIMS: ReadonlySet<string> = new Set([
  "iss",
  "sub",
  "aud",
  "iat",
  "exp",
  "nbf",
  "jti",
  "sid",
  "email",
  "email_verified",
  "name",
  "org",
]);

export interface SessionJwtClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  iat: number;
  exp: number;
  sid: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  org: string | null;
  [claim: string]: unknown;
}

export interface MintedJwt {
  token: string;
  expiresAt: Date;
}

/** `baseURL + basePath`: the `iss` of every token core signs, and the OAuth issuer. */
export function issuerOf(config: ResolvedConfig): string {
  return `${config.baseURL}${config.basePath}`;
}

/** The minting config. A route or an API call that reaches here exists only while it is on. */
export function mintConfig(config: ResolvedConfig): ResolvedJwtMint {
  if (!config.jwtMint) throw new Error("authtempo: jwtMint is off");
  return config.jwtMint;
}

function algOf(row: JwkRow): JwsAlg | null {
  const alg = row.publicJwk.alg;
  return JWS_ALGS.find((a) => a === alg) ?? null;
}

const asPublic = (row: JwkRow) => row.publicJwk as unknown as PublicJwk;

/** Moves a signing key out of the slot. Zero rows: another call retired it first, which is the same end. */
async function retireKey(config: ResolvedConfig, row: JwkRow): Promise<void> {
  const now = config.clock.now();
  await config.storage.update(
    "jwk",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "slot", op: "eq", value: SIGNING_SLOT },
    ],
    { slot: null, retiredAt: now, updatedAt: now },
  );
}

/**
 * True when the timer of `jwtMint.rotateEvery` says that `row` must retire
 * (plan 11c): the key is at least that many days old. False when the config
 * sets no timer.
 */
function rotationDue(config: ResolvedConfig, row: JwkRow): boolean {
  const days = config.jwtMint?.rotateEvery ?? null;
  return days !== null && row.createdAt.getTime() + days * DAY_MS <= config.clock.now().getTime();
}

/**
 * The signing key of `alg`. The first call writes one. Two isolates that
 * race write two, and the unique key on `slot` keeps one: the loser reads
 * the winner's row on the next turn. A signing key of another alg retires,
 * and a new one takes the slot. Not in a transaction: the unique error is
 * caught here (plan 3 rule). With `rotateDue` (the signing path only), a key
 * that the timer of `jwtMint.rotateEvery` names retires first (plan 11c).
 */
export async function signingKey(
  config: ResolvedConfig,
  alg: JwsAlg,
  options: { rotateDue?: boolean } = {},
): Promise<JwkRow> {
  const { storage } = config;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await storage.findOne("jwk", [{ field: "slot", op: "eq", value: SIGNING_SLOT }]);
    if (row && algOf(row) === alg) {
      // The lazy timer (plan 11c). The retire is the claim: it matches the
      // row by id and slot, so of two callers that read the same old key one
      // moves it and the other moves none. Both then race to create, the
      // unique key on slot keeps one new key, and the loser reads the
      // winner's key on the next turn.
      if (options.rotateDue !== true || !rotationDue(config, row)) return row;
      await retireKey(config, row);
      continue;
    }
    if (row) {
      await retireKey(config, row);
      continue;
    }
    const now = config.clock.now();
    const kid = newId(now);
    const generated = await generateSigningKey(alg, kid);
    try {
      return await storage.create("jwk", {
        id: kid,
        publicJwk: { ...generated.publicJwk },
        privateKey: await sealPrivateKey(currentSecret(config.keyring), kid, generated.pkcs8),
        slot: SIGNING_SLOT,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
        secretVersion: config.keyring.current,
      });
    } catch (e) {
      // Another isolate wrote the signing key first: read it on the next turn.
      if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
    }
  }
  throw new Error("authtempo: no signing key after three tries");
}

/**
 * Seals a key again under the current version (plan 12b), at its first
 * signature after a switch or from `api.secrets.rewrap`. One conditional
 * update on the old sealed value: zero rows means another isolate resealed
 * it first. True when this call wrote the row. It never throws, so the
 * signature never waits on a failed write.
 */
async function resealKey(
  config: ResolvedConfig,
  row: JwkRow,
  pkcs8: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const { keyring } = config;
  if (row.secretVersion === keyring.current) return false;
  try {
    const n = await config.storage.update(
      "jwk",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "privateKey", op: "eq", value: row.privateKey },
      ],
      {
        privateKey: await sealPrivateKey(currentSecret(keyring), row.id, pkcs8),
        secretVersion: keyring.current,
      },
    );
    return n === 1;
  } catch (e) {
    console.error("authtempo: a signing key reseal failed", row.id, appErrorName(e));
    return false;
  }
}

/** `api.secrets.rewrap` for one key row, signing or retired (plan 12b): true when it moved to the current version. */
export async function rewrapKeyRow(config: ResolvedConfig, row: JwkRow): Promise<boolean> {
  const secret = secretFor(config.keyring, row.secretVersion, row.id);
  const pkcs8 = secret === null ? null : await openPrivateKeyBytes(secret, row.id, row.privateKey);
  return pkcs8 ? resealKey(config, row, pkcs8) : false;
}

/**
 * A compact JWS of `payload` with the signing key. The private key is
 * opened for this signature only. A key that does not open was sealed under
 * another app secret: it retires with one log line, and a new key signs.
 */
export async function signToken(
  config: ResolvedConfig,
  typ: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { alg } = mintConfig(config);
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await signingKey(config, alg, ROTATE_DUE);
    // The version the row names, never a second try (plan 12b).
    const secret = secretFor(config.keyring, row.secretVersion, row.id);
    const pkcs8 =
      secret === null ? null : await openPrivateKeyBytes(secret, row.id, row.privateKey);
    const key = pkcs8 ? await importPrivateKey(pkcs8, alg) : null;
    if (key && pkcs8) {
      await resealKey(config, row, pkcs8);
      return signJws({ alg, kid: row.id, typ, key, payload });
    }
    console.error("authtempo: a signing key does not open under this secret; it retires", row.id);
    await retireKey(config, row);
  }
  throw new Error("authtempo: no signing key opens under this secret");
}

// Moved to primitives/jwk.ts (plan 11d); still exported here.
export { JWKS_RETIRED_MAX };

/**
 * The JWKS document: the signing key first, then at most 100 keys retired
 * less than 24 hours ago, the last retired first. By `retiredAt`, not
 * `createdAt`: under two live versions a long-lived key retires last and
 * its tokens are the newest, so it must stay in the set (round 2 re-review).
 */
export async function publicKeySet(config: ResolvedConfig): Promise<{ keys: PublicJwk[] }> {
  const current = await signingKey(config, mintConfig(config).alg);
  const since = new Date(config.clock.now().getTime() - RETIRED_KEY_MS);
  const retired = await config.storage.findMany(
    "jwk",
    [{ field: "retiredAt", op: "gt", value: since }],
    {
      sort: [
        { field: "retiredAt", dir: "desc" },
        { field: "id", dir: "desc" },
      ],
      limit: JWKS_RETIRED_MAX,
    },
  );
  // A rotation between the two reads can list one key twice.
  const rows = [current, ...retired.filter((r) => r.id !== current.id)];
  return { keys: rows.map(asPublic) };
}

/**
 * The decoded token when its signature verifies under a key of this
 * instance that may verify now: the signing key, or a key retired less than
 * 24 hours ago. No claim is checked here; each caller checks its own.
 */
export async function verifyLocal(
  config: ResolvedConfig,
  token: string,
): Promise<DecodedJws | null> {
  const decoded = decodeJws(token);
  if (!decoded || decoded.header.kid.length > KID_MAX) return null;
  const row = await config.storage.findOne("jwk", [
    { field: "id", op: "eq", value: decoded.header.kid },
  ]);
  if (!row) return null;
  if (
    row.retiredAt !== null &&
    row.retiredAt.getTime() + RETIRED_KEY_MS <= config.clock.now().getTime()
  )
    return null;
  return (await verifyJws(decoded, asPublic(row))) ? decoded : null;
}

/** A new signing key; the old one retires and verifies for 24 hours. */
export async function rotateKey(config: ResolvedConfig): Promise<{ kid: string }> {
  const row = await config.storage.findOne("jwk", [
    { field: "slot", op: "eq", value: SIGNING_SLOT },
  ]);
  if (row) await retireKey(config, row);
  return { kid: (await signingKey(config, mintConfig(config).alg)).id };
}

/** The app's claims, or null after one log line: a throw, or a value that is not an object. */
async function appClaims(
  mint: ResolvedJwtMint,
  user: Parameters<NonNullable<ResolvedJwtMint["claims"]>>[0],
  session: Parameters<NonNullable<ResolvedJwtMint["claims"]>>[1],
): Promise<Record<string, unknown> | null> {
  if (!mint.claims) return {};
  try {
    const value: unknown = await mint.claims(user, session);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
    console.error("authtempo: jwtMint.claims answered a value that is not an object");
  } catch (e) {
    console.error("authtempo: jwtMint.claims threw", e instanceof Error ? e.name : typeof e);
  }
  return null;
}

/**
 * A session JWT for a live session of the user. `unauthorized` for an
 * unknown, expired, or foreign session. The caller proved the session; the
 * route reads it through `sessionFromRequest`, so a `tk_` token never mints.
 */
export async function mintSessionJwt(
  config: ResolvedConfig,
  input: { userId: string; sessionId: string },
): Promise<Result<MintedJwt>> {
  const mint = mintConfig(config);
  const now = config.clock.now();
  const session = await config.storage.findOne("session", [
    { field: "id", op: "eq", value: input.sessionId },
    { field: "userId", op: "eq", value: input.userId },
  ]);
  // The absolute cap ends a session whose expiresAt is later (plan 12b).
  // `sessionIsLive` is the rule of resolveSession, so the two cannot drift.
  if (!session || !sessionIsLive(config, session, now)) return fail("unauthorized");
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  // The ban rule of resolveSession (ruling 28): a race row of a ban mints nothing.
  if (!user || bannedFor(user, session.createdAt)) return fail("unauthorized");
  const extra = await appClaims(mint, user, session);
  if (extra === null) return fail("hook_failed");
  const own = Object.fromEntries(Object.entries(extra).filter(([k]) => !RESERVED_CLAIMS.has(k)));
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + mint.ttlMinutes * 60;
  const claims: SessionJwtClaims = {
    ...own,
    iss: issuerOf(config),
    sub: user.id,
    aud: mint.audience.length === 1 ? (mint.audience[0] ?? "") : mint.audience,
    iat,
    exp,
    sid: session.id,
    email: user.email,
    email_verified: user.emailVerified,
    name: user.name,
    org: session.activeOrganizationId,
  };
  return ok({
    token: await signToken(config, SESSION_JWT_TYPE, claims),
    expiresAt: new Date(exp * 1000),
  });
}

/** The claims of a session JWT of this instance, or null: a bad signature, another typ, issuer, or audience, or a past `exp`. */
export async function verifySessionJwt(
  config: ResolvedConfig,
  token: string,
): Promise<SessionJwtClaims | null> {
  const mint = mintConfig(config);
  const d = await verifyLocal(config, token);
  if (d?.header.typ !== SESSION_JWT_TYPE) return null;
  const p = d.payload;
  const now = Math.floor(config.clock.now().getTime() / 1000);
  if (p.iss !== issuerOf(config) || typeof p.sub !== "string" || typeof p.sid !== "string")
    return null;
  if (typeof p.exp !== "number" || p.exp <= now) return null;
  const aud: unknown[] = typeof p.aud === "string" ? [p.aud] : Array.isArray(p.aud) ? p.aud : [];
  if (!aud.some((a) => typeof a === "string" && mint.audience.includes(a))) return null;
  return p as SessionJwtClaims;
}

/**
 * True while the session of `sid` exists, is not expired, and is inside the
 * absolute cap of `session.absoluteDays` (plan 12b) (plan 9g final
 * fix wave, review M-1). A resource server that must end access at a
 * sign-out asks this with the `sid` of a verified session JWT. It reads the
 * row by id and renews nothing. It reads the user for the ban (plan 12f):
 * a session from before the end of the user's last ban is not live, as in
 * resolveSession (`bannedFor`, ruling 28).
 */
export async function sessionLive(
  config: ResolvedConfig,
  input: { sid: string },
): Promise<boolean> {
  if (typeof input.sid !== "string" || input.sid.length < 1 || input.sid.length > SID_MAX)
    return false;
  const row = await config.storage.findOne("session", [
    { field: "id", op: "eq", value: input.sid },
  ]);
  const now = config.clock.now();
  if (row === null || !sessionIsLive(config, row, now)) return false;
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: row.userId }]);
  return user !== null && !bannedFor(user, row.createdAt);
}

/**
 * The live checks of one session (plan 11d). A resource server checks once
 * per request of the person; 2 per second is a busy person. The key is the
 * session, not the IP, because every check of one resource server comes from
 * its one IP.
 */
export const LIVE_PER_SESSION = { seconds: 60, max: 120 };

/**
 * The check of `POST /token/live` (plan 11d, spec 20). The bearer must be a
 * session JWT that `verifySessionJwt` accepts; any other value answers
 * `unauthorized` and spends no count. Then one count on
 * `token-live:session:<sessionId>`, and the answer of `sessionLive`.
 */
export async function checkSessionLive(
  config: ResolvedConfig,
  bearer: string | null,
): Promise<Result<{ live: boolean }>> {
  if (bearer === null) return fail("unauthorized");
  const claims = await verifySessionJwt(config, bearer);
  if (!claims) return fail("unauthorized");
  if (!(await config.limiter.allow(`token-live:session:${claims.sid}`, LIVE_PER_SESSION)))
    return fail("rate_limited");
  return ok({ live: await sessionLive(config, { sid: claims.sid }) });
}
