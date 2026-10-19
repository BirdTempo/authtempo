import { OAUTH_ERRORS, type OAuthErrorCode } from "@authtempo/core/errors";
import type { OAuthResult } from "../result.js";
import { searchOf } from "../transport.js";
import { oauthURL } from "./calls.js";
import { memoryPendingStore, PENDING_TTL_MS, type PendingStore } from "./pending.js";
import { base64Url, makePkce, type PkceCrypto, webCrypto } from "./pkce.js";
import { parseReturnedUrl } from "./returned-url.js";
import { oauthRequest } from "./transport.js";

export interface OAuthClientOptions {
  /** `baseURL + basePath` of the provider, the `iss` of its tokens, such as `https://api.example.com/auth`. */
  issuer: string;
  /** A `cl_` id from `registerOAuthClient`, or the URL of the client's metadata document. */
  clientId: string;
  /** One of the client's registered redirect URIs, exactly. */
  redirectUri: string;
  /** The resource the access token is for: one of the provider's `oauth.resources`. */
  resource: string;
  /** At least one scope. `offline_access` asks for a refresh token. */
  scopes: readonly string[];
  fetch?: typeof fetch | undefined;
  /** The PKCE seam. Default Web Crypto. Hermes needs `expoCrypto` of `@authtempo/handoff/expo`. */
  crypto?: PkceCrypto | undefined;
  /** Where a sign-in waits for its redirect. Default memory; a single-page app passes `browserPendingStore()`. */
  pending?: PendingStore | undefined;
  /** Tests inject a clock. */
  clock?: { now(): Date } | undefined;
}

export interface OAuthTokens {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: Date;
  scopes: string[];
  /** Present when the scopes hold `offline_access`. */
  refreshToken: string | null;
  /** Present when the scopes hold `openid`. This client does not verify it. */
  idToken: string | null;
}

export interface OAuthClient {
  /** A new PKCE pair and `state`, kept in the pending store, and the authorize URL to open. */
  authorizeURL(): Promise<OAuthResult<string>>;
  /** The URL the redirect brought back: checks `state` and `iss`, then exchanges the code. */
  handleRedirect(url: string): Promise<OAuthResult<OAuthTokens>>;
  /** A new access token and a new refresh token. `scopes` narrows the grant. */
  refresh(
    refreshToken: string,
    input?: { scopes?: readonly string[] | undefined },
  ): Promise<OAuthResult<OAuthTokens>>;
  /** Ends a refresh token's grant. An access token cannot be revoked; it lives to its `exp`. */
  revoke(token: string): Promise<OAuthResult<{ revoked: true }>>;
  /** The claims of an access token with `openid`, by scope. */
  userinfo(accessToken: string): Promise<OAuthResult<Record<string, unknown>>>;
}

interface TokenAnswer {
  access_token: string;
  expires_in: number;
  scope: string | undefined;
  refresh_token: string | undefined;
  id_token: string | undefined;
}

/**
 * The largest `expires_in` in seconds. A Date ends at 8.64e15 ms, and a
 * safe integer such as 1e13 seconds is past it, which gives an Invalid Date.
 * 1e12 seconds (about 31,700 years) from any clock of this era stays in range.
 */
const EXPIRES_IN_MAX = 1e12;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const optionalString = (v: unknown): v is string | undefined =>
  v === undefined || typeof v === "string";

/**
 * The token answer, checked at run time (RFC 6749 section 5.1): a non-empty
 * `access_token`, a `token_type` of Bearer in any case, a positive safe
 * integer `expires_in` up to `EXPIRES_IN_MAX` (so the expiry is a valid date), and string `scope`, `refresh_token`, and `id_token` when
 * present. Null for any other shape, which the caller answers as `unexpected`.
 */
function tokenAnswer(v: unknown): TokenAnswer | null {
  if (!isObject(v)) return null;
  const { access_token, token_type, expires_in, scope, refresh_token, id_token } = v;
  if (typeof access_token !== "string" || access_token === "") return null;
  if (typeof token_type !== "string" || token_type.toLowerCase() !== "bearer") return null;
  if (
    typeof expires_in !== "number" ||
    !Number.isSafeInteger(expires_in) ||
    expires_in <= 0 ||
    expires_in > EXPIRES_IN_MAX
  )
    return null;
  if (!optionalString(scope) || !optionalString(refresh_token) || !optionalString(id_token))
    return null;
  return { access_token, expires_in, scope, refresh_token, id_token };
}

/** The register answer: a non-empty `client_id` and `redirect_uris` of strings. */
function registerAnswer(v: unknown): { clientId: string; redirectUris: string[] } | null {
  if (!isObject(v)) return null;
  const { client_id, redirect_uris } = v;
  if (typeof client_id !== "string" || client_id === "") return null;
  if (!Array.isArray(redirect_uris) || !redirect_uris.every((u) => typeof u === "string"))
    return null;
  return { clientId: client_id, redirectUris: redirect_uris };
}

/** The userinfo answer: a plain object with a string `sub` (OIDC Core 5.3.2). */
function userinfoAnswer(v: unknown): Record<string, unknown> | null {
  return isObject(v) && typeof v.sub === "string" ? v : null;
}

/**
 * The issuer: an absolute http or https URL with no user info, query,
 * fragment, or trailing slash. Throws otherwise. http is accepted for any
 * host, as core accepts an http `baseURL`; use it for a loopback host in
 * development only.
 */
function checkedIssuer(issuer: string): string {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    throw new Error("authtempo oauth: issuer must be an absolute URL");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.search || u.hash)
    throw new Error("authtempo oauth: issuer must be an http or https URL with no query");
  if (u.username || u.password) throw new Error("authtempo oauth: issuer must have no user info");
  return issuer.replace(/\/$/, "");
}

/**
 * The OAuth client of a third-party app (plan 11d, spec 20): a native app, a
 * CLI with a loopback redirect, the server side of a web app, or a
 * single-page app on its own registered origin. Every answer is an
 * `OAuthResult`; nothing throws for an answer. A wrong config throws here.
 */
export function createOAuthClient(options: OAuthClientOptions): OAuthClient {
  const issuer = checkedIssuer(options.issuer);
  if (options.scopes.length === 0) throw new Error("authtempo oauth: scopes must not be empty");
  if (options.redirectUri === "") throw new Error("authtempo oauth: redirectUri is required");
  const doFetch = options.fetch ?? globalThis.fetch;
  const c = options.crypto ?? webCrypto();
  const pending = options.pending ?? memoryPendingStore();
  const now = () => (options.clock ?? { now: () => new Date() }).now().getTime();
  /** `asked`: the scopes of the request. RFC 6749 section 5.1: an answer with no `scope` grants them. */
  const tokens = (a: TokenAnswer, asked: readonly string[]): OAuthTokens => ({
    accessToken: a.access_token,
    tokenType: "Bearer",
    expiresAt: new Date(now() + a.expires_in * 1000),
    scopes: a.scope === undefined ? [...asked] : a.scope.split(" ").filter((s) => s.length > 0),
    refreshToken: a.refresh_token ?? null,
    idToken: a.id_token ?? null,
  });
  const tokenCall = async (
    form: Record<string, string>,
    asked: readonly string[],
  ): Promise<OAuthResult<OAuthTokens>> => {
    const r = await oauthRequest(
      doFetch,
      oauthURL(issuer, "oauthClient.token"),
      { method: "POST", form },
      tokenAnswer,
    );
    return r.ok ? { ok: true, value: tokens(r.value, asked) } : r;
  };
  const mismatch = { ok: false, code: "redirect_mismatch", status: 0 } as const;
  return {
    async authorizeURL() {
      try {
        const { verifier, challenge } = await makePkce(c);
        const state = base64Url(c.randomBytes(32));
        await pending.put({
          state,
          verifier,
          issuer,
          clientId: options.clientId,
          createdAt: now(),
        });
        // searchOf writes a space as %20, as every other URL of the client.
        const query = searchOf({
          response_type: "code",
          client_id: options.clientId,
          redirect_uri: options.redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: options.scopes.join(" "),
          resource: options.resource,
          state,
        });
        return { ok: true, value: `${oauthURL(issuer, "oauthClient.authorize")}${query}` };
      } catch {
        // The crypto seam or the pending store threw.
        return { ok: false, code: "unexpected", status: 0 };
      }
    },
    async handleRedirect(url) {
      const parsed = parseReturnedUrl(options.redirectUri, url);
      if (!parsed.ok) return mismatch;
      const { state, iss, error, code } = parsed.params;
      // RFC 9207: core sends iss on every redirect; another value is a mix-up. It is
      // checked before the take, so a forged redirect does not spend the real sign-in.
      if (iss !== issuer) return mismatch;
      let p: Awaited<ReturnType<PendingStore["take"]>>;
      try {
        p = state ? await pending.take(state) : null;
      } catch {
        return { ok: false, code: "unexpected", status: 0 };
      }
      if (!p || now() - p.createdAt > PENDING_TTL_MS) return mismatch;
      // Another client on a shared store started this sign-in (RFC 9207 section 2.4).
      if (p.issuer !== issuer || p.clientId !== options.clientId) return mismatch;
      if (error !== undefined)
        return Object.hasOwn(OAUTH_ERRORS, error)
          ? { ok: false, code: error as OAuthErrorCode, status: 0 }
          : { ok: false, code: "unexpected", status: 0 };
      if (!code) return { ok: false, code: "unexpected", status: 0 };
      return tokenCall(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: p.verifier,
          client_id: options.clientId,
          redirect_uri: options.redirectUri,
          resource: options.resource,
        },
        options.scopes,
      );
    },
    refresh(refreshToken, input = {}) {
      // An empty list sends no scope, so the grant keeps its scopes.
      const narrow = input.scopes !== undefined && input.scopes.length > 0 ? input.scopes : null;
      return tokenCall(
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: options.clientId,
          resource: options.resource,
          ...(narrow ? { scope: narrow.join(" ") } : {}),
        },
        narrow ?? options.scopes,
      );
    },
    async revoke(token) {
      // RFC 7009 section 2.2: any 2xx is a revoke, with or without a body.
      return oauthRequest(
        doFetch,
        oauthURL(issuer, "oauthClient.revoke"),
        { method: "POST", form: { token, client_id: options.clientId }, bodyless: true },
        () => ({ revoked: true }) as const,
      );
    },
    userinfo(accessToken) {
      return oauthRequest(
        doFetch,
        oauthURL(issuer, "oauthClient.userinfo"),
        { method: "GET", bearer: accessToken },
        userinfoAnswer,
      );
    },
  };
}

/**
 * Registers a client (RFC 7591, `POST /oauth/register`), for a native app or
 * a CLI that registers itself at its first run. The register endpoint has no
 * CORS for a foreign origin, so a single-page app is registered by its owner.
 * `initialAccessToken` goes as `Authorization: Bearer <token>` when the
 * server sets `oauth.registration.initialAccessTokenHash` (plan 12e). No log
 * and no answer of this call holds the token.
 */
export async function registerOAuthClient(input: {
  issuer: string;
  clientName: string;
  redirectUris: readonly string[];
  initialAccessToken?: string | undefined;
  fetch?: typeof fetch | undefined;
}): Promise<OAuthResult<{ clientId: string; redirectUris: string[] }>> {
  const issuer = checkedIssuer(input.issuer);
  return oauthRequest(
    input.fetch ?? globalThis.fetch,
    oauthURL(issuer, "oauthClient.register"),
    {
      method: "POST",
      json: { client_name: input.clientName, redirect_uris: [...input.redirectUris] },
      bearer: input.initialAccessToken,
    },
    registerAnswer,
  );
}
