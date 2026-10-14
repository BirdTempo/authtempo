import { OAUTH_ERRORS, type OAuthErrorCode } from "@authtempo/core/errors";
import type { OAuthResult } from "../result.js";
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
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
}

/** The issuer: an absolute http or https URL with no query, fragment, or trailing slash. Throws otherwise. */
function checkedIssuer(issuer: string): string {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    throw new Error("authtempo oauth: issuer must be an absolute URL");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.search || u.hash)
    throw new Error("authtempo oauth: issuer must be an http or https URL with no query");
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
  const tokens = (a: TokenAnswer): OAuthTokens => ({
    accessToken: a.access_token,
    tokenType: "Bearer",
    expiresAt: new Date(now() + a.expires_in * 1000),
    scopes: a.scope.split(" ").filter((s) => s.length > 0),
    refreshToken: a.refresh_token ?? null,
    idToken: a.id_token ?? null,
  });
  const tokenCall = async (form: Record<string, string>): Promise<OAuthResult<OAuthTokens>> => {
    const r = await oauthRequest<TokenAnswer>(doFetch, oauthURL(issuer, "oauthClient.token"), {
      method: "POST",
      form,
    });
    return r.ok ? { ok: true, value: tokens(r.value) } : r;
  };
  const mismatch = { ok: false, code: "redirect_mismatch", status: 0 } as const;
  return {
    async authorizeURL() {
      try {
        const { verifier, challenge } = await makePkce(c);
        const state = base64Url(c.randomBytes(32));
        await pending.put({ state, verifier, createdAt: now() });
        const query = new URLSearchParams({
          response_type: "code",
          client_id: options.clientId,
          redirect_uri: options.redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: options.scopes.join(" "),
          resource: options.resource,
          state,
        });
        return { ok: true, value: `${oauthURL(issuer, "oauthClient.authorize")}?${query}` };
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
      if (error !== undefined)
        return Object.hasOwn(OAUTH_ERRORS, error)
          ? { ok: false, code: error as OAuthErrorCode, status: 0 }
          : { ok: false, code: "unexpected", status: 0 };
      if (!code) return { ok: false, code: "unexpected", status: 0 };
      return tokenCall({
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        resource: options.resource,
      });
    },
    refresh(refreshToken, input = {}) {
      return tokenCall({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: options.clientId,
        resource: options.resource,
        ...(input.scopes !== undefined ? { scope: input.scopes.join(" ") } : {}),
      });
    },
    async revoke(token) {
      const r = await oauthRequest<unknown>(doFetch, oauthURL(issuer, "oauthClient.revoke"), {
        method: "POST",
        form: { token, client_id: options.clientId },
      });
      return r.ok ? { ok: true, value: { revoked: true } } : r;
    },
    userinfo(accessToken) {
      return oauthRequest<Record<string, unknown>>(
        doFetch,
        oauthURL(issuer, "oauthClient.userinfo"),
        { method: "GET", bearer: accessToken },
      );
    },
  };
}

/**
 * Registers a client (RFC 7591, `POST /oauth/register`), for a native app or
 * a CLI that registers itself at its first run. The register endpoint has no
 * CORS for a foreign origin, so a single-page app is registered by its owner.
 */
export async function registerOAuthClient(input: {
  issuer: string;
  clientName: string;
  redirectUris: readonly string[];
  fetch?: typeof fetch | undefined;
}): Promise<OAuthResult<{ clientId: string; redirectUris: string[] }>> {
  const issuer = checkedIssuer(input.issuer);
  const r = await oauthRequest<{ client_id: string; redirect_uris: string[] }>(
    input.fetch ?? globalThis.fetch,
    oauthURL(issuer, "oauthClient.register"),
    {
      method: "POST",
      json: { client_name: input.clientName, redirect_uris: [...input.redirectUris] },
    },
  );
  return r.ok
    ? { ok: true, value: { clientId: r.value.client_id, redirectUris: r.value.redirect_uris } }
    : r;
}
