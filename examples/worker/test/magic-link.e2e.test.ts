import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const BASE = "https://example.test";

it("signs in by magic link, reads /me with the cookie and with a bearer, and signs out", async () => {
  const req = await SELF.fetch(`${BASE}/auth/magic-link/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "ada@example.com", next: "/me" }),
  });
  expect(req.status).toBe(200);

  const last = await SELF.fetch(`${BASE}/__test/last-link`);
  expect(last.status).toBe(200);
  const { link } = (await last.json()) as { link: string };
  expect(link.startsWith(`${BASE}/auth/magic-link/verify?token=ml_`)).toBe(true);

  const verify = await SELF.fetch(link, { redirect: "manual" });
  expect(verify.status).toBe(302);
  expect(verify.headers.get("location")).toBe(`${BASE}/me`);
  const setCookie = verify.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const token = cookie.split("=")[1] ?? "";

  const me = await SELF.fetch(`${BASE}/me`, { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ email: "ada@example.com" });

  const bearer = await SELF.fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(bearer.status).toBe(200);

  const out = await SELF.fetch(`${BASE}/auth/sign-out`, {
    method: "POST",
    headers: { cookie, origin: BASE },
  });
  expect(out.status).toBe(200);
  expect((await SELF.fetch(`${BASE}/me`, { headers: { cookie } })).status).toBe(401);
});

it("refuses a POST from an untrusted origin", async () => {
  const res = await SELF.fetch(`${BASE}/auth/magic-link/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ email: "ada@example.com" }),
  });
  expect(res.status).toBe(403);
});
