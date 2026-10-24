import {
  type OAuth2Provider,
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
} from "./provider.js";

export interface TwitterConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
}

const ME_URL = "https://api.x.com/2/users/me";
/** An X user id: a 64-bit integer as decimal text. */
const X_ID_RE = /^[1-9][0-9]{0,19}$/;

/**
 * X (the provider name `twitter`, as in Better Auth 1.7.2) as an `oauth2`
 * provider (plan 12i Task 14). From X's OAuth 2.0 pages, read 2026-10-24:
 * the authorize URL takes a PKCE challenge, and a confidential client sends
 * an `Authorization: Basic` header of its id and secret to the token URL.
 */
export function twitterProvider(c: TwitterConfig): OAuth2Provider {
  return {
    kind: "oauth2",
    name: "twitter",
    label: "Continue with X",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    clientId: c.clientId,
    scope: "users.read tweet.read users.email",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    // The confidential client example of X's token step, read 2026-10-24.
    tokenAuth: "client_secret_basic",
    userinfo: twitterUserinfo,
  };
}

/** The `data` object of a `GET /2/users/me` answer, or null. */
async function meData(res: Response): Promise<Record<string, unknown> | null> {
  if (!res.ok) return null;
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const data = (body as Record<string, unknown>).data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * The profile from two reads of `GET /2/users/me`, as Better Auth 1.7.2
 * makes them. The first gives the id, the name, and the image, and a
 * failure throws. The second asks for `confirmed_email`. The data
 * dictionary (read 2026-10-24) defines it as "the confirmed email of the
 * authenticated user", so it is a verified address. A failed second read
 * gives no address, so an app without email access still signs in.
 */
export async function twitterUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<SocialProfile> {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  const user = await meData(await fetchFn(`${ME_URL}?user.fields=profile_image_url`, { headers }));
  if (user === null) throw new Error("x /2/users/me has no data");
  const subject = stringClaim(user, "id");
  if (subject === null || !X_ID_RE.test(subject)) throw new Error("x /2/users/me has no user id");
  const mail = await meData(await fetchFn(`${ME_URL}?user.fields=confirmed_email`, { headers }));
  // An address of another id is not this person's address.
  const email = mail !== null && mail.id === subject ? stringClaim(mail, "confirmed_email") : null;
  return {
    subject,
    email,
    emailVerified: email !== null,
    name: stringClaim(user, "name") ?? stringClaim(user, "username"),
    image: stringClaim(user, "profile_image_url"),
  };
}
