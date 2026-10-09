import { SoftAuthenticator } from "@tempo-auth/core/testing";
import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const BASE = "https://example.test";

async function signInByMagicLink(): Promise<string> {
  await SELF.fetch(`${BASE}/auth/magic-link/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "ada@example.com" }),
  });
  const { link } = (await (await SELF.fetch(`${BASE}/__test/last-link`)).json()) as {
    link: string;
  };
  const token = new URL(link).searchParams.get("token") ?? "";
  const verify = await SELF.fetch(`${BASE}/auth/magic-link/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ token }).toString(),
  });
  return verify.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function postJson(path: string, body: unknown, cookie?: string) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

it("registers a passkey after a magic link sign-in and then signs in with it on D1", async () => {
  const cookie = await signInByMagicLink();
  expect(cookie).toMatch(/^tempo_session=ts_/);
  const soft = await SoftAuthenticator.create({ rpID: "example.test", origin: BASE });
  const options = await postJson("/auth/passkey/register/options", {}, cookie);
  expect(options.status).toBe(200);
  const creation = (await options.json()) as { challenge: string; rp: { id: string } };
  expect(creation.rp.id).toBe("example.test");
  const registered = await postJson(
    "/auth/passkey/register/verify",
    { response: await soft.register(creation.challenge), name: "Test device" },
    cookie,
  );
  expect(registered.status).toBe(200);
  const rows = await env.DB.prepare("SELECT credential_id, counter, name FROM ta_passkey").all<{
    credential_id: string;
    counter: number;
    name: string;
  }>();
  expect(rows.results).toEqual([
    { credential_id: soft.credentialId, counter: 0, name: "Test device" },
  ]);

  await SELF.fetch(`${BASE}/auth/sign-out`, { method: "POST", headers: { cookie, origin: BASE } });

  const request = await postJson("/auth/passkey/authenticate/options", {});
  expect(request.status).toBe(200);
  const req = (await request.json()) as { challenge: string };
  const signIn = await postJson("/auth/passkey/authenticate/verify", {
    response: await soft.authenticate(req.challenge),
  });
  expect(signIn.status).toBe(200);
  expect(await signIn.json()).toMatchObject({ user: { email: "ada@example.com" } });
  const newCookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
  const me = await SELF.fetch(`${BASE}/me`, { headers: { cookie: newCookie } });
  expect(me.status).toBe(200);
  const after = await env.DB.prepare("SELECT counter FROM ta_passkey").first<{ counter: number }>();
  expect(after?.counter).toBe(1);
  const replay = await postJson("/auth/passkey/authenticate/verify", {
    response: await soft.authenticate(req.challenge),
  });
  expect(replay.status).toBe(400);
  expect(await replay.json()).toEqual({ error: "invalid_token" });
});
