import type { OAuth2Entry, SocialProfile } from "@tempo-auth/core";

/**
 * TEST_MODE only (plan 9c): a fake OAuth2 provider served by this Worker
 * under /__test/oauth/, so the end-to-end test runs the full flow on D1 with
 * no network. A deploy has TEST_MODE "0": then neither the provider nor the
 * routes exist.
 */
export const TEST_PROVIDER = "example-oauth";
export const TEST_ACCESS_TOKEN = "eat_example_access_token_0001";
const PREFIX = "/__test/oauth";
const CLIENT_SECRET = "example-oauth-secret";

export function testProvider(base: string): OAuth2Entry {
  return {
    name: TEST_PROVIDER,
    label: "Continue with Example",
    authorizeUrl: `${base}${PREFIX}/authorize`,
    tokenUrl: `${base}${PREFIX}/token`,
    clientId: "example-oauth-client",
    clientSecret: CLIENT_SECRET,
    scope: "profile email",
    async userinfo(accessToken, fetchFn): Promise<SocialProfile> {
      const res = await fetchFn(`${base}${PREFIX}/user`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`user info answered ${res.status}`);
      const u = (await res.json()) as {
        id: string;
        email: string;
        verified: boolean;
        name: string;
      };
      return {
        subject: u.id,
        email: u.email,
        emailVerified: u.verified === true,
        name: u.name,
        image: null,
      };
    },
  };
}

/**
 * The provider's three endpoints. The code carries the PKCE challenge, so
 * the token endpoint checks the verifier as a real provider does. A wrong
 * code gets GitHub's answer shape: 200 with an `error` field.
 */
export async function testProviderRoute(request: Request, url: URL): Promise<Response> {
  if (url.pathname === `${PREFIX}/authorize`) {
    const redirect = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    if (
      !redirect ||
      !state ||
      !challenge ||
      url.searchParams.get("code_challenge_method") !== "S256"
    )
      return new Response("bad authorize request", { status: 400 });
    const back = new URL(redirect);
    back.searchParams.set("code", `ec_${challenge}`);
    back.searchParams.set("state", state);
    return Response.redirect(back.href, 302);
  }
  if (url.pathname === `${PREFIX}/token` && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    const verifier = form.get("code_verifier") ?? "";
    if (
      form.get("client_secret") !== CLIENT_SECRET ||
      form.get("code") !== `ec_${await s256(verifier)}`
    )
      return Response.json({ error: "bad_verification_code" });
    return Response.json({ access_token: TEST_ACCESS_TOKEN, token_type: "bearer" });
  }
  if (url.pathname === `${PREFIX}/user`) {
    if (request.headers.get("authorization") !== `Bearer ${TEST_ACCESS_TOKEN}`)
      return new Response("unauthorized", { status: 401 });
    return Response.json({
      id: "ex-1001",
      email: "oauth-person@example.com",
      verified: true,
      name: "Example Person",
    });
  }
  return new Response("not found", { status: 404 });
}

/** Core's provider fetch in TEST_MODE: a call to the fake provider stays in this isolate. */
export function testProviderFetch(base: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === base && url.pathname.startsWith(`${PREFIX}/`))
      return testProviderRoute(request, url);
    return fetch(request);
  };
}

async function s256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
