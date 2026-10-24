import {
  type OAuth2Provider,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface GitHubConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
}

const API = "https://api.github.com";

/**
 * GitHub OAuth apps issue no ID token, so this is an `oauth2` provider
 * (plan 9c). Checked 2026-10-12 in GitHub's docs: "Authorizing OAuth apps"
 * (the authorize and token URLs, PKCE with S256, JSON with
 * `Accept: application/json`), the REST pages for users and emails (API
 * version 2022-11-28), and "Getting started with the REST API" (a request
 * with no `User-Agent` is refused). Better Auth 1.7.2 makes the same two
 * calls and takes `profile.id` as the account id.
 */
export function githubProvider(c: GitHubConfig): OAuth2Provider {
  return {
    kind: "oauth2",
    name: "github",
    label: "Continue with GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: c.clientId,
    scope: "read:user user:email",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    userinfo: githubUserinfo,
  };
}

/**
 * The one GitHub subject rule: the decimal text of a positive safe integer,
 * with no sign, no leading zero, and no exponent. This preset answers only
 * such a subject (`String(id)`), so an identity with another subject can
 * never sign in. The importer (`@authtempo/import`) drops one with this
 * rule, so the two never drift.
 */
export function isGithubSubject(subject: string): boolean {
  return /^[1-9][0-9]{0,15}$/.test(subject) && Number.isSafeInteger(Number(subject));
}

interface GitHubEmail {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
}

/**
 * The profile from `/user` and `/user/emails`. The subject is the numeric id
 * as a string, the id that Better Auth stored. Only the primary address
 * counts, and it is verified only with `verified: true`. A 403 or 404 on
 * `/user/emails` (a token without `user:email`) gives the public address of
 * `/user`, unverified. Any other failure throws, and the engine answers
 * `oauth_failed`.
 */
export async function githubUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<SocialProfile> {
  const userRes = await fetchFn(`${API}/user`, { headers: githubHeaders(accessToken) });
  if (!userRes.ok) throw new Error(`github /user answered ${userRes.status}`);
  const user = (await userRes.json()) as Record<string, unknown> | null;
  const id = user?.id;
  const subject = typeof id === "number" ? String(id) : null;
  if (user === null || subject === null || !isGithubSubject(subject))
    throw new Error("github /user has no numeric id");
  const emailsRes = await fetchFn(`${API}/user/emails`, { headers: githubHeaders(accessToken) });
  let emails: GitHubEmail[] = [];
  if (emailsRes.ok) {
    const body: unknown = await emailsRes.json();
    if (Array.isArray(body)) emails = body as GitHubEmail[];
  } else if (emailsRes.status !== 403 && emailsRes.status !== 404) {
    throw new Error(`github /user/emails answered ${emailsRes.status}`);
  }
  const primary = emails.find(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      e.primary === true &&
      typeof e.email === "string" &&
      e.email.length > 0,
  );
  return {
    subject,
    email: typeof primary?.email === "string" ? primary.email : stringClaim(user, "email"),
    emailVerified: primary?.verified === true,
    name: stringClaim(user, "name") ?? stringClaim(user, "login"),
    image: stringClaim(user, "avatar_url"),
  };
}

function githubHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    // The version of the shapes above. GitHub keeps a version for at least 24 months after its successor (docs, read 2026-10-12).
    "x-github-api-version": "2022-11-28",
    // GitHub refuses a REST request with no User-Agent (docs, read 2026-10-12).
    "user-agent": "authtempo",
  };
}
