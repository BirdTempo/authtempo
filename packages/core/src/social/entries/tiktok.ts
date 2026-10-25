import type { OAuth2Entry } from "../oauth2.js";
import {
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
  type TokenRequestAnswer,
  type TokenRequestInput,
} from "../provider.js";
import { answerObject, requiredText } from "./shared.js";

export interface TiktokEntryConfig extends RedirectOverride {
  /** TikTok's name for the client id. */
  clientKey: string;
  clientSecret: string;
}

// The endpoints of Login Kit for Web and of the token page ("Last updated
// August 4, 2026"), and of the user info page ("Last updated October 23,
// 2026"), each read 2026-10-24.
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USERINFO_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name";

/**
 * "Continue with TikTok" as an `oauth2` list entry (plan 12i Task 22).
 * TikTok names the client id `client_key`, in the authorize query and in
 * the token form, so the entry sets `authorizeClientIdParam` and a
 * `tokenRequest`. The scope `user.info.basic` gives `open_id`, `union_id`,
 * `avatar_url`, and `display_name`. The user object has no address field,
 * so the entry is `addressless`. Two facts stay unread. First, the Login
 * Kit page names no PKCE: the entry sends it, and the owner's real sign-in
 * proves that TikTok accepts it. Second, the token page names no HTTP
 * status for an error, so any status other than 2xx fails too.
 */
export function tiktokEntry(c: TiktokEntryConfig): OAuth2Entry {
  return {
    name: "tiktok",
    label: "Continue with TikTok",
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    clientId: c.clientKey,
    clientSecret: c.clientSecret,
    scope: "user.info.basic",
    authorizeClientIdParam: "client_key",
    addressless: true,
    tokenRequest: tiktokToken,
    userinfo: tiktokUserinfo,
    ...(c.redirectURI !== undefined ? { redirectURI: c.redirectURI } : {}),
  };
}

/**
 * The token exchange: a form POST with `client_key` and `client_secret`.
 * An error answer holds `error`, `error_description`, and `log_id`, and
 * throws. The answer's `open_id` goes to `userinfo` in `extra`.
 */
export async function tiktokToken(input: TokenRequestInput): Promise<TokenRequestAnswer> {
  const form = new URLSearchParams({
    client_key: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  if (input.codeVerifier !== null) form.set("code_verifier", input.codeVerifier);
  const res = await input.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const body = await answerObject(res, "tiktok token");
  if (body.error !== undefined) throw new Error("tiktok token answered an error");
  return {
    accessToken: requiredText(body, "access_token", "tiktok token"),
    extra: { open_id: requiredText(body, "open_id", "tiktok token") },
  };
}

/**
 * The profile from `GET /v2/user/info/`. The envelope must hold
 * `error.code: "ok"`. The subject is `open_id`, as Better Auth 1.7.2 keeps
 * it, and it must equal the `open_id` of the token answer. TikTok proves no
 * address, so the profile has none.
 */
export async function tiktokUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
  extra: Record<string, string>,
): Promise<SocialProfile> {
  const res = await fetchFn(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const body = await answerObject(res, "tiktok user info");
  const error = body.error;
  if (typeof error !== "object" || error === null || (error as { code?: unknown }).code !== "ok")
    throw new Error("tiktok user info answered an error");
  const data = body.data;
  const user =
    typeof data === "object" && data !== null ? (data as { user?: unknown }).user : undefined;
  if (typeof user !== "object" || user === null) throw new Error("tiktok user info has no user");
  const u = user as Record<string, unknown>;
  const openId = requiredText(u, "open_id", "tiktok user info");
  if (openId !== extra.open_id) throw new Error("tiktok user info names another open_id");
  return {
    subject: openId,
    email: null,
    emailVerified: false,
    name: stringClaim(u, "display_name"),
    image: stringClaim(u, "avatar_url"),
  };
}
