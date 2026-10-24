import {
  type OAuth2Provider,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface SlackConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
}

const USERINFO_URL = "https://slack.com/api/openid.connect.userInfo";
/** The user id claim, the key that Better Auth 1.7.2 reads as the account id. */
const USER_ID = "https://slack.com/user_id";
/** The workspace id claim of the user info answer, read 2026-10-24. */
const TEAM_ID = "https://slack.com/team_id";

/**
 * "Sign in with Slack" as an `oauth2` provider on the user info endpoint
 * (plan 12i Task 14), as Better Auth 1.7.2 is. The endpoints and the scope
 * are from Slack's `openid.connect.token` and `openid.connect.userInfo`
 * method pages, read 2026-10-24. The token page takes a PKCE
 * `code_verifier`, and names no Basic client auth, so the secret goes in
 * the form. Each method answers an error with `ok: false`, so the token
 * answer must hold `ok: true`.
 */
export function slackProvider(c: SlackConfig): OAuth2Provider {
  return {
    kind: "oauth2",
    name: "slack",
    label: "Continue with Slack",
    authorizeUrl: "https://slack.com/openid/connect/authorize",
    tokenUrl: "https://slack.com/api/openid.connect.token",
    clientId: c.clientId,
    scope: "openid profile email",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    tokenAnswerOk: (body) => body.ok === true,
    userinfo: slackUserinfo,
  };
}

/**
 * The profile from `openid.connect.userInfo`. The subject is
 * `<team_id>:<user_id>`. Slack's user object page (read 2026-10-24) says a
 * user id is unique only in its workspace, and names the pair as the
 * unique key. The engine finds an identity by `(provider, subject)`, so a
 * user id alone from a second workspace could sign in as another person.
 * Better Auth 1.7.2 stores the user id alone; plan 12i Task 16 maps that
 * row. Only the boolean `email_verified: true` makes the address verified.
 * An answer with no `ok: true`, no team id, or no user id throws, and the
 * engine answers `oauth_failed`.
 */
export async function slackUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<SocialProfile> {
  const res = await fetchFn(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`slack userInfo answered ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("slack userInfo is not an object");
  const u = body as Record<string, unknown>;
  if (u.ok !== true) throw new Error("slack userInfo answered ok false");
  const team = stringClaim(u, TEAM_ID);
  const user = stringClaim(u, USER_ID);
  // A colon in either id would let two pairs give one subject.
  if (team === null || team.includes(":")) throw new Error("slack userInfo has no team id");
  if (user === null || user.includes(":")) throw new Error("slack userInfo has no user id");
  const subject = `${team}:${user}`;
  const email = stringClaim(u, "email");
  return {
    subject,
    email,
    emailVerified: email !== null && u.email_verified === true,
    name: stringClaim(u, "name"),
    image: stringClaim(u, "picture"),
  };
}
