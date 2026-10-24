import { fromBase64Url } from "../primitives/crypto.js";
import { type OidcProvider, type RedirectOverride, stringClaim } from "./provider.js";

export interface MicrosoftConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
  /**
   * `common` (work, school, and personal accounts), `organizations` (work
   * and school accounts), `consumers` (personal accounts), or the GUID of
   * one tenant.
   */
  tenant: string;
}

const AUTHORITY = "https://login.microsoftonline.com";

/**
 * The `tid` of every personal Microsoft account (ID token claims reference,
 * read 2026-10-22).
 */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** The tenants whose tokens carry the issuer of the person's own tenant. */
export const MICROSOFT_SHARED_TENANTS: ReadonlySet<string> = new Set([
  "common",
  "organizations",
  "consumers",
]);

/** A tenant GUID in the lowercase form that Microsoft writes in `tid` and `iss`. */
export const TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The v2.0 issuer of one tenant. */
function tenantIssuer(tid: string): string {
  return `${AUTHORITY}/${tid}/v2.0`;
}

/**
 * Microsoft Entra ID on the v2.0 endpoints (plan 12i Task 13). The subject
 * is `oid`, the id that Better Auth 1.7.2 stores. Microsoft gives the same
 * `oid` to each app of the tenant; `sub` is pairwise per app.
 *
 * The address rule comes from the ID token claims reference and the
 * optional claims reference, both read 2026-10-22. They say that `email`
 * "isn't guaranteed to be correct and is mutable over time". `xms_edov` is
 * a boolean that says the domain owner of the address is verified. So an
 * address is verified only with `xms_edov: true`. The app must add that
 * optional claim to its registration. Without it, an Entra ID address links
 * no user (nOAuth). Better Auth also counts `email_verified` and the
 * `verified_*_email` lists. The reference pages give them no such meaning,
 * so core does not count them.
 */
export function microsoftProvider(c: MicrosoftConfig): OidcProvider {
  const tenant = c.tenant.toLowerCase();
  const shared = MICROSOFT_SHARED_TENANTS.has(tenant);
  return {
    kind: "oidc",
    name: "microsoft",
    label: "Continue with Microsoft",
    authorizeUrl: `${AUTHORITY}/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `${AUTHORITY}/${tenant}/oauth2/v2.0/token`,
    jwksUrl: `${AUTHORITY}/${tenant}/discovery/v2.0/keys`,
    // A shared tenant has no one issuer: `issuerOf` gives it per token.
    issuer: shared ? [] : [tenantIssuer(tenant)],
    ...(shared ? { issuerOf: sharedIssuerOf } : {}),
    checkClaims: (claims) => tenantBound(tenant, claims),
    clientId: c.clientId,
    scope: "openid profile email",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    profile(claims) {
      const email = stringClaim(claims, "email");
      return {
        subject: stringClaim(claims, "oid") ?? "",
        email,
        // Only the boolean counts, and only beside an address.
        emailVerified: email !== null && claims.xms_edov === true,
        name: stringClaim(claims, "name"),
        image: null,
      };
    },
  };
}

/**
 * The issuer to verify a shared tenant's token against. It is the token's
 * own `iss`, read before the signature check, when it has the form of a
 * tenant issuer. The jwt seam then verifies the signature on the tenant's keys and
 * checks `iss` again. `checkClaims` binds that issuer to the verified `tid`.
 */
function sharedIssuerOf(idToken: string): string[] | null {
  const iss = unverifiedClaims(idToken)?.iss;
  if (typeof iss !== "string") return null;
  const tid = iss.slice(AUTHORITY.length + 1, -"/v2.0".length);
  return TENANT_GUID_RE.test(tid) && iss === tenantIssuer(tid) ? [iss] : null;
}

/**
 * The tenant binding of a verified token, as Better Auth 1.7.2's
 * `verifyClaims`. The `iss` names the token's own `tid`. A GUID tenant
 * takes only its own tokens. `organizations` refuses a personal account,
 * and `consumers` takes only a personal account.
 */
function tenantBound(tenant: string, claims: Record<string, unknown>): boolean {
  const tid = claims.tid;
  if (typeof tid !== "string" || !TENANT_GUID_RE.test(tid)) return false;
  if (claims.iss !== tenantIssuer(tid)) return false;
  if (tenant === "common") return true;
  if (tenant === "organizations") return tid !== MICROSOFT_CONSUMER_TENANT;
  if (tenant === "consumers") return tid === MICROSOFT_CONSUMER_TENANT;
  return tid === tenant;
}

/** The payload of a compact JWS, not verified, or null when it does not parse. */
function unverifiedClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
