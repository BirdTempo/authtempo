import {
  type AuthConfig,
  createAuth,
  createMemoryAdapter,
  type MailMessage,
} from "@authtempo/core";
import { DEFAULT_COOKIE_NAME } from "@authtempo/core/credentials";

export const BASE = "https://api.example.com";
export const ISSUER = `${BASE}/auth`;
/** The audience of a session JWT: the files server. */
export const FILES = "https://files.example.com";
/** The OAuth resource: the MCP server. */
export const MCP = `${BASE}/mcp`;
export const REDIRECT = "http://127.0.0.1:8123/callback";
export const SECRET = "0123456789abcdef0123456789abcdef";

/** A clock that the test moves. */
export function makeClock(start = "2026-01-01T00:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(ms: number) {
      current = new Date(ms);
    },
  };
}

/**
 * A core instance on the memory adapter with JWT minting for FILES and the
 * provider for MCP, a clock that the test moves, and a fetch that counts each
 * path and can fail as an outage does. No test calls the network: the fetch
 * hands each request to `auth.handle`.
 */
export function makeServer(extra: Partial<AuthConfig> = {}) {
  const clock = makeClock();
  const mail: MailMessage[] = [];
  const storage = createMemoryAdapter();
  const auth = createAuth({
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    storage,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock,
    jwtMint: { audience: [FILES] },
    oauth: { resources: [MCP], registration: { cimd: false } },
    ...extra,
  });
  const counts = new Map<string, number>();
  const inits: (RequestInit | undefined)[] = [];
  let down: string | null = null;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inits.push(init);
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (down !== null && path.endsWith(down)) throw new TypeError("fetch failed");
    return auth.handle(req);
  }) as typeof globalThis.fetch;
  return {
    auth,
    storage,
    mail,
    clock,
    fetch,
    /** The init of every fetch, in order. */
    inits,
    count: (path: string) => counts.get(path) ?? 0,
    /** Every fetch whose path ends with `suffix` rejects, as in an outage. Null ends it. */
    outage(suffix: string | null) {
      down = suffix;
    },
  };
}

export type Server = ReturnType<typeof makeServer>;

/** A person signed in by magic link: the session token and its cookie. */
export async function signedIn(server: Server, email = "ada@example.com") {
  const r = await server.auth.api.requestMagicLink({ email, ip: null });
  if (!r.ok) throw new Error(r.code);
  const token = /token=([A-Za-z0-9_-]+)/.exec(server.mail.at(-1)?.text ?? "")?.[1] ?? "";
  const v = await server.auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!v.ok) throw new Error(v.code);
  // No second factor is on in this harness, so the sign-in opens a session.
  if ("twoFactor" in v.value) throw new Error("a second factor challenge");
  return {
    user: v.value.user,
    sessionToken: v.value.token,
    cookie: `${DEFAULT_COOKIE_NAME}=${v.value.token}`,
  };
}

/** A session JWT of GET /token for a session token. */
export async function sessionJwt(server: Server, sessionToken: string): Promise<string> {
  const res = await server.auth.handle(
    new Request(`${ISSUER}/token`, { headers: { authorization: `Bearer ${sessionToken}` } }),
  );
  if (res.status !== 200) throw new Error(`GET /token answered ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function s256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An access token for MCP through the real provider flow: register, consent, exchange. */
export async function accessToken(
  server: Server,
  cookie: string,
  scope = "openid",
): Promise<string> {
  const post = (path: string, headers: Record<string, string>, body: string) =>
    server.auth.handle(new Request(`${ISSUER}${path}`, { method: "POST", headers, body }));
  const reg = await post(
    "/oauth/register",
    { "content-type": "application/json" },
    JSON.stringify({ client_name: "Agent", redirect_uris: [REDIRECT] }),
  );
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = "v".repeat(43);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    scope,
    resource: MCP,
    state: "st",
  });
  const page = await server.auth.handle(
    new Request(`${ISSUER}/oauth/authorize?${query}`, { headers: { cookie } }),
  );
  const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
  const allowed = await post(
    "/oauth/authorize",
    { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie },
    new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
  );
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const tokens = await post(
    "/oauth/token",
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: MCP,
    }).toString(),
  );
  if (tokens.status !== 200) throw new Error(`token answered ${tokens.status}`);
  return ((await tokens.json()) as { access_token: string }).access_token;
}

/** A request to a resource server with a bearer. */
export function withBearer(url: string, bearer: string): Request {
  return new Request(url, { headers: { authorization: `Bearer ${bearer}` } });
}

/** The `exp` of a JWT, in seconds. The test reads it to stand the clock at the edge. */
export function expOf(token: string): number {
  const part = token.split(".")[1] ?? "";
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return (JSON.parse(json) as { exp: number }).exp;
}
