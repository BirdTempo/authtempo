import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { TEST_ACCESS_TOKEN, TEST_CLIENT_SECRET } from "../src/test-provider.js";

const BASE = "https://example.test";
const ACCESS = TEST_ACCESS_TOKEN;
// An IP of its own, so the social start limit that other e2e files use does not count here.
const IP = { "cf-connecting-ip": "203.0.113.90" };

it("signs in through an oauth2 provider end to end on D1, refuses a replay, and stores no access token (plan 9c)", async () => {
  const start = await SELF.fetch(`${BASE}/auth/social/example-oauth/start?next=%2Fme`, {
    redirect: "manual",
    headers: IP,
  });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.origin + authorize.pathname).toBe(`${BASE}/__test/oauth/authorize`);
  expect(authorize.searchParams.has("nonce")).toBe(false);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const bind = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(bind).toMatch(/^tempo_session_oauth=/);

  // The provider's authorize step sends the browser back with a code bound to the challenge.
  const back = await SELF.fetch(authorize.href, { redirect: "manual" });
  expect(back.status).toBe(302);
  const callback = new URL(back.headers.get("location") ?? "");
  expect(callback.pathname).toBe("/auth/social/example-oauth/callback");

  const done = await SELF.fetch(callback.href, {
    redirect: "manual",
    headers: { cookie: bind, ...IP },
  });
  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toBe(`${BASE}/me`);
  const session =
    done.headers
      .getSetCookie()
      .find((c) => c.startsWith("tempo_session=ts_"))
      ?.split(";")[0] ?? "";
  expect(session).not.toBe("");
  const me = await SELF.fetch(`${BASE}/me`, { headers: { cookie: session } });
  expect(await me.json()).toMatchObject({ email: "oauth-person@example.com" });
  const identity = await env.DB.prepare("SELECT subject FROM ta_identity WHERE provider = ?")
    .bind("example-oauth")
    .first<{ subject: string }>();
  expect(identity?.subject).toBe("ex-1001");

  // The state row is spent: the same callback again answers invalid_token.
  const again = await SELF.fetch(callback.href, {
    redirect: "manual",
    headers: { cookie: bind, ...IP },
  });
  expect(again.headers.get("location")).toBe(`${BASE}/?auth_error=invalid_token`);

  // No core table holds the access token.
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta_%'",
  ).all<{ name: string }>();
  expect(tables.results.length).toBeGreaterThan(0);
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    expect(JSON.stringify(rows.results)).not.toContain(ACCESS);
  }
});

async function challengeOf(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function tokenRequest(code: string, verifier: string): Promise<Response> {
  return SELF.fetch(`${BASE}/__test/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_secret: TEST_CLIENT_SECRET,
    }),
  });
}

it("the fake token endpoint refuses a wrong code_verifier (PKCE)", async () => {
  const code = `ec_${await challengeOf("verifier-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}`;
  const res = await tokenRequest(code, "a-different-verifier-bbbbbbbbbbbbbbbbbbbbbbbbbb");
  expect(await res.json()).toEqual({ error: "bad_verification_code" });
});

it("the fake token endpoint spends a code once", async () => {
  // Random per run: the spent set lives as long as the isolate, so a fixed verifier would fail a second run in it.
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const code = `ec_${await challengeOf(verifier)}`;
  const first = await tokenRequest(code, verifier);
  expect(await first.json()).toMatchObject({ access_token: TEST_ACCESS_TOKEN });
  const second = await tokenRequest(code, verifier);
  expect(await second.json()).toEqual({ error: "bad_verification_code" });
});
