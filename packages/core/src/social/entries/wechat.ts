import type { OAuth2Entry } from "../oauth2.js";
import {
  type RedirectOverride,
  type SocialProfile,
  stringClaim,
  type TokenRequestAnswer,
  type TokenRequestInput,
} from "../provider.js";
import { answerObject, requiredText } from "./shared.js";

export interface WechatEntryConfig extends RedirectOverride {
  appId: string;
  appSecret: string;
}

// The Website App WeChat Login page and the UnionID call page, each "最后一次
// 编辑于 2026-06-25" (last edited 2026-06-25), read 2026-10-24.
const AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect";
const TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";

/**
 * "Continue with WeChat" as an `oauth2` list entry (plan 12i Task 22), for
 * a website app of the WeChat Open Platform. The authorize query takes
 * `appid` and ends with `#wechat_redirect`. The docs name no PKCE and no
 * nonce, so `pkce` is false, and the state row and the binding cookie bind
 * the callback (spec 8.3). No answer holds an address, so the entry is
 * `addressless`. One fact stays unread: whether a `unionid` can appear for
 * a user whose first sign-in had only an `openid`. The subject would then
 * change, and that user would get a second account.
 */
export function wechatEntry(c: WechatEntryConfig): OAuth2Entry {
  return {
    name: "wechat",
    label: "Continue with WeChat",
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    clientId: c.appId,
    clientSecret: c.appSecret,
    scope: "snsapi_login",
    authorizeClientIdParam: "appid",
    authorizeSuffix: "#wechat_redirect",
    pkce: false,
    addressless: true,
    tokenRequest: wechatToken,
    userinfo: wechatUserinfo,
    ...(c.redirectURI !== undefined ? { redirectURI: c.redirectURI } : {}),
  };
}

/** WeChat answers an error with status 200 and an `errcode`. Any `errcode` other than 0 throws. */
function refuseErrcode(body: Record<string, unknown>, what: string): void {
  if (body.errcode !== undefined && body.errcode !== 0)
    throw new Error(`${what} answered an errcode`);
}

/**
 * The token exchange: a GET with `appid`, `secret`, and `code` in the
 * query, as the docs give it. The URL holds the secret and the code, so no
 * throw names it, and core logs only the error class. The answer's
 * `openid`, and its `unionid` when present, go to `userinfo` in `extra`.
 */
export async function wechatToken(input: TokenRequestInput): Promise<TokenRequestAnswer> {
  const query = new URLSearchParams({
    appid: input.clientId,
    secret: input.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
  });
  const res = await input.fetch(`${TOKEN_URL}?${query.toString()}`, {
    headers: { accept: "application/json" },
  });
  const body = await answerObject(res, "wechat token");
  refuseErrcode(body, "wechat token");
  const unionid = stringClaim(body, "unionid");
  return {
    accessToken: requiredText(body, "access_token", "wechat token"),
    extra: {
      openid: requiredText(body, "openid", "wechat token"),
      ...(unionid !== null ? { unionid } : {}),
    },
  };
}

/**
 * The profile from `GET /sns/userinfo`. Its `openid` must equal the token
 * answer's, and a `unionid` of both answers must agree. The subject is the
 * `unionid`, else the `openid`, as Better Auth 1.7.2 keeps it. A `unionid`
 * names one person across the apps of one Open Platform account, and an
 * `openid` names the person in this app only. So the subject stays the same
 * when the app moves to another app id of the same account.
 */
export async function wechatUserinfo(
  accessToken: string,
  fetchFn: typeof fetch,
  extra: Record<string, string>,
): Promise<SocialProfile> {
  const openid = extra.openid;
  if (openid === undefined) throw new Error("wechat user info has no openid to ask for");
  const query = new URLSearchParams({ access_token: accessToken, openid });
  const res = await fetchFn(`${USERINFO_URL}?${query.toString()}`, {
    headers: { accept: "application/json" },
  });
  const body = await answerObject(res, "wechat user info");
  refuseErrcode(body, "wechat user info");
  if (requiredText(body, "openid", "wechat user info") !== openid)
    throw new Error("wechat user info names another openid");
  const unionid = stringClaim(body, "unionid");
  if (unionid !== null && extra.unionid !== undefined && unionid !== extra.unionid)
    throw new Error("wechat user info names another unionid");
  return {
    subject: unionid ?? extra.unionid ?? openid,
    email: null,
    emailVerified: false,
    name: stringClaim(body, "nickname"),
    image: stringClaim(body, "headimgurl"),
  };
}
