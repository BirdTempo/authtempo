import {
  type OAuth2Provider,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface LinkedInConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
}

const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

/**
 * "Sign In with LinkedIn using OpenID Connect" (plan 9c), as an `oauth2`
 * provider on the user info endpoint, as Better Auth 1.7.2 is (controller
 * ruling, 2026-10-12). The token answer may carry an ID token; this preset
 * ignores it, because LinkedIn's `nonce` echo and its real `iss` are
 * unverified on 2026-10-12, and an ID token check would then fail every
 * sign-in. Endpoints, scope, and the user info shape from LinkedIn's
 * discovery document and guide page, read 2026-10-12. LinkedIn's acceptance
 * of PKCE on a web client is unverified; the parameters do no harm, as for
 * Apple. The subject is `sub`, the id that Better Auth stored. It is
 * pairwise per client id.
 */
export function linkedinProvider(c: LinkedInConfig): OAuth2Provider {
  return {
    kind: "oauth2",
    name: "linkedin",
    label: "Continue with LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    clientId: c.clientId,
    scope: "openid profile email",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    userinfo: linkedinUserinfo,
  };
}

/**
 * The profile from `GET /v2/userinfo`. `email` and `email_verified` are
 * optional in LinkedIn's answer; only the boolean `true` is a verified
 * address. A failed answer or one with no `sub` throws, and the engine
 * answers `oauth_failed`.
 */
export async function linkedinUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<SocialProfile> {
  const res = await fetchFn(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`linkedin userinfo answered ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("linkedin userinfo is not an object");
  const u = body as Record<string, unknown>;
  const subject = stringClaim(u, "sub");
  if (subject === null) throw new Error("linkedin userinfo has no sub");
  return {
    subject,
    email: stringClaim(u, "email"),
    emailVerified: u.email_verified === true,
    name: stringClaim(u, "name"),
    image: stringClaim(u, "picture"),
  };
}
