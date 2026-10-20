import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { base32Decode, SoftAuthenticator, totpCode } from "@authtempo/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The writes of the second factor beside the account delete (plan 12f Task
// 9 review m1), on the real Postgres adapter, through core's built output,
// with separate connections. The memory adapter runs one transaction at a
// time and D1 has no lock, so only Postgres shows the lock order. The account
// delete holds the user row, then deletes the passkey, totp, trustedDevice,
// and secondFactor rows in that order. Each flow here held one of those rows
// and then waited on a row that the delete took first. Each flow now holds
// the user row first (user-hold.ts), so the delete waits on it. Each row of
// the test makes its state through the flows, never with a direct insert.

const API = "https://api.example.com";
const APP = "https://app.example.com";
const PASSWORD = "correct horse battery";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const OPERATOR = { kind: "app", name: "support-tool" } as const;
/** The pause of the probe: long enough for the delete to take the rows it can (plan 12a Task 11). */
const HOLD_MS = 600;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

type Op = "delete" | "update";

/**
 * The engine on Postgres, with one probe inside its transactions. The probe
 * runs once, after the next write of `op` on `model`, on the same open
 * transaction. It starts the account delete and waits `HOLD_MS`.
 */
function world() {
  const sent: MailMessage[] = [];
  let probe: { model: string; op: Op; run: () => Promise<void> } | null = null;
  const adapter = createPostgresAdapter(db.sql);
  const fire = async (model: string, op: Op) => {
    const p = probe;
    if (!p || p.model !== model || p.op !== op) return;
    probe = null;
    await p.run();
  };
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    delete: (async (model, where) => {
      const n = await tx.delete(model, where);
      await fire(model, "delete");
      return n;
    }) as typeof tx.delete,
    update: (async (model, where, data) => {
      const n = await tx.update(model, where, data);
      await fire(model, "update");
      return n;
    }) as typeof tx.update,
  });
  const storage: StorageAdapter = {
    ...adapter,
    transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
      adapter.transaction((tx) => fn(wrap(tx)))) as typeof adapter.transaction,
  };
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP],
    storage,
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    // A low iteration count: the test is about the order of the locks, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    passkey: { rpID: "example.com", rpName: "Example", origins: [APP] },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
  });
  const post = (path: string, body: unknown, cookie?: string) =>
    auth.handle(
      new Request(`${API}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const lastMail = (to: string) => sent.filter((x) => x.to === to).at(-1)?.text ?? "";
  const lastToken = (to: string) => {
    const m = /token=([A-Za-z0-9_%-]+)/.exec(lastMail(to));
    if (!m?.[1]) throw new Error(`no token in the last mail to ${to}`);
    return decodeURIComponent(m[1]);
  };
  /** Arms the probe: after the next `op` on `model`, the account delete of `token`'s user starts. */
  function deleteAfter(model: string, op: Op, token: string) {
    const started: { deleting: Promise<unknown> | null } = { deleting: null };
    probe = {
      model,
      op,
      run: async () => {
        const session = await auth.api.getSession(token);
        if (!session) throw new Error("no session for the delete");
        started.deleting = auth.api.user.delete({ session, ip: null, userAgent: null });
        // A rejection is read below, after the answer of the flow.
        started.deleting.catch(() => {});
        await new Promise((r) => setTimeout(r, HOLD_MS));
      },
    };
    return async () => {
      while (started.deleting === null) await new Promise((r) => setTimeout(r, 10));
      return started.deleting;
    };
  }
  /** Arms the probe: after the next `op` on `model`, `start` runs and the transaction waits `HOLD_MS`. */
  function during(model: string, op: Op, start: () => Promise<unknown>) {
    const started: { flow: Promise<unknown> | null } = { flow: null };
    probe = {
      model,
      op,
      run: async () => {
        started.flow = start();
        // A rejection is read below, after the answer of the delete.
        started.flow.catch(() => {});
        await new Promise((r) => setTimeout(r, HOLD_MS));
      },
    };
    return async () => {
      while (started.flow === null) await new Promise((r) => setTimeout(r, 10));
      return started.flow;
    };
  }
  return { auth, post, lastMail, lastToken, deleteAfter, during };
}

type World = ReturnType<typeof world>;

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-tempo_session="))
    ?.split(";")[0] ?? "";
const tokenOf = (cookie: string) => cookie.slice("__Host-tempo_session=".length);

/** A verified user with a password and a session, by a magic link and the first password. */
async function user(w: World, email: string) {
  await w.post("/magic-link/request", { email });
  const cookie = cookieOf(await w.post("/magic-link/verify", { token: w.lastToken(email) }));
  expect((await w.post("/password/change", { newPassword: PASSWORD }, cookie)).status).toBe(200);
  const rows = await db.sql<{ id: string }[]>`SELECT id FROM ta_user WHERE email = ${email}`;
  const id = rows[0]?.id;
  if (!id) throw new Error("no user row");
  return { email, cookie, userId: id };
}

/** The challenge of a password sign-in of a user with the factor on. */
async function challenge(w: World, email: string) {
  const r = await w.auth.api.password?.signIn({
    email,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!r?.ok || !("twoFactor" in r.value)) throw new Error("no challenge");
  return r.value.twoFactor.challenge;
}

/**
 * A user with the email method on (no totp row) and one trusted device:
 * the state of review probe P1, made by the enable route and a sign-in
 * that trusts the device. Answers the token of that fresh session.
 */
async function emailWithDevice(w: World, email: string) {
  const u = await user(w, email);
  expect(
    (await w.post("/second-factor/email/enable", { password: PASSWORD }, u.cookie)).status,
  ).toBe(200);
  const c = await challenge(w, email);
  expect((await w.post("/second-factor/email/send", { challenge: c })).status).toBe(200);
  const code = /\b(\d{6})\b/.exec(w.lastMail(email))?.[1];
  if (!code) throw new Error("no code in the mail");
  const v = await w.auth.api.totp?.verify({
    challenge: c,
    emailCode: code,
    trustDevice: true,
    ip: null,
  });
  if (!v?.ok || !v.value.trustDevice) throw new Error("no trusted device");
  return { ...u, token: v.value.token };
}

/** The rows that name `userId` in the user and the second-factor tables. */
async function rowsOf(userId: string) {
  const count = async (table: string, column: string) =>
    (await db.sql`SELECT 1 FROM ${db.sql(table)} WHERE ${db.sql(column)} = ${userId}`).length;
  return {
    user: await count("ta_user", "id"),
    secondFactor: await count("ta_second_factor", "user_id"),
    totp: await count("ta_totp", "user_id"),
    trustedDevice: await count("ta_trusted_device", "user_id"),
    passkey: await count("ta_passkey", "user_id"),
  };
}

const NONE = { user: 0, secondFactor: 0, totp: 0, trustedDevice: 0, passkey: 0 };

/** Both answers came, with no throw (no deadlock), and the delete went through. */
async function settled(flow: Promise<unknown>, deleting: () => Promise<unknown>) {
  const answers = await Promise.allSettled([flow, deleting()]);
  for (const a of answers)
    expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
  const [first, deleted] = answers.map((a) => (a.status === "fulfilled" ? a.value : null));
  expect(deleted).toEqual({ ok: true, value: { ok: true } });
  return first;
}

describe("the second-factor writes beside the account delete on Postgres (plan 12f Task 9)", () => {
  it("the operator disable of an email-method factor with a trusted device: no deadlock, and no row of the user stays", async () => {
    const w = world();
    const u = await emailWithDevice(w, "ada@example.com");
    const deleting = w.deleteAfter("secondFactor", "delete", u.token);
    const flow = w.auth.api.operator.secondFactor.disable({
      actor: OPERATOR,
      userId: u.userId,
      reason: "Lost the phone",
      proof: {
        method: "document",
        reference: "CASE-1",
        checkedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      ip: null,
      userAgent: null,
    });
    expect(await settled(flow, deleting)).toMatchObject({ ok: true });
    expect(await rowsOf(u.userId)).toEqual(NONE);
  }, 60_000);

  it("the in-process api.totp.disable of the same state: no deadlock, and no row of the user stays", async () => {
    const w = world();
    const u = await emailWithDevice(w, "bob@example.com");
    const deleting = w.deleteAfter("secondFactor", "delete", u.token);
    const flow =
      w.auth.api.totp?.disable({ userId: u.userId }) ?? Promise.reject(new Error("no totp"));
    expect(await settled(flow, deleting)).toEqual({ ok: true, value: { ok: true } });
    expect(await rowsOf(u.userId)).toEqual(NONE);
  }, 60_000);

  it("the route disable of the last method, the email method: no deadlock, and no row of the user stays", async () => {
    const w = world();
    const u = await emailWithDevice(w, "cy@example.com");
    const deleting = w.deleteAfter("secondFactor", "delete", u.token);
    const flow = w
      .post(
        "/second-factor/disable",
        { method: "email", password: PASSWORD },
        `__Host-tempo_session=${u.token}`,
      )
      .then((res) => res.status);
    expect(await settled(flow, deleting)).toBe(200);
    expect(await rowsOf(u.userId)).toEqual(NONE);
  }, 60_000);

  it("the disable of the last method, TOTP, with a backup code: no deadlock, and no row of the user stays", async () => {
    const w = world();
    const u = await user(w, "dee@example.com");
    const set = await w.post("/totp/setup", { password: PASSWORD }, u.cookie);
    const { secret, backupCodes } = (await set.json()) as { secret: string; backupCodes: string[] };
    const code = await totpCode(base32Decode(secret), new Date());
    expect((await w.post("/totp/enable", { code }, u.cookie)).status).toBe(200);
    // A sign-in that trusts the device, with the first backup code.
    const v = await w.auth.api.totp?.verify({
      challenge: await challenge(w, u.email),
      backupCode: backupCodes[0],
      trustDevice: true,
      ip: null,
    });
    if (!v?.ok || !v.value.trustDevice) throw new Error("no trusted device");
    const session = await w.auth.api.getSession(v.value.token);
    if (!session) throw new Error("no session");
    const deleting = w.deleteAfter("secondFactor", "delete", v.value.token);
    const flow =
      w.auth.api.totp?.disableWithCode({ user: session.user, code: backupCodes[1] ?? "" }) ??
      Promise.reject(new Error("no totp"));
    expect(await settled(flow, deleting)).toEqual({ ok: true, value: { ok: true } });
    expect(await rowsOf(u.userId)).toEqual(NONE);
  }, 60_000);

  it("the first TOTP enable of a user with a second session: no deadlock, and no row of the user stays", async () => {
    const w = world();
    const u = await user(w, "eve@example.com");
    // A second session: the first enable ends it, and the delete ends it too.
    await w.post("/magic-link/request", { email: u.email });
    expect(cookieOf(await w.post("/magic-link/verify", { token: w.lastToken(u.email) }))).not.toBe(
      "",
    );
    const set = await w.post("/totp/setup", { password: PASSWORD }, u.cookie);
    const { secret } = (await set.json()) as { secret: string };
    const session = await w.auth.api.getSession(tokenOf(u.cookie));
    if (!session) throw new Error("no session");
    // The enable confirms the setup row first: then the delete starts.
    const deleting = w.deleteAfter("totp", "update", tokenOf(u.cookie));
    const flow =
      w.auth.api.totp?.enable({
        session,
        code: await totpCode(base32Decode(secret), new Date()),
      }) ?? Promise.reject(new Error("no totp"));
    const enabled = (await settled(flow, deleting)) as { ok: boolean };
    expect(enabled.ok).toBe(true);
    expect(await rowsOf(u.userId)).toEqual(NONE);
  }, 60_000);

  it("the passkey enable as a later method: no deadlock, and no row of the user stays", async () => {
    const w = world();
    const u = await user(w, "fay@example.com");
    const soft = await SoftAuthenticator.create({ rpID: "example.com", origin: APP });
    const options = (await (await w.post("/passkey/register/options", {}, u.cookie)).json()) as {
      challenge: string;
    };
    const registered = await w.post(
      "/passkey/register/verify",
      { response: await soft.register(options.challenge, new TextEncoder().encode(u.userId)) },
      u.cookie,
    );
    expect(registered.status).toBe(200);
    expect(
      (await w.post("/second-factor/email/enable", { password: PASSWORD }, u.cookie)).status,
    ).toBe(200);
    const signIn = (await (await w.post("/passkey/authenticate/options", {})).json()) as {
      challenge: string;
    };
    const response = await soft.authenticate(signIn.challenge);
    // The later enable updates the factor row first: then the delete starts.
    const deleting = w.deleteAfter("secondFactor", "update", tokenOf(u.cookie));
    const flow = w
      .post("/second-factor/passkey/enable", { password: PASSWORD, response }, u.cookie)
      .then((res) => res.status);
    expect(await settled(flow, deleting)).toBe(200);
    expect(await rowsOf(u.userId)).toEqual(NONE);
  }, 60_000);

  it("a first email enable that starts inside the delete's transaction: conflict, and no factor row of the user stays", async () => {
    const w = world();
    const u = await user(w, "gus@example.com");
    const session = await w.auth.api.getSession(tokenOf(u.cookie));
    if (!session) throw new Error("no session");
    // The enable starts after the delete removed the user row, before its commit.
    const enabling = w.during("user", "delete", () =>
      w
        .post("/second-factor/email/enable", { password: PASSWORD }, u.cookie)
        .then((res) => res.status),
    );
    const deleted = await w.auth.api.user.delete({ session, ip: null, userAgent: null });
    expect(deleted).toEqual({ ok: true, value: { ok: true } });
    // The hold waited on the delete and found no row; the read after the insert answers conflict.
    const status = await enabling();
    expect(await rowsOf(u.userId)).toEqual(NONE);
    expect(status).toBe(409);
  }, 60_000);
});
