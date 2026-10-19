// A deployment that answers as core does, as a fetch for runChecks (plan 11c).
// check.test.ts and check-schema.test.ts share it (plan 11c2 Task 7).

export const BASE = "https://api.example.com";
export const COOKIE = "__Host-tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
export type Route = (init: RequestInit) => Response;

export const signedOut = (cookie: string | null) =>
  new Response('{"ok":true}', {
    status: 200,
    headers: [
      ["content-type", "application/json"],
      ...(cookie === null ? [] : [["set-cookie", cookie] as [string, string]]),
    ],
  });
/** Core's sign-out: 403 for a foreign Origin, else 200 with the clear cookie. */
export const signOut =
  (cookie: string | null): Route =>
  (init) =>
    new Headers(init.headers).has("origin")
      ? Response.json({ error: "origin_not_trusted" }, { status: 403 })
      : signedOut(cookie);
export const keySet = (keys: unknown[], cache: string | null = "public, max-age=300") =>
  Response.json({ keys }, { headers: cache === null ? {} : { "cache-control": cache } });
export const KEY = { kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "K1", alg: "EdDSA", use: "sig" };
export const doc =
  (issuer = `${BASE}/auth`, jwks = `${BASE}/auth/jwks`) =>
  () =>
    Response.json({ issuer, jwks_uri: jwks });

/** A deployment that answers as core does, route by route. */
export function healthy(): Map<string, Route> {
  return new Map<string, Route>([
    ["GET /auth/session", () => Response.json({ error: "unauthorized" }, { status: 401 })],
    ["POST /auth/sign-out", signOut(COOKIE)],
    ["GET /auth/jwks", () => keySet([KEY])],
    ["GET /.well-known/openid-configuration", doc()],
    ["GET /.well-known/oauth-authorization-server", doc()],
  ]);
}
export const deployment = (routes: Map<string, Route>) => async (url: string, init: RequestInit) =>
  routes.get(`${init.method ?? "GET"} ${new URL(url).pathname}`)?.(init) ??
  Response.json({ error: "not_found" }, { status: 404 });
