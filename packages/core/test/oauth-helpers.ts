import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createSession } from "../src/engine/sessions.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { randomBase64Url, sha256Base64Url } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post } from "./helpers.js";

export const RESOURCE = `${BASE_URL}/mcp`;
export const OTHER_RESOURCE = `${BASE_URL}/files`;
export const REDIRECT = "https://client.example.com/callback";
export const ISSUER = `${BASE_URL}/auth`;
export const SCOPES = { "mcp:read": "Read your documents", "mcp:write": "Change your documents" };

/**
 * The engine view and the routes of one config input, on one storage, one
 * clock, and one limiter. CIMD is off, so no fetch is needed; a test that
 * needs it passes its own `oauth`.
 */
export function oauthHandle(extra: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    oauth: {
      resources: [RESOURCE, OTHER_RESOURCE],
      scopes: SCOPES,
      // dynamic is off by default since plan 12e
      registration: { cimd: false, dynamic: true },
    },
    ...extra,
  };
  return {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: base.storage,
    clock: base.clock,
  };
}

export type Handle = ReturnType<typeof oauthHandle>;

/** A user with a name and a picture, and the cookie of a session. */
export async function signedIn(h: Handle, email = "ada@example.com", verified = true) {
  const now = h.clock.now();
  const user = await h.storage.create("user", {
    id: newId(now),
    email,
    emailVerified: verified,
    name: "Ada Lovelace",
    image: "https://img.example.com/ada.png",
    createdAt: now,
    updatedAt: now,
  });
  const { token, session } = await createSession(h.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
  });
  return { user, session, token, cookie: `__Host-tempo_session=${token}` };
}

/** A client registered through the route. Answers its client id. */
export async function registered(
  h: Handle,
  redirectUris: string[] = [REDIRECT],
  name = "Test MCP client",
): Promise<string> {
  const res = await h.auth.handle(
    post("/auth/oauth/register", { redirect_uris: redirectUris, client_name: name }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** A confidential client registered through the route (plan 12e). Answers its id and its secret. */
export async function confidential(
  h: Handle,
  method: "client_secret_basic" | "client_secret_post",
  redirectUris: string[] = [REDIRECT],
): Promise<{ clientId: string; secret: string }> {
  const res = await h.auth.handle(
    post("/auth/oauth/register", {
      redirect_uris: redirectUris,
      client_name: "Secret client",
      token_endpoint_auth_method: method,
    }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  const body = (await res.json()) as { client_id: string; client_secret?: string };
  if (!body.client_secret) throw new Error("register answered no client_secret");
  return { clientId: body.client_id, secret: body.client_secret };
}

/** The form encoding of one value (application/x-www-form-urlencoded). */
const formEncoded = (value: string) => new URLSearchParams([["v", value]]).toString().slice(2);

/** RFC 6749 section 2.3.1: Basic of the form-encoded id and secret. */
export function basicHeader(id: string, secret: string): string {
  return `Basic ${btoa(`${formEncoded(id)}:${formEncoded(secret)}`)}`;
}

export async function pkce() {
  const verifier = randomBase64Url(32);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

export interface AuthorizeInput {
  clientId: string;
  /** Null sends no `code_challenge`: a confidential client may omit it with `openid` and `nonce` (plan 12e). */
  challenge: string | null;
  scope?: string;
  resource?: string;
  state?: string;
  nonce?: string;
  redirectUri?: string;
  prompt?: string;
  method?: string;
}

export function authorizeParams(i: AuthorizeInput): Record<string, string> {
  return {
    response_type: "code",
    client_id: i.clientId,
    redirect_uri: i.redirectUri ?? REDIRECT,
    ...(i.challenge !== null ? { code_challenge: i.challenge } : {}),
    ...(i.challenge !== null || i.method !== undefined
      ? { code_challenge_method: i.method ?? "S256" }
      : {}),
    scope: i.scope ?? "mcp:read offline_access",
    resource: i.resource ?? RESOURCE,
    state: i.state ?? "st-1",
    ...(i.nonce !== undefined ? { nonce: i.nonce } : {}),
    ...(i.prompt !== undefined ? { prompt: i.prompt } : {}),
  };
}

export function authorizeGet(i: AuthorizeInput, cookie?: string): Request {
  const query = new URLSearchParams(authorizeParams(i)).toString();
  return new Request(`${BASE_URL}/auth/oauth/authorize?${query}`, {
    headers: cookie ? { cookie } : {},
  });
}

/** The consent form as the page posts it: same origin, form encoded. */
export function consentPost(
  body: Record<string, string>,
  headers: Record<string, string>,
): Request {
  return new Request(`${BASE_URL}/auth/oauth/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
  });
}

/** The short id of the held request that a consent page carries (plan 9h). */
export function requestIdOf(html: string): string {
  const m = /<input type="hidden" name="request_id" value="(oq_[A-Za-z0-9_-]{43})">/.exec(html);
  if (!m?.[1]) throw new Error("no held request on the page");
  return m[1];
}

/** The consent page of `i` for the session `cookie`, and the short id it carries. */
export async function consentPage(h: Handle, cookie: string, i: AuthorizeInput) {
  const page = await h.auth.handle(authorizeGet(i, cookie));
  if (page.status !== 200)
    throw new Error(`authorize answered ${page.status}, not the consent page`);
  const html = await page.text();
  return { page, html, requestId: requestIdOf(html) };
}

/** A token request as a native client sends it: form encoded, no Origin. */
export function tokenPost(
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE_URL}/auth/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

/** The authorize step, and the allow when the consent page shows. Answers the code and the redirect it rode on. */
export async function authorized(h: Handle, cookie: string, i: AuthorizeInput) {
  const page = await h.auth.handle(authorizeGet(i, cookie));
  let location = page.headers.get("location");
  if (page.status === 200) {
    // The form posts the held request's short id, not the request (plan 9h).
    const done = await h.auth.handle(
      consentPost({ request_id: requestIdOf(await page.text()), decision: "allow" }, { cookie }),
    );
    location = done.headers.get("location");
  }
  if (!location) throw new Error(`authorize answered ${page.status} with no redirect`);
  const url = new URL(location);
  const code = url.searchParams.get("code");
  if (!code) throw new Error(`no code in ${location}`);
  return { code, url };
}

/** One signed-in user, one registered client, and a code for `scope`. */
export async function codeFor(
  h: Handle,
  scope = "mcp:read offline_access",
  extra: Partial<AuthorizeInput> = {},
) {
  const s = await signedIn(h);
  const clientId = await registered(h);
  const p = await pkce();
  const { code } = await authorized(h, s.cookie, {
    clientId,
    challenge: p.challenge,
    scope,
    ...extra,
  });
  return { ...s, clientId, verifier: p.verifier, code };
}

export function exchange(
  code: string,
  clientId: string,
  verifier: string,
  extra: Record<string, string> = {},
): Request {
  return tokenPost({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
    ...extra,
  });
}

/**
 * A device grant of `clientId` that the session of `cookie` approves,
 * through the routes (plan 12e Task 14). The client holds the device grant.
 * Answers the device code.
 */
export async function approvedDevice(
  h: Handle,
  clientId: string,
  cookie: string,
  scope = "mcp:read",
): Promise<string> {
  const formPost = (path: string, body: Record<string, string>, headers = {}) =>
    new Request(`${BASE_URL}/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    });
  const started = await h.auth.handle(
    formPost("/oauth/device_authorization", { client_id: clientId, scope, resource: RESOURCE }),
  );
  if (started.status !== 200) throw new Error(`device_authorization answered ${started.status}`);
  const { device_code, user_code } = (await started.json()) as {
    device_code: string;
    user_code: string;
  };
  const done = await h.auth.handle(
    formPost("/oauth/device", { user_code, decision: "allow" }, { cookie, origin: BASE_URL }),
  );
  if (!(await done.text()).includes("The device is connected.")) throw new Error("no approval");
  return device_code;
}
