import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const BASE = "https://example.test";
// The value of TEST_ACCESS_TOKEN in src/test-provider.ts.
const ACCESS = "eat_example_access_token_0001";
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
