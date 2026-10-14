import { env, SELF } from "cloudflare:test";
import { base32Decode, totpCode } from "@authtempo/core/testing";
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

const STEP_MS = 30_000;

/**
 * The factor on. `next` answers the code of the step after the step that the enable spent.
 * It does not read the wall clock, so a step boundary between the enable and a later verify
 * does not move it two steps ahead (the verify accepts one step on each side of now).
 */
async function enrolled(email: string) {
  const cookie = await verifiedUser(email);
  // The setup takes the password (plan 9f final fix wave): a session alone sets up no factor.
  const setup = await SELF.fetch(`${BASE}/auth/totp/setup`, json({ password: PW }, cookie));
  expect(setup.status).toBe(200);
  const body = (await setup.json()) as { secret: string; backupCodes: string[] };
  const secret = base32Decode(body.secret);
  const enabledAt = new Date();
  const enableStep = Math.floor(enabledAt.getTime() / STEP_MS);
  const enable = await SELF.fetch(
    `${BASE}/auth/totp/enable`,
    json({ code: await totpCode(secret, enabledAt) }, cookie),
  );
  expect(enable.status).toBe(200);
  const next = () => totpCode(secret, new Date((enableStep + 1) * STEP_MS));
  return { cookie, secret: body.secret, backupCodes: body.backupCodes, enableStep, next };
}

/** The count of rows of `table` for the user of `email`. */
async function rowsFor(table: string, email: string): Promise<number | null> {
  return env.DB.prepare(
    `SELECT count(*) AS n FROM ${table} r JOIN ta_user u ON u.id = r.user_id WHERE u.email = ?`,
  )
    .bind(email)
    .first<number>("n");
}

/** The bytes of a base64url value. */
function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

async function challengeFor(email: string, cookie = ""): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/password/sign-in`, json({ email, password: PW }, cookie));
}

it("turns the factor on, gates the password sign-in, and opens the session with a code on D1", async () => {
  const email = "totp-a@example.com";
  const f = await enrolled(email);
  const row = await env.DB.prepare(
    // Since plan 12c the backup codes live on the factor row, not on ta_totp.
    "SELECT t.secret, t.enabled_at, t.last_step, f.backup_codes FROM ta_totp t JOIN ta_user u ON u.id = t.user_id JOIN ta_second_factor f ON f.user_id = u.id WHERE u.email = ?",
  )
    .bind(email)
    .first<{
      secret: string;
      enabled_at: number | null;
      last_step: number;
      backup_codes: string;
    }>();
  expect(row?.enabled_at).not.toBeNull();
  expect(row?.last_step).toBe(f.enableStep);
  // The sealed secret and the keyed hashes only (Review Focus 5). The stored value is
  // neither the base32 secret nor the base64url of its bytes: it is the AES-GCM frame,
  // 12 bytes of IV, the sealed bytes, and the 16-byte tag.
  const plain = base32Decode(f.secret);
  expect(row?.secret).not.toBe(f.secret);
  const stored = fromBase64Url(row?.secret ?? "");
  expect(stored).not.toEqual(plain);
  expect(stored).toHaveLength(12 + plain.length + 16);
  const hashes = JSON.parse(row?.backup_codes ?? "[]") as string[];
  expect(hashes).toHaveLength(10);
  for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
  for (const c of f.backupCodes) expect(row?.backup_codes).not.toContain(c);

  // The enable ended every other session, so the enrolling session is the one row.
  expect(await rowsFor("ta_session", email)).toBe(1);
  const signIn = await challengeFor(email);
  expect(signIn.status).toBe(200);
  expect(signIn.headers.get("set-cookie")).toBeNull();
  const { twoFactor } = (await signIn.json()) as {
    twoFactor: { challenge: string; expiresAt: string };
  };
  // The gated sign-in wrote no session row.
  expect(await rowsFor("ta_session", email)).toBe(1);
  expect(new Date(twoFactor.expiresAt).getTime()).toBeGreaterThan(Date.now());
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
  // The cap holds for a right code too.
  const late = await SELF.fetch(
    `${BASE}/auth/totp/verify`,
    json({ challenge: capped.twoFactor.challenge, code: right }),
  );
  expect(await late.json()).toEqual({ error: "too_many_attempts" });
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
  expect(await skipped.json()).not.toHaveProperty("twoFactor");

  // Only this user's rows: another test of this file also makes a trusted device.
  await env.DB.prepare(
    "UPDATE ta_trusted_device SET expires_at = ? WHERE user_id = (SELECT id FROM ta_user WHERE email = ?)",
  )
    .bind(Date.now() - 1000, email)
    .run();
  const gated = await challengeFor(email, trust);
  expect(((await gated.json()) as { twoFactor?: unknown }).twoFactor).toBeDefined();
  expect(await rowsFor("ta_trusted_device", email)).toBe(0);
});

it("turns the factor off with a code on D1: the sign-in opens a session again, and the factor and trusted device rows are gone", async () => {
  const email = "totp-d@example.com";
  const f = await enrolled(email);
  // A trusted device for the disable to delete. The verify spends a backup code, so the
  // TOTP code of the next step is still unspent for the disable. The step arithmetic: the
  // enable wrote `lastStep = enableStep`, and a backup-code verify does not move `lastStep`
  // by design (a backup code is no TOTP step). So `f.next()`, the code of `enableStep + 1`,
  // is still above `lastStep` and passes the disable's `lastStep lt step` update.
  const first = (await (await challengeFor(email)).json()) as { twoFactor: { challenge: string } };
  const verify = await SELF.fetch(
    `${BASE}/auth/totp/verify`,
    json({ challenge: first.twoFactor.challenge, backupCode: f.backupCodes[0], trustDevice: true }),
  );
  expect(verify.status).toBe(200);
  expect(await rowsFor("ta_trusted_device", email)).toBe(1);
  expect(await rowsFor("ta_totp", email)).toBe(1);

  const off = await SELF.fetch(
    `${BASE}/auth/totp/disable`,
    json({ code: await f.next() }, f.cookie),
  );
  expect(off.status).toBe(200);
  expect(await off.json()).toEqual({ ok: true });
  expect(await rowsFor("ta_totp", email)).toBe(0);
  expect(await rowsFor("ta_trusted_device", email)).toBe(0);

  const signIn = await challengeFor(email);
  expect(signIn.status).toBe(200);
  expect(named(signIn, "tempo_session")).toMatch(/^tempo_session=ts_/);
  expect(await signIn.json()).not.toHaveProperty("twoFactor");
});
