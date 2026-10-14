import type { ClientFailure } from "@authtempo/client";
import { JWKS_RETIRED_MAX, type PublicJwk } from "@authtempo/core/credentials";

/** The key set lives this long when its answer names no max-age. Core sends 300. */
export const KEY_SET_DEFAULT_SECONDS = 300;
/** A max-age above this is cut to it, so a wrong header cannot pin an old key set for a day. */
export const KEY_SET_MAX_SECONDS = 3600;
/** A max-age below this is raised to it, so `max-age=0` cannot cause a read at each request. */
export const KEY_SET_MIN_SECONDS = 60;
/** An unknown `kid` reads the key set again at most once in this window. */
export const UNKNOWN_KID_EVERY_MS = 30_000;
/** After a failed read, the cache answers the same failure for this long with no read. */
export const FAILED_READ_PAUSE_MS = 5000;
/**
 * The caps of a key set read (Task 9 review M2).
 * Core's largest set is the signing key and `JWKS_RETIRED_MAX` retired keys: 101 keys today.
 * Measured on 2026-10-15 (memory adapter, Node 26.10.0, after 110 rotations):
 * - the implementer: EdDSA 101 keys 14,251 bytes; ES256 101 keys 18,998 bytes;
 * - the reviewer: ES256 101 keys 18,989 bytes.
 * The body cap of 64 KiB is about 3.4 times the largest of these.
 */
export const KEY_SET_MAX_BYTES = 65_536;
/**
 * The most keys that a set may hold: core's own bound, from its one source.
 * A lower cap refuses a set that core can send, and every token then fails.
 */
export const KEY_SET_MAX_KEYS = JWKS_RETIRED_MAX + 1;

export interface KeyCache {
  /** The public key of `kid`, null when the set lacks it, or a failure when the set does not answer. */
  key(kid: string): Promise<{ ok: true; value: PublicJwk | null } | ClientFailure>;
}

function maxAgeSeconds(cacheControl: string | null): number {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "");
  if (!m?.[1]) return KEY_SET_DEFAULT_SECONDS;
  return Math.max(KEY_SET_MIN_SECONDS, Math.min(Number(m[1]), KEY_SET_MAX_SECONDS));
}

/** The body as text, or null when it is longer than the cap. */
async function cappedText(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > KEY_SET_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The key of one entry of the set, or null (plan 11d, Task 1 review).
 * `PublicJwk` is a compile-time type only, so the cache checks each fetched entry here.
 * `kty`, `crv`, and `alg` must be OKP, Ed25519, and EdDSA, or EC, P-256, and ES256.
 * An entry may leave out `use`; when it has one, the value must be `sig`.
 * An entry may leave out `key_ops`; when it has one, the list must hold `verify`.
 * An entry that fails is dropped, so a token that names it answers null: a bad key fails closed.
 * The answer is a new object of the known fields only.
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
 * The verifier's own key cache (plan 11d).
 * The set lives for the max-age of its answer, from 60 s to 3600 s.
 * An unknown `kid` reads the set again at most once per 30 s.
 * A burst of verifies at the start causes one read.
 * A read that fails answers the failure, never a stale set, so an outage is not a bad token.
 * For 5 s after a failed read, the cache answers that failure with no read.
 * The cache holds no retirement clock: core lists a retired key for 24 hours (spec 8.12).
 */
export function createKeyCache(input: {
  url: string;
  fetch: typeof fetch;
  now: () => number;
}): KeyCache {
  let keys: Map<string, PublicJwk> | null = null;
  let until = 0;
  let lastRead = Number.NEGATIVE_INFINITY;
  let failure: { at: number; answer: ClientFailure } | null = null;
  let inFlight: Promise<ClientFailure | null> | null = null;
  async function load(): Promise<ClientFailure | null> {
    let res: Response;
    let text: string | null;
    try {
      res = await input.fetch(input.url, { headers: { accept: "application/json" } });
      text = await cappedText(res);
    } catch {
      return { ok: false, code: "network", status: 0 };
    }
    if (text === null) return { ok: false, code: "unexpected", status: res.status };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, code: "unexpected", status: res.status };
    }
    const list = (body as { keys?: unknown } | null)?.keys;
    if (!res.ok || !Array.isArray(list) || list.length > KEY_SET_MAX_KEYS)
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
  async function read(): Promise<ClientFailure | null> {
    lastRead = input.now();
    const failed = await load();
    failure = failed ? { at: input.now(), answer: failed } : null;
    return failed;
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
        if (failure && now - failure.at < FAILED_READ_PAUSE_MS) return failure.answer;
        const failed = await refresh();
        if (failed) return failed;
      }
      return { ok: true, value: keys?.get(kid) ?? null };
    },
  };
}
