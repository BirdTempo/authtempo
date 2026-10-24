import {
  type OAuth2Provider,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface DiscordConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
}

const USER_URL = "https://discord.com/api/users/@me";

/** A Discord id: a snowflake, a 64-bit integer as decimal text. */
const SNOWFLAKE_RE = /^[1-9][0-9]{0,19}$/;
/** An avatar hash; `a_` marks an animated one. */
const AVATAR_RE = /^(a_)?[0-9a-f]{32}$/;

/**
 * Discord issues no ID token, so this is an `oauth2` provider (plan 12i
 * Task 13). Endpoints and the client auth from Discord's OAuth2 topic page,
 * read 2026-10-22: the token URL takes `client_id` and `client_secret` in
 * the form body. The subject is the user `id`, the id that Better Auth
 * 1.7.2 stores.
 */
export function discordProvider(c: DiscordConfig): OAuth2Provider {
  return {
    kind: "oauth2",
    name: "discord",
    label: "Continue with Discord",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    clientId: c.clientId,
    scope: "identify email",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    userinfo: discordUserinfo,
  };
}

/**
 * The profile from `GET /users/@me`. The user resource page (read
 * 2026-10-22) defines `verified` as "whether the email on this account has
 * been verified", under the `email` scope. Only the boolean `true` beside an
 * address is a verified address. A failed answer or an answer with no
 * snowflake id throws, and the engine answers `oauth_failed`.
 */
export async function discordUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<SocialProfile> {
  const res = await fetchFn(USER_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`discord /users/@me answered ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("discord /users/@me is not an object");
  const u = body as Record<string, unknown>;
  const subject = stringClaim(u, "id");
  if (subject === null || !SNOWFLAKE_RE.test(subject))
    throw new Error("discord /users/@me has no snowflake id");
  const email = stringClaim(u, "email");
  const avatar = stringClaim(u, "avatar");
  return {
    subject,
    email,
    emailVerified: email !== null && u.verified === true,
    name: stringClaim(u, "global_name") ?? stringClaim(u, "username"),
    image:
      avatar !== null && AVATAR_RE.test(avatar)
        ? `https://cdn.discordapp.com/avatars/${subject}/${avatar}.${avatar.startsWith("a_") ? "gif" : "png"}`
        : null,
  };
}
