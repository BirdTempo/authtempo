import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const BASE = "https://example.test";
const EMAIL = "pat@example.com";
const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE, ...extra },
  body: JSON.stringify(body),
});
const form = (body: Record<string, string>) => ({
  method: "POST",
  redirect: "manual" as const,
  headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
  body: new URLSearchParams(body).toString(),
});
async function lastLink(): Promise<string> {
  return ((await (await SELF.fetch(`${BASE}/__test/last-link`)).json()) as { link: string }).link;
}
/**
 * The value of `read` once it holds one. The uniform sign-up writes its rows
 * and sends its mail after the answer, under ctx.waitUntil (final fix wave
 * item 19 of plan 12i), so the test waits up to 2 seconds for them.
 */
async function eventually<T>(read: () => Promise<T | null | undefined>): Promise<T | null> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

it("signs up, confirms by the mailed link, signs in, resets, and signs in again on D1", async () => {
  const up = await SELF.fetch(
    `${BASE}/auth/password/sign-up`,
    json({ email: EMAIL, password: "correct horse battery" }),
  );
  expect(up.status).toBe(200);
  // The uniform answer (plan 12b): no session at sign-up; the verify link opens it.
  expect(await up.json()).toEqual({ sent: true });
  expect(up.headers.get("set-cookie")).toBeNull();
  // The example uses 1000 iterations in TEST_MODE. The stored hash shows the seam ran in workerd.
  const stored = await eventually(() =>
    env.DB.prepare(
      "SELECT p.hash FROM ta_password p JOIN ta_user u ON u.id = p.user_id WHERE u.email = ?",
    )
      .bind(EMAIL)
      .first<{ hash: string }>(),
  );
  expect(stored?.hash).toMatch(/^pbkdf2-sha256\$1000\$/);

  const verifyLink =
    (await eventually(async () => {
      const link = await lastLink();
      return link.startsWith(`${BASE}/auth/password/verify?token=pv_`) ? link : null;
    })) ?? "";
  expect(verifyLink.startsWith(`${BASE}/auth/password/verify?token=pv_`)).toBe(true);
  const page = await SELF.fetch(verifyLink, { redirect: "manual" });
  expect(page.status).toBe(200);
  expect(page.headers.get("set-cookie")).toBeNull();
  expect(await page.text()).toContain(`<form method="post" action="/auth/password/verify">`);
  const verified = await SELF.fetch(
    `${BASE}/auth/password/verify`,
    form({ token: new URL(verifyLink).searchParams.get("token") ?? "" }),
  );
  expect(verified.status).toBe(302);
  expect(verified.headers.get("location")).toBe(`${BASE}/`);
  expect(verified.headers.get("set-cookie")).toMatch(/^__Host-tempo_session=ts_/);
  const user = await env.DB.prepare("SELECT email_verified FROM ta_user WHERE email = ?")
    .bind(EMAIL)
    .first<{ email_verified: number }>();
  expect(user?.email_verified).toBe(1);

  const signIn = await SELF.fetch(
    `${BASE}/auth/password/sign-in`,
    json({ email: EMAIL, password: "correct horse battery" }),
  );
  expect(signIn.status).toBe(200);
  const { token } = (await signIn.json()) as { token: string };
  expect(
    (await SELF.fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(200);
  const wrong = await SELF.fetch(
    `${BASE}/auth/password/sign-in`,
    json({ email: EMAIL, password: "wrong password" }),
  );
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: "invalid_credentials" });

  expect(
    (await SELF.fetch(`${BASE}/auth/password/reset/request`, json({ email: EMAIL }))).status,
  ).toBe(200);
  const resetLink = await lastLink();
  expect(resetLink.startsWith(`${BASE}/auth/password/reset?token=pr_`)).toBe(true);
  expect((await SELF.fetch(resetLink, { redirect: "manual" })).status).toBe(200);
  const reset = await SELF.fetch(
    `${BASE}/auth/password/reset`,
    form({
      token: new URL(resetLink).searchParams.get("token") ?? "",
      password: "new horse battery staple",
    }),
  );
  expect(reset.status).toBe(302);
  expect(reset.headers.get("location")).toBe(`${BASE}/`);

  // The reset ended the earlier sessions, the bearer one included.
  expect(
    (await SELF.fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(401);
  expect(
    (
      await SELF.fetch(
        `${BASE}/auth/password/sign-in`,
        json({ email: EMAIL, password: "correct horse battery" }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await SELF.fetch(
        `${BASE}/auth/password/sign-in`,
        json({ email: EMAIL, password: "new horse battery staple" }),
      )
    ).status,
  ).toBe(200);
});
