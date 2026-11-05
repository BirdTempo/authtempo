import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const BASE = "https://example.test";
const EMAIL = "script-owner@example.com";
const PASSWORD = "correct horse battery";
// An IP of its own, so the sign-up limit that other e2e files use does not count here.
const IP = { "cf-connecting-ip": "203.0.113.80" };
const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE, ...IP, ...extra },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
async function lastLink(): Promise<string> {
  return ((await (await SELF.fetch(`${BASE}/__test/last-link`)).json()) as { link: string }).link;
}

it("creates a token with a session, calls with it, revokes it, and sees 401 on D1", async () => {
  const up = await SELF.fetch(
    `${BASE}/auth/password/sign-up`,
    json({ email: EMAIL, password: PASSWORD }),
  );
  expect(up.status).toBe(200);
  // The browser of the sign-up holds its proof, so the password stays (ruling 11 of plan 12q).
  const proof = /__Host-tempo_signup=[^;]+/.exec(up.headers.get("set-cookie") ?? "")?.[0] ?? "";
  const verifyToken = new URL(await lastLink()).searchParams.get("token") ?? "";
  const verified = await SELF.fetch(
    `${BASE}/auth/password/verify`,
    json({ token: verifyToken }, { cookie: proof }),
  );
  expect(await verified.json()).toEqual({ verified: true, passwordKept: true });
  const signIn = await SELF.fetch(
    `${BASE}/auth/password/sign-in`,
    json({ email: EMAIL, password: PASSWORD }),
  );
  const { token: session } = (await signIn.json()) as { token: string };

  const created = await SELF.fetch(
    `${BASE}/auth/tokens`,
    json({ name: "deploy script" }, { authorization: `Bearer ${session}` }),
  );
  expect(created.status).toBe(200);
  const { token, apiToken } = (await created.json()) as {
    token: string;
    apiToken: { id: string; hint: string };
  };
  expect(token).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
  expect(apiToken.hint).toBe(token.slice(3, 11));
  // D1 holds the hash, never the token, and the default expiry.
  const row = await env.DB.prepare("SELECT token_hash, expires_at FROM ta_api_token WHERE id = ?")
    .bind(apiToken.id)
    .first<{ token_hash: string; expires_at: number | null }>();
  expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row?.expires_at).toBeTypeOf("number");

  const current = await SELF.fetch(`${BASE}/auth/tokens/current`, bearer(token));
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({
    user: { email: EMAIL },
    apiToken: { id: apiToken.id, name: "deploy script" },
  });
  expect(await (await SELF.fetch(`${BASE}/whoami`, bearer(token))).json()).toMatchObject({
    kind: "token",
    email: EMAIL,
  });
  expect(await (await SELF.fetch(`${BASE}/whoami`, bearer(session))).json()).toMatchObject({
    kind: "session",
    email: EMAIL,
  });
  // A session-only route answers 401 to the token (Review Focus 1).
  expect((await SELF.fetch(`${BASE}/me`, bearer(token))).status).toBe(401);
  expect(
    (
      await SELF.fetch(
        `${BASE}/auth/tokens`,
        json({ name: "minted by a token" }, { authorization: `Bearer ${token}` }),
      )
    ).status,
  ).toBe(401);

  const revoked = await SELF.fetch(
    `${BASE}/auth/tokens/revoke`,
    json({ id: apiToken.id }, { authorization: `Bearer ${session}` }),
  );
  expect(await revoked.json()).toEqual({ ok: true });
  expect((await SELF.fetch(`${BASE}/auth/tokens/current`, bearer(token))).status).toBe(401);
  expect((await SELF.fetch(`${BASE}/whoami`, bearer(token))).status).toBe(401);
});
