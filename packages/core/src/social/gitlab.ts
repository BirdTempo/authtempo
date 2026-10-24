import { isIpLiteral, isLocalHost } from "../primitives/host.js";
import {
  type OAuth2Provider,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface GitLabConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
  /** The https origin of the GitLab instance. Default `https://gitlab.com`. */
  issuer?: string;
}

export const DEFAULT_GITLAB_ISSUER = "https://gitlab.com";

/**
 * True for an `https:` origin on a public host. The origin has no path,
 * query, fragment, user, or trailing slash. A public host is not an IP
 * literal, not a local name, and not the host of `baseURL`. Core posts the
 * client secret to this host, so a config must not point it inside a
 * network or at core itself.
 */
export function isGitlabIssuer(value: unknown, baseURL: string): value is string {
  if (typeof value !== "string") return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.origin !== value) return false;
  const host = u.hostname.replace(/\.$/, "");
  return !isIpLiteral(host) && !isLocalHost(host) && host !== new URL(baseURL).hostname;
}

/**
 * GitLab, on gitlab.com or on the app's own instance, as an `oauth2`
 * provider (plan 12i Task 13). The endpoints and the subject are those of
 * Better Auth 1.7.2: the subject is the numeric `id` as a string. Scope `read_user` gives `GET
 * /api/v4/user`.
 */
export function gitlabProvider(c: GitLabConfig): OAuth2Provider {
  const issuer = c.issuer ?? DEFAULT_GITLAB_ISSUER;
  return {
    kind: "oauth2",
    name: "gitlab",
    label: "Continue with GitLab",
    authorizeUrl: `${issuer}/oauth/authorize`,
    tokenUrl: `${issuer}/oauth/token`,
    clientId: c.clientId,
    scope: "read_user",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    userinfo: (accessToken, fetchFn) => gitlabUserinfo(issuer, accessToken, fetchFn),
  };
}

/**
 * The profile from `GET /api/v4/user`. A user whose `state` is not
 * `active`, or who is `locked`, throws, and the engine answers
 * `oauth_failed`, as Better Auth 1.7.2 refuses them.
 *
 * The address is never verified. The Users API page (read 2026-10-22)
 * names no field that proves the mailbox: it has `email` and
 * `confirmed_at`, and says neither confirms the address. So a GitLab
 * address links no existing user.
 */
export async function gitlabUserinfo(
  issuer: string,
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<SocialProfile> {
  const res = await fetchFn(`${issuer}/api/v4/user`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`gitlab /api/v4/user answered ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("gitlab /api/v4/user is not an object");
  const u = body as Record<string, unknown>;
  const id = u.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new Error("gitlab /api/v4/user has no numeric id");
  if (u.state !== "active" || u.locked === true)
    throw new Error("gitlab user is not active or is locked");
  return {
    subject: String(id),
    email: stringClaim(u, "email"),
    emailVerified: false,
    name: stringClaim(u, "name") ?? stringClaim(u, "username"),
    image: stringClaim(u, "avatar_url"),
  };
}
