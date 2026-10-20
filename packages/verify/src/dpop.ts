import {
  checkDpopProof,
  DPOP_WINDOW_SECONDS,
  FOREIGN_ALGS,
  type ForeignAlg,
} from "@authtempo/core/credentials";

/**
 * DPoP at a resource server (plan 12e, RFC 9449 read 2026-10-20). This is
 * the request path of core's `auth.caller`, offline: the proof check is
 * core's `checkDpopProof`, and the replay store is a seam. A proof is a
 * credential: no code here logs one.
 */

/** A store of the proof keys that a verifier saw. */
export interface ReplayStore {
  /**
   * True when `key` was seen before and its life has not ended. Else the
   * store keeps `key` for `ttlSeconds` and answers false. A shared store
   * must do both in one atomic step.
   */
  seen(key: string, ttlSeconds: number): Promise<boolean>;
}

/** The keys that the default store keeps at most. */
export const REPLAY_STORE_DEFAULT_MAX = 10_000;

/**
 * The default store: one isolate's memory. It is an insertion-ordered map
 * that drops its oldest key above `max`, so its memory has a bound. A
 * dropped key can replay, and another isolate never sees a key. A
 * deployment with several isolates passes a shared store, or uses
 * `auth.caller` of core, whose store is the database.
 */
export function memoryReplayStore(
  max = REPLAY_STORE_DEFAULT_MAX,
  clock: { now(): Date } = { now: () => new Date() },
): ReplayStore {
  if (!Number.isSafeInteger(max) || max < 1)
    throw new Error("authtempo verify: the replay store max must be a positive integer");
  const until = new Map<string, number>();
  return {
    async seen(key, ttlSeconds) {
      const now = clock.now().getTime();
      const end = until.get(key);
      if (end !== undefined && end > now) return true;
      // Delete first, so a key that comes back goes to the end of the order.
      until.delete(key);
      until.set(key, now + ttlSeconds * 1000);
      while (until.size > max) {
        const oldest = until.keys().next().value;
        if (oldest === undefined) break;
        until.delete(oldest);
      }
      return false;
    },
  };
}

export interface DpopOptions {
  /** The algs of a proof: distinct values of `FOREIGN_ALGS`. Default all five, as core. */
  algs?: readonly ForeignAlg[] | undefined;
  /** How far the `iat` of a proof may be from now, 10 to 300 s. Default 60, as core. */
  windowSeconds?: number | undefined;
  /** The store of the proofs seen. Default `memoryReplayStore()`. */
  replay?: ReplayStore | undefined;
  /** True: an access token must come with `Authorization: DPoP` (RFC 9728 section 2). Default false. */
  required?: boolean | undefined;
}

export interface ResolvedDpop {
  algs: readonly ForeignAlg[];
  windowSeconds: number;
  replay: ReplayStore;
  required: boolean;
}

/**
 * The rule of core's `oauth.dpop`: the same algs and the same window, read
 * from core's one copy of each (`FOREIGN_ALGS`, `DPOP_WINDOW_SECONDS`).
 */
export function resolveDpop(input: DpopOptions, clock: { now(): Date }): ResolvedDpop {
  const algs = input.algs ?? FOREIGN_ALGS;
  if (
    algs.length < 1 ||
    new Set(algs).size !== algs.length ||
    !algs.every((a) => FOREIGN_ALGS.includes(a))
  )
    throw new Error(
      "authtempo verify: dpop.algs must be a list of distinct values of EdDSA, Ed25519, ES256, RS256, and PS256",
    );
  const { min, max } = DPOP_WINDOW_SECONDS;
  const windowSeconds = input.windowSeconds ?? DPOP_WINDOW_SECONDS.default;
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < min || windowSeconds > max)
    throw new Error(
      `authtempo verify: dpop.windowSeconds must be an integer from ${min} to ${max}`,
    );
  return {
    algs: [...algs],
    windowSeconds,
    replay: input.replay ?? memoryReplayStore(REPLAY_STORE_DEFAULT_MAX, clock),
    required: input.required ?? false,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True when `request` holds one valid proof of key `jkt` for `token`
 * (RFC 9449 section 7.1), and the store has not seen it. The store key is
 * a hash of the thumbprint and the `jti`, so its size has a bound. The key
 * lives to `ceil(iat)` plus twice the window, as core's replay row: past
 * the last second that the `iat` check passes. A store that throws throws
 * here.
 */
export async function resourceProofHolds(
  dpop: ResolvedDpop,
  request: Request,
  bound: { token: string; jkt: string },
  nowSeconds: number,
): Promise<boolean> {
  const proof = request.headers.get("dpop");
  if (proof === null) return false;
  const r = await checkDpopProof({
    proof,
    method: request.method,
    // The resource check of the caller pins the origin, so the request URL is the target here.
    url: request.url,
    accessToken: bound.token,
    jkt: bound.jkt,
    algs: dpop.algs,
    windowSeconds: dpop.windowSeconds,
    nowSeconds,
  });
  if (!r.ok) return false;
  // A thumbprint is 43 base64url characters with no dot, so the joined text names one pair.
  const key = await sha256Hex(`${r.jkt}.${r.jti}`);
  const ttl = Math.max(1, Math.ceil(r.iat) + 2 * dpop.windowSeconds - nowSeconds);
  return !(await dpop.replay.seen(key, ttl));
}
