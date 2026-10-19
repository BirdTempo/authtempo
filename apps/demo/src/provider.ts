import type { OAuth2Entry, SocialProfile } from "@authtempo/core";
import { DEMO_IDENTITIES, type Identity, MAX_EMAIL } from "./identities.js";
import { page } from "./pages/layout.js";
import { PROVIDER_TITLE, providerBody } from "./pages/provider.js";

/**
 * The demo provider (plan 11b Task 9): a fake OAuth2 provider of the demo,
 * in the shape of examples/worker/src/test-provider.ts. It serves
 * /provider/authorize, /provider/token, and /provider/user of the sandbox.
 * Its codes live in the store of the sandbox, never in a module variable.
 * One isolate holds many sandboxes, and a code of one must not sign in to another.
 */
export { DEMO_IDENTITIES };
export const DEMO_PROVIDER = "demo";
const CLIENT_ID = "demo-provider-client";
/** The one fixed value of the demo. It guards nothing; the secret scan of Task 12 allows it by name. */
const CLIENT_SECRET = "demo-provider-secret-not-a-secret";
const ACCESS_PREFIX = "dat_";
const CODE_PREFIX = "dpc_";

/** The code table of a sandbox. create() of the sandbox runs it. */
export const PROVIDER_DDL =
  "CREATE TABLE demo_provider_code (code TEXT PRIMARY KEY, identity TEXT NOT NULL, challenge TEXT NOT NULL, redirect TEXT NOT NULL, spent INTEGER NOT NULL)";

/** The provider entry of the demo config. Its user call goes through the fetch that core passes. */
export function demoProvider(origin: string): OAuth2Entry {
  return {
    name: DEMO_PROVIDER,
    label: "Continue with the demo provider",
    authorizeUrl: `${origin}/provider/authorize`,
    tokenUrl: `${origin}/provider/token`,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scope: "profile email",
    async userinfo(accessToken, fetchFn): Promise<SocialProfile> {
      const res = await fetchFn(`${origin}/provider/user`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`demo provider user answered ${res.status}`);
      const u = (await res.json()) as Identity;
      return { subject: u.subject, email: u.email, emailVerified: true, name: u.name, image: null };
    },
  };
}

/**
 * The fetch of core's social calls. A call to the demo provider goes to the
 * provider of this sandbox, inside the Worker. Any other call answers 502:
 * the demo makes no network call.
 */
export function demoProviderFetch(origin: string, db: D1Database): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin && url.pathname.startsWith("/provider/"))
      return providerRoute(request, db);
    return new Response("the demo makes no network call", { status: 502 });
  };
}

/** The three routes of the demo provider in one sandbox. */
export async function providerRoute(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/provider/authorize") {
    const q = authorizeQuery(url);
    if (q === null) return text(400, "bad authorize request");
    if (request.method === "GET") return pickPage(url, db);
    if (request.method !== "POST") return text(405, "method not allowed");
    const form = new URLSearchParams(await request.text());
    const identity = pickIdentity(form);
    if (identity === null) return text(400, "pick a test identity");
    const code = `${CODE_PREFIX}${randomValue()}`;
    await db
      .prepare(
        "INSERT INTO demo_provider_code (code, identity, challenge, redirect, spent) VALUES (?, ?, ?, ?, 0)",
      )
      .bind(code, JSON.stringify(identity), q.challenge, q.redirect)
      .run();
    const back = new URL(q.redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.state);
    return new Response(null, { status: 302, headers: { location: back.href } });
  }
  if (url.pathname === "/provider/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    const code = form.get("code") ?? "";
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET)
      return invalidGrant();
    const row = await db
      .prepare("SELECT challenge, redirect, spent FROM demo_provider_code WHERE code = ?")
      .bind(code)
      .first<{ challenge: string; redirect: string; spent: number }>();
    if (row === null || row.spent !== 0) return invalidGrant();
    if (form.get("redirect_uri") !== row.redirect) return invalidGrant();
    if ((await s256(form.get("code_verifier") ?? "")) !== row.challenge) return invalidGrant();
    // A code is spent once. The condition on spent holds when two exchanges race.
    const spend = await db
      .prepare("UPDATE demo_provider_code SET spent = 1 WHERE code = ? AND spent = 0")
      .bind(code)
      .run();
    if (spend.meta.changes !== 1) return invalidGrant();
    return Response.json({ access_token: `${ACCESS_PREFIX}${code}`, token_type: "bearer" });
  }
  if (url.pathname === "/provider/user" && request.method === "GET") {
    const auth = request.headers.get("authorization") ?? "";
    const code = auth.startsWith(`Bearer ${ACCESS_PREFIX}`)
      ? auth.slice(`Bearer ${ACCESS_PREFIX}`.length)
      : "";
    const row = await db
      .prepare("SELECT identity FROM demo_provider_code WHERE code = ? AND spent = 1")
      .bind(code)
      .first<{ identity: string }>();
    if (row === null) return text(401, "unauthorized");
    return Response.json(JSON.parse(row.identity) as Identity);
  }
  return text(404, "not found");
}

/** The authorize query, held to the client, the callback of this origin, and PKCE S256. */
function authorizeQuery(url: URL): { redirect: string; state: string; challenge: string } | null {
  const p = url.searchParams;
  const redirect = p.get("redirect_uri") ?? "";
  const state = p.get("state") ?? "";
  const challenge = p.get("code_challenge") ?? "";
  // The callback of this origin only, so the provider sends no code to another site.
  if (redirect !== `${url.origin}/auth/social/${DEMO_PROVIDER}/callback`) return null;
  if (p.get("response_type") !== "code" || p.get("client_id") !== CLIENT_ID) return null;
  if (state === "" || challenge === "" || p.get("code_challenge_method") !== "S256") return null;
  return { redirect, state, challenge };
}

/** A fixed identity by its button, or a free address from the field. */
function pickIdentity(form: URLSearchParams): Identity | null {
  const pick = form.get("identity") ?? "";
  if (pick !== "free")
    return Object.hasOwn(DEMO_IDENTITIES, pick) ? (DEMO_IDENTITIES[pick] ?? null) : null;
  const email = (form.get("email") ?? "").trim().toLowerCase();
  if (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { subject: `demo-free-${email}`, email, name: email.split("@")[0] ?? email };
}

/** The pick page, in the layout of the demo pages. The reset time comes from the store of the sandbox. */
async function pickPage(url: URL, db: D1Database): Promise<Response> {
  const row = await db
    .prepare("SELECT value FROM demo_meta WHERE key = 'reset_at'")
    .first<{ value: string }>();
  return page({
    title: PROVIDER_TITLE,
    path: url.pathname,
    resetAt: Number(row?.value ?? 0),
    body: providerBody({
      action: `${url.pathname}${url.search}`,
      identities: DEMO_IDENTITIES,
      maxEmail: MAX_EMAIL,
    }),
    script: null,
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** The OAuth answer to a refused code (RFC 6749 section 5.2). */
function invalidGrant(): Response {
  return Response.json({ error: "invalid_grant" }, { status: 400 });
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}
