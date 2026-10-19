import { sha256Base64Url } from "./crypto.js";
import {
  decodeForeignJws,
  type ForeignAlg,
  jwkThumbprint,
  publicMembersOnly,
  verifyForeign,
} from "./foreign-jwk.js";

/**
 * The DPoP proof of RFC 9449 (read 2026-10-20 at rfc-editor.org). This
 * check is pure: it reads no store, so a resource server runs the same
 * code (Task 10). The caller spends the `jti` in its own replay store.
 */

/** The `typ` of a DPoP proof (RFC 9449 section 4.2). */
export const DPOP_TYP = "dpop+jwt";
/** The longest `jti`: section 11.1 asks a server to refuse a large one. Core stores its hash only. */
const JTI_MAX = 256;

export interface DpopCheckInput {
  /** The value of the `DPoP` header, as `Headers.get` answers it. */
  proof: string;
  /** The method of the request. */
  method: string;
  /** The URL of the request. */
  url: string;
  /** The access token of a resource request. The proof must then carry its `ath`. */
  accessToken?: string;
  /** The `cnf.jkt` of that access token. The key of the proof must have this thumbprint. */
  jkt?: string;
  algs: readonly ForeignAlg[];
  windowSeconds: number;
  nowSeconds: number;
}

export type DpopCheck =
  | { ok: true; jkt: string; jti: string; iat: number }
  | { ok: false; reason: string };

/** The key of a DPoP binding: the RFC 7638 thumbprint of the proof key. */
export interface DpopBinding {
  jkt: string;
}

/** Origin and path of a URL, or null: section 4.3 item 9 ignores the query and the fragment. */
function targetOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * The checks of RFC 9449 section 4.3, in this order, with the first
 * failure as the reason. Item 10 (the nonce) does not apply: core gives no
 * nonce. The URL parse normalizes the scheme, the host, and the port of
 * `htu` and of the request URL, as section 4.3 asks.
 */
export async function checkDpopProof(input: DpopCheckInput): Promise<DpopCheck> {
  const no = (reason: string): DpopCheck => ({ ok: false, reason });
  // Item 1. Headers.get joins two fields with a comma, and a compact JWS has none.
  if (input.proof.includes(",")) return no("two DPoP headers");
  // Item 2.
  const d = decodeForeignJws(input.proof);
  if (!d) return no("not one compact JWS");
  // Item 4.
  if (d.header.typ !== DPOP_TYP) return no("typ is not dpop+jwt");
  // Item 5: `none` and a MAC are never in the list.
  if (!(input.algs as readonly string[]).includes(d.header.alg)) return no("alg is not accepted");
  // Item 7.
  const jwk = d.header.jwk;
  if (!publicMembersOnly(jwk)) return no("jwk is not a public key");
  // Item 6.
  if (!(await verifyForeign(d, jwk as Record<string, unknown>, input.algs)))
    return no("signature does not verify");
  // Item 3 and items 8 to 11: each claim of section 4.2.
  const p = d.payload;
  if (typeof p.jti !== "string" || p.jti.length < 1 || p.jti.length > JTI_MAX)
    return no("jti is missing or too long");
  if (p.htm !== input.method) return no("htm is not the method");
  const target = targetOf(input.url);
  if (typeof p.htu !== "string" || target === null || targetOf(p.htu) !== target)
    return no("htu is not the URL");
  // Section 11.1: a short window. A client clock may run ahead, so the window applies both ways.
  if (
    typeof p.iat !== "number" ||
    !Number.isFinite(p.iat) ||
    Math.abs(p.iat - input.nowSeconds) > input.windowSeconds
  )
    return no("iat is outside the window");
  // Item 12.
  if (input.accessToken !== undefined && p.ath !== (await sha256Base64Url(input.accessToken)))
    return no("ath is not the token hash");
  const jkt = await jwkThumbprint(jwk as Record<string, unknown>);
  if (jkt === null) return no("jwk is not a public key");
  if (input.jkt !== undefined && input.jkt !== jkt) return no("key is not the token key");
  return { ok: true, jkt, jti: p.jti, iat: p.iat };
}
