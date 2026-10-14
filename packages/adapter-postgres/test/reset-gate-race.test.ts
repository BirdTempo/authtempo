import { createAuth, createPbkdf2PasswordHash, type MailMessage } from "@authtempo/core";
import { base32Decode, SoftAuthenticator, totpCode } from "@authtempo/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The reset gate and the first enable of plan 12c, on two connections at once.
// The memory adapter runs one call at a time and D1 serializes every write, so
// only Postgres shows these orders. Each test asserts what must hold in every
// order of the statements, and runs several rounds to meet more orders. A test
// that passes proves the orders it met, not every order.

const API = "https://api.example.com";
const APP = "https://app.example.com";
const PASSWORD = "correct horse battery";
const ROUNDS = 5;
// The passkey races need more rounds: a bad order needs both transactions inside one window.
const PASSKEY_ROUNDS = 20;
// The change against a reset: the plan 12c final review met a 500 in the first round of 30.
const CHANGE_ROUNDS = 30;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

function race() {
  const sent: MailMessage[] = [];
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP],
    storage: createPostgresAdapter(db.sql),
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    // A low iteration count: the test counts orders of statements, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    passkey: { rpID: "example.com", rpName: "Example", origins: [APP] },
    // Every limit allows: the rounds would fill the reset and setup limits,
    // and this test is about the rows, not the limits.
    limiter: { allow: async () => true },
  });
  const post = (path: string, body: unknown, cookie?: string) =>
    auth.handle(
      new Request(`${API}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const lastToken = (to: string) => {
    const m = /token=([A-Za-z0-9_%-]+)/.exec(sent.filter((x) => x.to === to).at(-1)?.text ?? "");
    if (!m?.[1]) throw new Error(`no token in the last mail to ${to}`);
    return decodeURIComponent(m[1]);
  };
  return { auth, post, lastToken };
}

type Race = ReturnType<typeof race>;

/** A verified user with a password and a session. Answers the cookie and the user id. */
async function user(r: Race, email: string) {
  await r.post("/magic-link/request", { email });
  const link = await r.post("/magic-link/verify", { token: r.lastToken(email) });
  const cookie =
    link.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-tempo_session="))
      ?.split(";")[0] ?? "";
  expect((await r.post("/password/change", { newPassword: PASSWORD }, cookie)).status).toBe(200);
  const rows = await db.sql<{ id: string }[]>`SELECT id FROM ta_user WHERE email = ${email}`;
  const id = rows[0]?.id;
  if (!id) throw new Error("no user row");
  return { cookie, userId: id };
}

/** Starts the TOTP setup and answers the key. The enable is the caller's. */
async function setup(r: Race, cookie: string) {
  const res = await r.post("/totp/setup", { password: PASSWORD }, cookie);
  return base32Decode(((await res.json()) as { secret: string }).secret);
}

/** Registers one soft passkey for the session's user through the routes. Answers the authenticator and the passkey id. */
async function passkey(r: Race, u: { cookie: string; userId: string }) {
  const soft = await SoftAuthenticator.create({ rpID: "example.com", origin: APP });
  const options = (await (await r.post("/passkey/register/options", {}, u.cookie)).json()) as {
    challenge: string;
  };
  const res = await r.post(
    "/passkey/register/verify",
    { response: await soft.register(options.challenge, new TextEncoder().encode(u.userId)) },
    u.cookie,
  );
  expect(res.status).toBe(200);
  const { passkey } = (await res.json()) as { passkey: { id: string } };
  return { soft, id: passkey.id };
}

/** A sign-in assertion of `soft`: the proof of the passkey enable. */
async function assertion(r: Race, soft: SoftAuthenticator) {
  const options = (await (await r.post("/passkey/authenticate/options", {})).json()) as {
    challenge: string;
  };
  return soft.authenticate(options.challenge);
}

async function liveChallenges(userId: string): Promise<number> {
  const rows = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ta_verification
    WHERE purpose = 'two-factor' AND identifier = ${userId} AND consumed_at IS NULL`;
  return rows[0]?.n ?? -1;
}

async function sessions(userId: string): Promise<number> {
  const rows = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ta_session WHERE user_id = ${userId}`;
  return rows[0]?.n ?? -1;
}

async function passkeys(userId: string): Promise<number> {
  const rows = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ta_passkey WHERE user_id = ${userId}`;
  return rows[0]?.n ?? -1;
}

async function methods(userId: string): Promise<string[] | null> {
  const rows = await db.sql<{ methods: unknown }[]>`
    SELECT methods FROM ta_second_factor WHERE user_id = ${userId}`;
  if (rows.length === 0) return null;
  const raw = rows[0]?.methods;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as string[];
}

describe("the reset gate on Postgres (plan 12c)", () => {
  it("two parallel resets leave one live challenge and no session", async () => {
    const r = race();
    const email = "resets@example.com";
    const u = await user(r, email);
    const key = await setup(r, u.cookie);
    expect(
      (await r.post("/totp/enable", { code: await totpCode(key, new Date()) }, u.cookie)).status,
    ).toBe(200);
    for (let round = 0; round < ROUNDS; round++) {
      await r.post("/password/reset/request", { email });
      const first = r.lastToken(email);
      await r.post("/password/reset/request", { email });
      const second = r.lastToken(email);
      const answers = await Promise.all(
        [first, second].map((token) =>
          r.post("/password/reset", { token, password: `a brand new long password ${round}` }),
        ),
      );
      // A 500 is a thrown storage error, such as a deadlock: stop and report it.
      expect(answers.map((a) => a.status).sort()).toEqual([200, 400]);
      for (const a of answers) expect(a.headers.get("set-cookie")).toBeNull();
      // The newer reset deletes every older challenge before it writes its own.
      expect(await liveChallenges(u.userId)).toBe(1);
      expect(await sessions(u.userId)).toBe(0);
    }
  });

  it("a password change against a reset never answers 500 and leaves one winner", async () => {
    const r = race();
    const email = "change@example.com";
    await user(r, email);
    let current = PASSWORD;
    for (let round = 0; round < CHANGE_ROUNDS; round++) {
      // A new session each round: a winning reset ends every session of the user.
      const signIn = await r.post("/password/sign-in", { email, password: current });
      expect(signIn.status).toBe(200);
      const cookie =
        signIn.headers
          .getSetCookie()
          .find((c) => c.startsWith("__Host-tempo_session="))
          ?.split(";")[0] ?? "";
      await r.post("/password/reset/request", { email });
      const token = r.lastToken(email);
      const byReset = `a reset long password ${round}`;
      const byChange = `a changed long password ${round}`;
      const [reset, change] = await Promise.all([
        r.post("/password/reset", { token, password: byReset }),
        r.post("/password/change", { currentPassword: current, newPassword: byChange }, cookie),
      ]);
      // A 500 is a thrown storage error, such as a deadlock. The loser answers
      // 400 (the change deleted the link) or 409 (the reset changed the hash).
      const statuses = [reset.status, change.status];
      expect(statuses).not.toContain(500);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      current = reset.status === 200 ? byReset : byChange;
    }
  });

  it("a reset and the verify of an older challenge leave no session", async () => {
    const r = race();
    const email = "verify@example.com";
    const u = await user(r, email);
    const key = await setup(r, u.cookie);
    expect(
      (await r.post("/totp/enable", { code: await totpCode(key, new Date()) }, u.cookie)).status,
    ).toBe(200);
    const signIn = await r.post("/password/sign-in", { email, password: PASSWORD });
    const { twoFactor } = (await signIn.json()) as { twoFactor: { challenge: string } };
    await r.post("/password/reset/request", { email });
    const token = r.lastToken(email);
    // The enable spent the code of this step, so the verify uses the next step's code.
    const code = await totpCode(key, new Date(Date.now() + 30_000));
    const [reset, verify] = await Promise.all([
      r.post("/password/reset", { token, password: "a brand new long password" }),
      r.post("/totp/verify", { challenge: twoFactor.challenge, code }),
    ]);
    expect(reset.status).toBe(200);
    // The verify either lost its challenge to the reset's delete, or committed
    // a session that the reset's session delete then ended.
    expect([200, 400]).toContain(verify.status);
    expect(await sessions(u.userId)).toBe(0);
    expect(await liveChallenges(u.userId)).toBe(1);
  });
});

describe("the first enable on Postgres (plan 12c)", () => {
  it("two parallel first enables of two methods leave one row that holds each winner", async () => {
    const r = race();
    for (let round = 0; round < ROUNDS; round++) {
      const u = await user(r, `enable-${round}@example.com`);
      const key = await setup(r, u.cookie);
      const [totp, email] = await Promise.all([
        r.post("/totp/enable", { code: await totpCode(key, new Date()) }, u.cookie),
        r.post("/second-factor/email/enable", { password: PASSWORD }, u.cookie),
      ]);
      // A loser answers 409 `conflict`, never a 500: the unique violation is caught outside.
      for (const a of [totp, email]) expect([200, 409]).toContain(a.status);
      const won = [totp.status === 200 ? "totp" : null, email.status === 200 ? "email" : null]
        .filter((m): m is string => m !== null)
        .sort();
      expect(won.length).toBeGreaterThan(0);
      const rows = await db.sql<{ methods: unknown }[]>`
        SELECT methods FROM ta_second_factor WHERE user_id = ${u.userId}`;
      expect(rows).toHaveLength(1);
      expect([...((await methods(u.userId)) ?? [])].sort()).toEqual(won);
    }
  });
});

// Review Focus 4 of plan 12c on Postgres (the Task 6 review, M2). Under READ
// COMMITTED a passkey delete and a passkey enable each read rows that the
// other changes. The factor row hold and the passkey row hold put them in order.
describe("the passkey method on Postgres (plan 12c)", () => {
  it("two parallel deletes of the last two passkeys leave one passkey", async () => {
    const r = race();
    for (let round = 0; round < PASSKEY_ROUNDS; round++) {
      const u = await user(r, `deletes-${round}@example.com`);
      const a = await passkey(r, u);
      const b = await passkey(r, u);
      const enable = await r.post(
        "/second-factor/passkey/enable",
        { password: PASSWORD, response: await assertion(r, a.soft) },
        u.cookie,
      );
      expect(enable.status).toBe(200);
      const answers = await Promise.all(
        [a.id, b.id].map((id) => r.post("/passkeys/delete", { id }, u.cookie)),
      );
      // The loser answers 409: `conflict` when the hold lost the row, or
      // `second_factor_last_method` when its delete would remove the last one.
      expect(answers.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(await passkeys(u.userId)).toBe(1);
      expect(await methods(u.userId)).toEqual(["passkey"]);
    }
  });

  it("a first passkey enable against the delete of the only passkey never leaves the method on with no passkey", async () => {
    const r = race();
    for (let round = 0; round < PASSKEY_ROUNDS; round++) {
      const u = await user(r, `enable-delete-${round}@example.com`);
      const a = await passkey(r, u);
      const response = await assertion(r, a.soft);
      const [enable, del] = await Promise.all([
        r.post("/second-factor/passkey/enable", { password: PASSWORD, response }, u.cookie),
        r.post("/passkeys/delete", { id: a.id }, u.cookie),
      ]);
      // The enable loses with 400 `passkey_failed`; a 500 is a thrown storage error.
      expect([200, 400]).toContain(enable.status);
      expect([200, 409]).toContain(del.status);
      const on = (await methods(u.userId))?.includes("passkey") ?? false;
      const left = await passkeys(u.userId);
      // Never the method on with no passkey: the person could not pass the factor.
      expect(on && left === 0).toBe(false);
      // Exactly one of the two wins.
      expect([enable.status === 200, del.status === 200]).toContain(true);
    }
  });
});

// Not asserted here: a reset of a user with the factor off that races the
// user's first enable. The reset reads "off" and writes a session; the enable
// ends the other sessions. When the reset's session commits after the enable's
// delete, it survives with the factor on. The password sign-in has the same
// window. The owner accepted it on 2026-10-14 as recorded and not closed (spec
// 9); a test that asserts it would pin a defect, so none is written.
