import type { ClientFailure } from "@authtempo/client";
import type { PublicJwk } from "@authtempo/core/credentials";

/** The key set lives this long when its answer names no max-age. Core sends 300. */
export const KEY_SET_DEFAULT_SECONDS = 300;
/** A max-age above this is cut to it, so a wrong header cannot pin an old key set for a day. */
export const KEY_SET_MAX_SECONDS = 3600;
/** An unknown `kid` reads the key set again at most once in this window. */
export const UNKNOWN_KID_EVERY_MS = 30_000;

export interface KeyCache {
  /** The public key of `kid`, null when the set lacks it, or a failure when the set does not answer. */
  key(kid: string): Promise<{ ok: true; value: PublicJwk | null } | ClientFailure>;
}

function maxAgeSeconds(cacheControl: string | null): number {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "");
  if (!m?.[1]) return KEY_SET_DEFAULT_SECONDS;
  return Math.min(Number(m[1]), KEY_SET_MAX_SECONDS);
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The key of one entry of the set, or null (plan 11d, Task 1 review).
 * `PublicJwk` is a compile-time type only, so each fetched entry is checked
 * here at run time: `kty`, `crv`, and `alg` must be one of the two pairs that
 * core signs with (OKP, Ed25519, EdDSA or EC, P-256, ES256), `use` must be
 * `sig` when present, and `key_ops` must hold `verify` when present. An entry
 * that fails is dropped, so a token that names it answers null: a bad key
 * fails closed. The answer is a new object of the known fields only.
 */
export function publicKeyOf(entry: unknown): PublicJwk | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const j = entry as Record<string, unknown>;
  if (typeof j.kid !== "string" || j.kid === "") return null;
  if (typeof j.x !== "string" || !B64URL.test(j.x)) return null;
  if (j.use !== undefined && j.use !== "sig") return null;
  if (j.key_ops !== undefined && !(Array.isArray(j.key_ops) && j.key_ops.includes("verify")))
    return null;
  if (j.kty === "OKP" && j.crv === "Ed25519" && j.alg === "EdDSA")
    return { kty: "OKP", crv: "Ed25519", x: j.x, kid: j.kid, alg: "EdDSA", use: "sig" };
  if (
    j.kty === "EC" &&
    j.crv === "P-256" &&
    j.alg === "ES256" &&
    typeof j.y === "string" &&
    B64URL.test(j.y)
  )
    return { kty: "EC", crv: "P-256", x: j.x, y: j.y, kid: j.kid, alg: "ES256", use: "sig" };
  return null;
}

/**
 * The verifier's own key cache (plan 11d): the set lives for the max-age of
 * its answer, an unknown `kid` reads it again at most once per 30 s, and a
 * burst of verifies at the start causes one read. A read that fails answers
 * the failure, never a stale set, so an outage is not a bad token. The
 * verifier holds no retirement clock: core lists a retired key for 24 hours
 * (spec 8.12) and drops it after, and the cache follows the set.
 */
export function createKeyCache(input: {
  url: string;
  fetch: typeof fetch;
  now: () => number;
}): KeyCache {
  let keys: Map<string, PublicJwk> | null = null;
  let until = 0;
  let lastRead = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<ClientFailure | null> | null = null;
  async function read(): Promise<ClientFailure | null> {
    lastRead = input.now();
    let res: Response;
    try {
      res = await input.fetch(input.url, { headers: { accept: "application/json" } });
    } catch {
      return { ok: false, code: "network", status: 0 };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, code: "unexpected", status: res.status };
    }
    const list = (body as { keys?: unknown } | null)?.keys;
    if (!res.ok || !Array.isArray(list))
      return { ok: false, code: "unexpected", status: res.status };
    const next = new Map<string, PublicJwk>();
    for (const entry of list) {
      const k = publicKeyOf(entry);
      if (k && !next.has(k.kid)) next.set(k.kid, k);
    }
    keys = next;
    until = input.now() + maxAgeSeconds(res.headers.get("cache-control")) * 1000;
    return null;
  }
  const refresh = (): Promise<ClientFailure | null> => {
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return {
    async key(kid) {
      const now = input.now();
      const stale = keys === null || now >= until;
      const unknown = !stale && !keys?.has(kid) && now - lastRead >= UNKNOWN_KID_EVERY_MS;
      if (stale || unknown) {
        const failed = await refresh();
        if (failed) return failed;
      }
      return { ok: true, value: keys?.get(kid) ?? null };
    },
  };
}
