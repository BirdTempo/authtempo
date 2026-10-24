import type { Observer } from "../observe/observer.js";
import {
  isHttpsUrl,
  type OidcDiscovery,
  type OidcProvider,
  PROVIDER_TIMEOUT_MS,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface OidcEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

/** An entry of `social.oidc`: an OpenID Connect provider (plan 9c). */
export interface OidcEntry extends RedirectOverride {
  /** The route segment and the identity provider name. `^[a-z][a-z0-9-]{0,31}$`. */
  name: string;
  /** The sign-in page button text. 1 to 80 characters, no control character. */
  label: string;
  /** The exact `iss` value, for example `https://login.microsoftonline.com/<tenant>/v2.0`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Default `openid email profile`. Must hold `openid`, or the provider sends no ID token. */
  scope?: string;
  /** Set them and core never reads the discovery document. */
  endpoints?: OidcEndpoints;
}

export const DEFAULT_OIDC_SCOPE = "openid email profile";

/** The standard claims. Only the boolean `email_verified: true` is a verified address. */
export function standardProfile(claims: Record<string, unknown>): SocialProfile {
  return {
    subject: stringClaim(claims, "sub") ?? "",
    email: stringClaim(claims, "email"),
    emailVerified: claims.email_verified === true,
    name: stringClaim(claims, "name"),
    image: stringClaim(claims, "picture"),
  };
}

/** OpenID Connect Discovery 1.0, section 4: the issuer without a trailing slash, plus the well-known path. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
}

/** An `https:` URL with no query, fragment, or credentials. A path and a trailing slash are allowed. */
export function isIssuer(value: unknown): value is string {
  if (!isHttpsUrl(value) || value.includes("?") || value.includes("#")) return false;
  const u = new URL(value);
  return u.username === "" && u.password === "";
}

/** Builds the provider, or the discovery entry when the entry has no endpoints. `resolveConfig` has checked the entry. */
export function oidcProvider(entry: OidcEntry): OidcProvider | OidcDiscovery {
  const common = {
    name: entry.name,
    label: entry.label,
    clientId: entry.clientId,
    scope: entry.scope ?? DEFAULT_OIDC_SCOPE,
    authorizeParams: {},
    callbackMethod: "GET" as const,
    clientSecret: async () => entry.clientSecret,
  };
  const build = (e: OidcEndpoints): OidcProvider => ({
    ...common,
    kind: "oidc",
    authorizeUrl: e.authorizeUrl,
    tokenUrl: e.tokenUrl,
    jwksUrl: e.jwksUrl,
    issuer: [entry.issuer],
    profile: (claims) => standardProfile(claims),
  });
  if (entry.endpoints) return build(entry.endpoints);
  let kept: OidcProvider | null = null;
  return {
    ...common,
    kind: "oidc-discovery",
    async resolve(fetchFn, observe) {
      if (kept) return kept;
      const endpoints = await discover(observe, entry.name, entry.issuer, fetchFn);
      if (endpoints) kept = build(endpoints);
      return kept;
    },
  };
}

/**
 * The three endpoints from the issuer's discovery document, or null with one
 * log line. The document's `issuer` must equal the configured issuer exactly,
 * so a document from another tenant or another host is refused.
 */
export async function discover(
  observe: Observer,
  name: string,
  issuer: string,
  fetchFn: typeof fetch,
): Promise<OidcEndpoints | null> {
  let res: Response;
  try {
    res = await fetchFn(discoveryUrl(issuer), {
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    observe.emit({ name: "oidc.discovery_failed", provider: name, errorClass: e });
    return null;
  }
  if (!res.ok) {
    observe.emit({ name: "oidc.discovery_status", provider: name, status: res.status });
    return null;
  }
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    observe.emit({ name: "oidc.discovery_not_json", provider: name });
    return null;
  }
  const d = (typeof doc === "object" && doc !== null && !Array.isArray(doc) ? doc : {}) as Record<
    string,
    unknown
  >;
  if (d.issuer !== issuer) {
    observe.emit({ name: "oidc.issuer_mismatch", provider: name });
    return null;
  }
  const authorizeUrl = d.authorization_endpoint;
  const tokenUrl = d.token_endpoint;
  const jwksUrl = d.jwks_uri;
  if (!isHttpsUrl(authorizeUrl) || !isHttpsUrl(tokenUrl) || !isHttpsUrl(jwksUrl)) {
    observe.emit({ name: "oidc.endpoint_missing", provider: name });
    return null;
  }
  return { authorizeUrl, tokenUrl, jwksUrl };
}
