import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, ConfigError, type MailMessage } from "../src/config.js";
import { appActor, type OperatorActor } from "../src/engine/operator/guards.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { passwordSignIn, requestPasswordReset, resetPassword } from "../src/engine/password.js";
import { destroySession, resolveSession } from "../src/engine/sessions.js";
import { verifyTwoFactor } from "../src/engine/totp.js";
import { confirmUserInvite } from "../src/engine/user-invite.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { AuthEvent } from "../src/observe/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { SessionRow, UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { BASE_URL, get, makeAuth, post, recordCredential, settled } from "./helpers.js";
import { OPERATOR_SECRETS, operatorAuth, operatorFixture } from "./operator-helpers.js";
import { codeNow, enrolled, PASSWORD } from "./totp-helpers.js";

// The invitation link of a created user (plan 12f2 Task 3, spec 26). Every
// user comes from the operator create; every invitation row from a create.

const ADA = "ada@example.com";
const NEW = "ada.new@example.com";
const REASON = { reason: "Ticket 4521", ip: "203.0.113.9", userAgent: "Support/1" };
const CONFIRM = "/auth/user/invite/confirm";
const SUBJECT = "You have an account on api.example.com";
const HOUR = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function appOf(name: string): OperatorActor {
  const actor = appActor(name);
  if (!actor.ok) throw new Error(actor.code);
  return actor.value;
}

/**
 * The engine view of plan 12f (`operatorAuth`) with the user tools on and
 * a recording sink. `calls` records every user, session, and operator hook
 * with its event; `events()` answers each event of the sink so far.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const calls: [string, unknown][] = [];
  const rec =
    (name: string) =>
    (e: unknown): void =>
      void calls.push([name, e]);
  const batches: AuthEvent[][] = [];
  const auth = await operatorAuth({
    observe: { sink: { write: (b) => void batches.push([...b]) } },
    hooks: {
      user: {
        beforeCreate: rec("user.beforeCreate"),
        afterCreate: rec("user.afterCreate"),
        beforeVerify: rec("user.beforeVerify"),
        afterVerify: rec("user.afterVerify"),
        beforeUpdate: rec("user.beforeUpdate"),
        afterUpdate: rec("user.afterUpdate"),
      },
      session: {
        beforeCreate: rec("session.beforeCreate"),
        afterCreate: rec("session.afterCreate"),
        afterEnd: rec("session.afterEnd"),
      },
      operator: {
        beforeAction: rec("operator.beforeAction"),
        afterAction: rec("operator.afterAction"),
      },
    },
    ...extra,
  });
  const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
  const cookie = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  async function events(): Promise<AuthEvent[]> {
    await auth.config.observe.flush();
    return batches.flat();
  }
  return {
    ...auth,
    calls,
    handle,
    cookie,
    events,
    api: operatorApi(auth.config).users,
    desk: appOf("support-desk"),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Creates Ada with the default first sign-in: an invitation. */
async function invited(w: World, email = ADA) {
  const done = await w.api.create({ actor: w.desk, email, ...REASON });
  if (!done.ok) throw new Error(done.code);
  return done.value;
}

/** The token of the newest invitation mail to `to`. */
function inviteOf(mail: readonly MailMessage[], to = ADA): string {
  const m = [...mail].reverse().find((x) => x.to === to && x.subject === SUBJECT);
  const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
  if (!token) throw new Error(`no invitation to ${to}`);
  return recordCredential(decodeURIComponent(token));
}

/** The token of the newest mail to `to` that holds a link with a token. */
function linkTo(mail: readonly MailMessage[], to: string): string {
  const m = [...mail].reverse().find((x) => x.to === to && /token=/.test(x.text));
  const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
  if (!token) throw new Error(`no link to ${to}`);
  return recordCredential(decodeURIComponent(token));
}

/** The session token that a sign-in answer set. */
function sessionToken(w: World, res: Response): string {
  const set = res.headers
    .getSetCookie()
    .find(
      (c) => c.startsWith(`${w.config.cookieName}=`) && !c.startsWith(`${w.config.cookieName}=;`),
    );
  const token = set?.slice(w.config.cookieName.length + 1).split(";")[0];
  if (!token) throw new Error("no session cookie");
  return recordCredential(token);
}

/** A magic link sign-in of `email` through the routes: the session token. */
async function magicLinkSession(w: World, email = ADA): Promise<string> {
  expect((await w.handle(post("/auth/magic-link/request", { email }))).status).toBe(200);
  const res = await w.handle(post("/auth/magic-link/verify", { token: linkTo(w.mail, email) }));
  expect(res.status).toBe(200);
  return sessionToken(w, res);
}

const confirm = (w: World, token: string, ip = "198.51.100.7") =>
  w.handle(post(CONFIRM, { token }, { "cf-connecting-ip": ip }));

async function userOf(w: World, id: string): Promise<UserRow> {
  const row = await w.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);
  if (!row) throw new Error("no user row");
  return row;
}

const inviteRows = (w: World) =>
  w.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "user-invite" }]);
const sessionsOf = (w: World, userId: string) =>
  w.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);

describe("the invitation link (plan 12f2 Task 3)", () => {
  it("mails one invitation link and answers mailed invite", async () => {
    const w = await world();
    const done = await invited(w);
    expect(done.mailed).toBe("invite");
    const mails = w.mail.filter((m) => m.subject === SUBJECT);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(ADA);
    expect(mails[0]?.text).toContain(`${BASE_URL}${CONFIRM}?token=ui_`);
    expect(mails[0]?.text).toContain("It is valid for 72 hours and works once.");
    expect(mails[0]?.text).toContain(
      "If you did not expect this mail, ignore it and contact the support of api.example.com.",
    );
    // No operator name, no reason, and no IP of the create.
    for (const text of ["support-desk", REASON.reason, REASON.ip])
      expect(mails[0]?.text).not.toContain(text);
    const rows = await inviteRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identifier: done.userId,
      consumedAt: null,
      data: { email: ADA },
      valueHash: await sha256Hex(inviteOf(w.mail)),
    });
    expect(rows[0]?.expiresAt.getTime()).toBe(w.clock.now().getTime() + 72 * HOUR);
    // firstSignIn none and reset write no invitation.
    for (const firstSignIn of ["none", "reset"] as const) {
      const other = await w.api.create({
        actor: w.desk,
        email: `${firstSignIn}@example.com`,
        firstSignIn,
        ...REASON,
      });
      expect(other).toMatchObject({
        ok: true,
        value: { mailed: firstSignIn === "none" ? null : "reset" },
      });
    }
    expect(await inviteRows(w)).toHaveLength(1);
    expect(w.mail.filter((m) => m.subject === SUBJECT)).toHaveLength(1);
  });

  it("never puts the invitation token in the answer, the audit row, a log line, or a hook event", async () => {
    const logs = (["log", "info", "warn", "error"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    const w = await world();
    const done = await invited(w);
    const token = inviteOf(w.mail);
    const signedIn = await confirm(w, token);
    expect(signedIn.status).toBe(200);
    const audit = await w.storage.findMany("operatorAudit", []);
    expect(audit.length).toBeGreaterThan(0);
    const seen = JSON.stringify({
      done,
      answer: await signedIn.clone().json(),
      audit,
      logs: logs.map((l) => l.mock.calls),
      hooks: w.calls,
      events: await w.events(),
    });
    expect(w.calls.map(([name]) => name)).toContain("session.afterCreate");
    expect(seen).not.toContain(token);
    expect(seen).not.toContain(token.slice(3));
    expect(seen).not.toContain(await sha256Hex(token));
  });

  it("reads nothing at the confirm GET", async () => {
    const w = await world();
    await invited(w);
    const token = inviteOf(w.mail);
    const calls: string[] = [];
    for (const name of [
      "create",
      "findOne",
      "findMany",
      "update",
      "delete",
      "transaction",
    ] as const)
      vi.spyOn(w.storage, name).mockImplementation((() => {
        calls.push(name);
        throw new Error("no storage call at the GET");
      }) as never);
    const allow = vi.spyOn(w.config.limiter, "allow");
    const page = await w.handle(get(`${CONFIRM}?token=${token}`));
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("set-cookie")).toBeNull();
    const html = await page.text();
    expect(html).toContain(`<input type="hidden" name="token" value="${token}">`);
    expect(html).toContain(`action="${CONFIRM}"`);
    expect(html).not.toContain("<script");
    // A malformed token lands on the error page of the app, with no read either.
    const bad = await w.handle(get(`${CONFIRM}?token=ui_short`));
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(calls).toEqual([]);
    expect(allow).not.toHaveBeenCalled();
  });

  it("signs the person in at the confirm POST and verifies the address", async () => {
    const w = await world();
    const done = await invited(w);
    expect((await userOf(w, done.userId)).emailVerified).toBe(false);
    expect(
      await w.storage.findMany("identity", [{ field: "userId", op: "eq", value: done.userId }]),
    ).toEqual([]);
    w.calls.length = 0;
    const res = await confirm(w, inviteOf(w.mail));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { id: done.userId, email: ADA, emailVerified: true },
    });
    const session = await resolveSession(w.config, sessionToken(w, res));
    // The session row holds no via: the session hooks and the event carry it (below).
    expect(session?.session.userId).toBe(done.userId);
    expect((await userOf(w, done.userId)).emailVerified).toBe(true);
    const identities = await w.storage.findMany("identity", [
      { field: "userId", op: "eq", value: done.userId },
    ]);
    expect(identities.map((i) => [i.provider, i.subject])).toEqual([["email", ADA]]);
    expect(
      w.calls
        .filter(([name]) => name.startsWith("user."))
        .map(([name, e]) => [name, (e as { via: string }).via]),
    ).toEqual([
      ["user.beforeVerify", "invite"],
      ["user.afterVerify", "invite"],
    ]);
    expect(
      w.calls
        .filter(([name]) => name.startsWith("session."))
        .map(([name, e]) => [name, (e as { via: string }).via]),
    ).toEqual([
      ["session.beforeCreate", "invite"],
      ["session.afterCreate", "invite"],
    ]);
    const signIns = (await w.events()).filter((e) => e.name === "sign_in");
    expect(signIns).toMatchObject([{ method: "invite", outcome: "success", userId: done.userId }]);
    // A form post lands on the app with the cookie.
    const again = await invited(w, NEW);
    const form = await w.handle(
      new Request(`${BASE_URL}${CONFIRM}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
        body: new URLSearchParams({ token: inviteOf(w.mail, NEW) }).toString(),
      }),
    );
    expect(form.status).toBe(302);
    expect((await resolveSession(w.config, sessionToken(w, form)))?.user.id).toBe(again.userId);
  });

  it("spends the invitation once", async () => {
    const w = await world();
    const done = await invited(w);
    const token = inviteOf(w.mail);
    expect((await confirm(w, token)).status).toBe(200);
    const second = await confirm(w, token);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "invalid_token" });
    expect(await sessionsOf(w, done.userId)).toHaveLength(1);
  });

  it("refuses the invitation after the expiry", async () => {
    const w = await world({
      operator: {
        users: true,
        invite: { ttlHours: 2 },
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex("operator-support-0123456789abcdef-0123"),
            scopes: ["users"],
          },
        ],
      },
    });
    const done = await invited(w);
    const token = inviteOf(w.mail);
    expect(w.mail.at(-1)?.text).toContain("It is valid for 2 hours");
    w.clock.advance(2 * HOUR + 60_000);
    const res = await confirm(w, token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expect(await sessionsOf(w, done.userId)).toEqual([]);
    expect((await userOf(w, done.userId)).emailVerified).toBe(false);
  });

  it("refuses the invitation after a change of address", async () => {
    const w = await world();
    const done = await invited(w);
    const token = inviteOf(w.mail);
    const session = await magicLinkSession(w);
    const asked = await w.handle(
      post("/auth/user/change-email", { newEmail: NEW }, w.cookie(session)),
    );
    expect(asked.status).toBe(200);
    const moved = await w.handle(
      post("/auth/user/change-email/confirm", { token: linkTo(w.mail, NEW) }, w.cookie(session)),
    );
    expect(moved.status).toBe(200);
    expect((await userOf(w, done.userId)).email).toBe(NEW);
    const before = (await sessionsOf(w, done.userId)).length;
    const res = await confirm(w, token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expect(await sessionsOf(w, done.userId)).toHaveLength(before);
  });

  it("answers the challenge for an invitation of a user with the factor on", async () => {
    for (const gate of [true, false]) {
      const w = await world(gate ? {} : { totp: { gate: { invite: false } } });
      const done = await invited(w);
      const token = inviteOf(w.mail);
      // The person sets a password by a reset link, then turns TOTP on.
      expect((await requestPasswordReset(w.config, { email: ADA, ip: "1.1.1.1" })).ok).toBe(true);
      const reset = await resetPassword(w.config, {
        token: linkTo(w.mail, ADA),
        password: PASSWORD,
        ip: "1.1.1.1",
        userAgent: "ua",
      });
      expect(reset.ok).toBe(true);
      await enrolled(w, ADA);
      const before = (await sessionsOf(w, done.userId)).length;
      const res = await confirm(w, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      if (gate) {
        expect(body).toMatchObject({ twoFactor: { methods: ["totp", "backup"] } });
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(await sessionsOf(w, done.userId)).toHaveLength(before);
      } else {
        expect(body).toMatchObject({ user: { id: done.userId } });
        expect(await sessionsOf(w, done.userId)).toHaveLength(before + 1);
      }
    }
  });

  it("opens a session at the gate for a trust token of the user (review-12f2-task3 L2)", async () => {
    const w = await world();
    const done = await invited(w);
    const token = inviteOf(w.mail);
    expect((await requestPasswordReset(w.config, { email: ADA, ip: "1.1.1.1" })).ok).toBe(true);
    const reset = await resetPassword(w.config, {
      token: linkTo(w.mail, ADA),
      password: PASSWORD,
      ip: "1.1.1.1",
      userAgent: "ua",
    });
    expect(reset.ok).toBe(true);
    const { secret } = await enrolled(w, ADA);
    // A trust token of Ada: a password sign-in and its challenge with trustDevice.
    const s = await passwordSignIn(w.config, {
      email: ADA,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!s.ok || !("twoFactor" in s.value)) throw new Error("no challenge");
    const v = await verifyTwoFactor(w.config, {
      challenge: s.value.twoFactor.challenge,
      code: await codeNow(w, secret),
      trustDevice: true,
      ip: null,
    });
    if (!v.ok || !v.value.trustDevice) throw new Error("no trust token");
    const before = (await sessionsOf(w, done.userId)).length;
    const res = await w.handle(
      post(
        CONFIRM,
        { token, trustDevice: v.value.trustDevice.token },
        { "cf-connecting-ip": "198.51.100.7" },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: done.userId } });
    expect(await sessionsOf(w, done.userId)).toHaveLength(before + 1);
  });

  it("takes the invitation with the account delete", async () => {
    const w = await world();
    const done = await invited(w);
    const token = inviteOf(w.mail);
    expect(await inviteRows(w)).toHaveLength(1);
    const session = await magicLinkSession(w);
    const asked = await w.handle(post("/auth/user/delete", {}, w.cookie(session)));
    expect(asked.status).toBe(200);
    if (((await asked.json()) as { sent?: true }).sent) {
      const res = await w.handle(
        post("/auth/user/delete/confirm", { token: linkTo(w.mail, ADA) }, w.cookie(session)),
      );
      expect(res.status).toBe(200);
    }
    expect(
      await w.storage.findOne("user", [{ field: "id", op: "eq", value: done.userId }]),
    ).toBeNull();
    expect(await inviteRows(w)).toEqual([]);
    expect((await confirm(w, token)).status).toBe(400);
  });

  it("keeps the user and the invitation row when the invitation mail fails", async () => {
    const w = await world({
      mail: {
        send: async () => {
          throw new TypeError("mail down");
        },
      },
    });
    const done = await invited(w);
    expect(done.mailed).toBeNull();
    // The event of the log line `authtempo: operator create mail failed`, with no address.
    const failed = (await w.events()).filter((e) => e.name === "operator.create_mail_failed");
    expect(failed).toMatchObject([{ userId: done.userId, errorName: "TypeError" }]);
    expect(JSON.stringify(failed)).not.toContain(ADA);
    expect((await userOf(w, done.userId)).email).toBe(ADA);
    expect(await inviteRows(w)).toHaveLength(1);
  });

  it("counts the confirm POST per IP", async () => {
    const w = await world();
    await invited(w);
    const token = inviteOf(w.mail);
    for (let i = 0; i < 20; i++) expect((await confirm(w, "ui_wrong")).status).toBe(400);
    const limited = await confirm(w, token);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    // Another IP still signs in, and the window ends after 15 minutes.
    expect((await confirm(w, token, "198.51.100.8")).status).toBe(200);
    w.clock.advance(15 * 60_000);
    expect((await confirm(w, "ui_wrong")).status).toBe(400);
  });

  it("refuses ttlHours out of 1 to 168, and invite without operator.users", async () => {
    const secretHash = await sha256Hex("operator-support-0123456789abcdef-0123");
    const build = (invite: unknown, users = true) =>
      makeAuth({
        operator: {
          ...(users ? { users: true as const } : {}),
          invite: invite as { ttlHours: number },
          secrets: [{ name: "support", secretHash, scopes: users ? ["users"] : ["keys"] }],
        },
      }).config.operator?.invite;
    for (const ttlHours of [0, 169, 1.5, "72"])
      expect(() => build({ ttlHours })).toThrow(
        new ConfigError("operator.invite.ttlHours must be a whole number from 1 to 168"),
      );
    expect(build({ ttlHours: 1 })).toEqual({ ttlHours: 1 });
    expect(build({ ttlHours: 168 })).toEqual({ ttlHours: 168 });
    expect(build({})).toEqual({ ttlHours: 72 });
    expect(build(undefined)).toEqual({ ttlHours: 72 });
    expect(() => build({ ttlHours: 24 }, false)).toThrow(
      new ConfigError("operator.invite needs operator.users"),
    );
    expect(() => build({ ttl: 24 })).toThrow(/operator\.invite\.ttl is not an option/);
    await expect(
      world({ totp: { gate: { invite: "yes" as unknown as boolean } } }),
    ).rejects.toThrow(new ConfigError("totp.gate.invite must be true or false"));
    expect((await world()).config.totp?.gate.invite).toBe(true);
  });
});

describe("the claim of the invitation confirm (12f2 follow-up 7, K6)", () => {
  it("fires afterEnd once for each row when a race undoes the claim after its first chunk", async () => {
    // The impersonation tool was on, and then the app turned it off. So the
    // impersonation rows of the invited user are plain rows for the claim.
    // An invited user can hold no other session before the confirm.
    const operator = async (impersonation: boolean): Promise<Pick<AuthConfig, "operator">> => ({
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users", "sessions", "audit"],
          },
        ],
        users: true,
        ...(impersonation ? { impersonation: {} } : {}),
      },
    });
    const on = await operatorFixture({ config: await operator(true) });
    const done = await operatorApi(on.auth.config).users.create({
      actor: appOf("support-desk"),
      email: ADA,
      ...REASON,
    });
    if (!done.ok) throw new Error(done.code);
    const token = inviteOf(on.auth.mail);
    // 51 rows: the claim deletes 50 in its first chunk and the last in the next.
    const rows: { id: string; token: string }[] = [];
    for (let i = 0; i < 51; i++) {
      // The start limit is 20 an hour.
      if (i > 0 && i % 20 === 0) on.auth.clock.advance(HOUR + 1);
      const r = await startImpersonation(on.auth.config, {
        operator: on.operator,
        userId: done.value.userId,
        reason: REASON.reason,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      rows.push({ id: r.value.session.id, token: r.value.token });
    }
    const last = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1);
    if (!last) throw new Error("no rows");
    const ended: { session: SessionRow; reason: string }[] = [];
    const off = await operatorAuth({
      ...(await operator(false)),
      storage: on.auth.config.storage,
      clock: on.auth.clock,
      hooks: { session: { afterEnd: (e) => void ended.push(e) } },
    });
    const storage = off.config.storage;
    const original = storage.transaction.bind(storage);
    let armed = true;
    storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      original((tx) =>
        fn({
          ...tx,
          findMany: async (m, w, o) => {
            const found = await tx.findMany(m, w, o);
            if (armed && m === "session" && o?.sort?.field === "id") {
              armed = false;
              // A sign-out of the last row between the read of the claim and its second chunk.
              await destroySession(off.config, last.token);
            }
            return found;
          },
        }),
      );
    const answer = await confirmUserInvite(off.config, {
      token,
      ip: "198.51.100.7",
      userAgent: null,
    });
    expect(answer.ok).toBe(true);
    expect(armed).toBe(false);
    expect(ended.map((e) => [e.session.id, e.reason]).sort()).toEqual(
      rows.map((r) => [r.id, r.id === last.id ? "sign_out" : "claim"]).sort(),
    );
    const user = await storage.findOne("user", [
      { field: "id", op: "eq", value: done.value.userId },
    ]);
    expect(user?.emailVerified).toBe(true);
  });
});
