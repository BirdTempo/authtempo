import {
  type OAuth2Provider,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface FacebookConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
}

/** The Graph API version: the newest in Meta's Graph API changelog, read 2026-10-24. */
export const GRAPH_VERSION = "v26.0";

/**
 * The profile read on the pinned version. Meta's versioning guide (read
 * 2026-10-24) says an unversioned call uses the version of the app dashboard.
 */
const ME_URL = `https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id,name,email,picture`;
/** An app-scoped user id: decimal text. */
const FB_ID_RE = /^[1-9][0-9]{0,24}$/;

/**
 * Facebook Login as an `oauth2` provider (plan 12i Task 14). The endpoints
 * are from Meta's manual login flow page, read 2026-10-24. That page names
 * no PKCE. Core sends the PKCE parameters to every provider, as for
 * LinkedIn. The token comes from core's own code exchange with the app
 * secret, so it is bound to this app. Better Auth's `debug_token` check
 * guards a token that a client brings, and core takes no such token here.
 */
export function facebookProvider(c: FacebookConfig): OAuth2Provider {
  return {
    kind: "oauth2",
    name: "facebook",
    label: "Continue with Facebook",
    authorizeUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
    clientId: c.clientId,
    scope: "email public_profile",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    userinfo: facebookUserinfo,
  };
}

/**
 * The profile from `GET /me`. The subject is the app-scoped user `id`, the
 * id that Better Auth 1.7.2 stores. The address is never verified. The
 * User reference (read 2026-10-24) calls `email` the primary address on
 * the profile, and has no field that proves the mailbox. So a Facebook
 * address can fill a new user, unverified, and never links an existing
 * user.
 */
export async function facebookUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<SocialProfile> {
  const res = await fetchFn(ME_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`facebook /me answered ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("facebook /me is not an object");
  const u = body as Record<string, unknown>;
  const subject = stringClaim(u, "id");
  if (subject === null || !FB_ID_RE.test(subject)) throw new Error("facebook /me has no user id");
  return {
    subject,
    email: stringClaim(u, "email"),
    emailVerified: false,
    name: stringClaim(u, "name"),
    image: pictureUrl(u.picture),
  };
}

/** `picture.data.url` of a `/me` answer, or null. */
function pictureUrl(picture: unknown): string | null {
  if (typeof picture !== "object" || picture === null) return null;
  const data = (picture as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  return stringClaim(data as Record<string, unknown>, "url");
}
