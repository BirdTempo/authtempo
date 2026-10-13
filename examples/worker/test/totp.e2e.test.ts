import { env, SELF } from "cloudflare:test";
import { base32Decode, totpCode } from "@tempo-auth/core/testing";
import { expect, it } from "vitest";
import { BASE, lastLink } from "./helpers.js";

const PW = "correct horse battery";
const json = (body: unknown, cookie = "") => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: BASE,
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});
const form = (body: Record<string, string>) => ({
  method: "POST",
  redirect: "manual" as const,
  headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
  body: new URLSearchParams(body).toString(),
});
const named = (res: Response, name: string) =>
  (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0] ?? "";

/** A verified user: the sign-up, then the mailed verify link. Answers the session cookie. */
async function verifiedUser(email: string): Promise<string> {
  await SELF.fetch(`${BASE}/auth/password/sign-up`, json({ email, password: PW }));
  const token = (await lastLink()).searchParams.get("token") ?? "";
  const verified = await SELF.fetch(`${BASE}/auth/password/verify`, form({ token }));
  return named(verified, "tempo_session");
}

/** The factor on. The code of the next step is the one a later verify sends: the enable spent this step. */
async function enrolled(email: string) {
  const cookie = await verifiedUser(email);
  const setup = await SELF.fetch(`${BASE}/auth/totp/setup`, json({}, cookie));
  const body = (await setup.json()) as { secret: string; backupCodes: string[] };
  const secret = base32Decode(body.secret);
  const enable = await SELF.fetch(
    `${BASE}/auth/totp/enable`,
    json({ code: await totpCode(secret, new Date()) }, cookie),
  );
  expect(enable.status).toBe(200);
  const next = () => totpCode(secret, new Date(Date.now() + 30_000));
  return { cookie, secret: body.secret, backupCodes: body.backupCodes, next };
}

async function challengeFor(email: string, cookie = ""): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/password/sign-in`, json({ email, password: PW }, cookie));
}

it("turns the factor on, gates the password sign-in, and opens the session with a code on D1", async () => {
  const email = "totp-a@example.com";
  const f = await enrolled(email);
  const row = await env.DB.prepare(
    "SELECT t.secret, t.enabled_at, t.last_step, t.backup_codes FROM ta_totp t JOIN ta_user u ON u.id = t.user_id WHERE u.email = ?",
  )
    .bind(email)
    .first<{
      secret: string;
      enabled_at: number | null;
      last_step: number;
      backup_codes: string;
    }>();
  expect(row?.enabled_at).not.toBeNull();
  // The enable's step; a step boundary can pass before this read.
  expect(row?.last_step).toBeGreaterThanOrEqual(Math.floor(Date.now() / 30_000) - 1);
  // The sealed secret and the keyed hashes only (Review Focus 5).
  expect(row?.secret).not.toContain(f.secret);
  const hashes = JSON.parse(row?.backup_codes ?? "[]") as string[];
  expect(hashes).toHaveLength(10);
  for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
  for (const c of f.backupCodes) expect(row?.backup_codes).not.toContain(c);

  const signIn = await challengeFor(email);
  expect(signIn.status).toBe(200);
  expect(signIn.headers.get("set-cookie")).toBeNull();
  const { twoFactor } = (await signIn.json()) as { twoFactor: { challenge: string } };
  const code = await f.next();
  const verify = await SELF.fetch(
    `${BASE}/auth/totp/verify`,
    json({ challenge: twoFactor.challenge, code }),
  );
  expect(verify.status).toBe(200);
  const session = named(verify, "tempo_session");
  expect((await SELF.fetch(`${BASE}/me`, { headers: { cookie: session } })).status).toBe(200);

  // The replay guard is a D1 conditional update (Review Focus 1).
  const again = (await (await challengeFor(email)).json()) as { twoFactor: { challenge: string } };
  const replay = await SELF.fetch(
    `${BASE}/auth/totp/verify`,
    json({ challenge: again.twoFactor.challenge, code }),
  );
  expect(replay.status).toBe(400);
  expect(await replay.json()).toEqual({ error: "invalid_code" });
  const backup = await SELF.fetch(
    `${BASE}/auth/totp/verify`,
    json({ challenge: again.twoFactor.challenge, backupCode: f.backupCodes[0] }),
  );
  expect(((await backup.json()) as { backupCodesLeft: number }).backupCodesLeft).toBe(9);
});

it("serves the challenge page and its form on D1, and caps the challenge at five wrong codes", async () => {
  const email = "totp-b@example.com";
  const f = await enrolled(email);
  const first = (await (await challengeFor(email)).json()) as { twoFactor: { challenge: string } };
  const page = await SELF.fetch(
    `${BASE}/auth/totp/challenge?challenge=${first.twoFactor.challenge}`,
  );
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('autocomplete="one-time-code"');
  const done = await SELF.fetch(
    `${BASE}/auth/totp/challenge`,
    form({ challenge: first.twoFactor.challenge, backupCode: f.backupCodes[1] ?? "" }),
  );
  expect(done.status).toBe(302);
  expect(named(done, "tempo_session")).toMatch(/^tempo_session=ts_/);

  const capped = (await (await challengeFor(email)).json()) as { twoFactor: { challenge: string } };
  const right = await f.next();
  const wrong = right === "000000" ? "111111" : "000000";
  const answers: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await SELF.fetch(
      `${BASE}/auth/totp/verify`,
      json({ challenge: capped.twoFactor.challenge, code: wrong }),
    );
    answers.push(((await r.json()) as { error: string }).error);
  }
  expect(answers).toEqual([
    "invalid_code",
    "invalid_code",
    "invalid_code",
    "invalid_code",
    "too_many_attempts",
    "too_many_attempts",
  ]);
});

it("skips the gate with the trust cookie on D1, and deletes an expired trusted device", async () => {
  const email = "totp-c@example.com";
  const f = await enrolled(email);
  const first = (await (await challengeFor(email)).json()) as { twoFactor: { challenge: string } };
  const verify = await SELF.fetch(
    `${BASE}/auth/totp/verify`,
    json({ challenge: first.twoFactor.challenge, code: await f.next(), trustDevice: true }),
  );
  const trustLine =
    verify.headers.getSetCookie().find((c) => c.startsWith("tempo_totp_trust=")) ?? "";
  expect(trustLine).toMatch(
    /^tempo_totp_trust=td_[A-Za-z0-9_-]{43}; Path=\/auth\/; Max-Age=2592000;/,
  );
  const trust = trustLine.split(";")[0] ?? "";
  const skipped = await challengeFor(email, trust);
  expect(named(skipped, "tempo_session")).toMatch(/^tempo_session=ts_/);

  await env.DB.prepare("UPDATE ta_trusted_device SET expires_at = ?")
    .bind(Date.now() - 1000)
    .run();
  const gated = await challengeFor(email, trust);
  expect(((await gated.json()) as { twoFactor?: unknown }).twoFactor).toBeDefined();
  const left = await env.DB.prepare("SELECT count(*) AS n FROM ta_trusted_device").first<number>(
    "n",
  );
  expect(left).toBe(0);
});
