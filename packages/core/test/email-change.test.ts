import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  confirmEmailChange,
  requestEmailChange,
  verifyEmailChange,
} from "../src/engine/email-change.js";
import { requestEmailOtp, requestResetOtp } from "../src/engine/email-otp.js";
import { hookRefusal, type UserHooks } from "../src/engine/hooks.js";
import { requestMagicLink } from "../src/engine/magic-link.js";
import { passwordSignUp, requestPasswordReset } from "../src/engine/password.js";
import { requestReauthCode } from "../src/engine/reauth.js";
import { later } from "../src/engine/second-factor.js";
import { resolveSession } from "../src/engine/sessions.js";
import { defaultEmailChangePage } from "../src/http/email-change-page.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { UserRow, VerificationPurpose } from "../src/schema.js";
import type { StorageAdapter, Where } from "../src/storage/port.js";
import { BASE_URL, get, post } from "./helpers.js";
import { type Auth, EMAIL, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

// One test fixes the mailed codes, so its wrong guess can never be the code
// (review of plan 12a Task 8). Every other test gets real random codes.
const codes = vi.hoisted(() => ({ fixed: null as string | null }));
vi.mock("../src/primitives/crypto.js", async (load) => {
  const real = await load<typeof import("../src/primitives/crypto.js")>();
  return { ...real, randomDigits: (n: number) => codes.fixed ?? real.randomDigits(n) };
});

const NEW = "ada.new@example.com";
const OTHER = "ada.other@example.com";
const DAY = 86_400_000;
// The secret of makeAuth, so createAuth reads the rows that the test config wrote.
const SECRET = "0123456789abcdef0123456789abcdef";
const NOTICE = "Security notice for your api.example.com account";

afterEach(() => {
  vi.restoreAllMocks();
});

const byId = (id: string): Where<"user">[] => [{ field: "id", op: "eq", value: id }];

function linkOf(auth: Auth, to: string): string {
  const m = [...auth.mail].reverse().find((x) => x.to === to);
  const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
  if (!token) throw new Error(`no link to ${to}`);
  return decodeURIComponent(token);
}

function codeTo(auth: Auth, to: string): string {
  const m = [...auth.mail].reverse().find((x) => x.to === to);
  const code = /\b(\d{6})\b/.exec(m?.text ?? "")?.[1];
  if (!code) throw new Error(`no code to ${to}`);
  return code;
}

async function userRow(auth: Auth, id: string): Promise<UserRow> {
  const row = await auth.storage.findOne("user", byId(id));
  if (!row) throw new Error("no user row");
  return row;
}

async function emailSubjects(auth: Auth, userId: string): Promise<string[]> {
  const rows = await auth.storage.findMany("identity", [
    { field: "userId", op: "eq", value: userId },
    { field: "provider", op: "eq", value: "email" },
  ]);
  return rows.map((i) => i.subject);
}

const notices = (auth: Auth) => auth.mail.filter((m) => m.subject === NOTICE);

/** An auth whose user hooks read `auth` itself, so a hook can act as a parallel request does. */
function hooked(make: (get: () => Auth) => UserHooks, extra: Parameters<typeof totpAuth>[0] = {}) {
  let auth: Auth | null = null;
  const read = () => {
    if (!auth) throw new Error("no auth yet");
    return auth;
  };
  auth = totpAuth({ ...extra, hooks: { ...extra.hooks, user: make(read) } });
  return auth;
}

/** A user at `email` with no proof of it: a password sign-up whose verify link nobody opened. */
async function unverifiedUser(auth: Auth, email: string): Promise<void> {
  const up = await passwordSignUp(auth.config, {
    email,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!up.ok) throw new Error(up.code);
  const row = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (row?.emailVerified !== false) throw new Error("the sign-up verified the address");
}

describe("the change of address by link (plan 12a, spec 8.15)", () => {
  it("moves the address at the confirm, keeps the requesting session, ends the others, and notifies the old address", async () => {
    const ended: string[] = [];
    const auth = totpAuth({
      hooks: { session: { afterEnd: (e) => void ended.push(`${e.session.id}:${e.reason}`) } },
    });
    const other = await verifiedSession(auth, EMAIL, "1.1.1.1");
    const me = await verifiedSession(auth, EMAIL, "2.2.2.2");
    ended.length = 0;
    // Live proofs in the old mailbox must die with the move.
    await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    await requestEmailOtp(auth.config, { email: EMAIL, ip: null });
    await requestResetOtp(auth.config, { email: EMAIL, ip: null });
    await requestReauthCode(auth.config, { session: me });
    expect(await requestEmailChange(auth.config, { session: me, newEmail: NEW })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const mail = auth.mail.at(-1);
    expect(mail?.to).toBe(NEW);
    expect(mail?.text).toContain(`${BASE_URL}/auth/user/change-email/confirm?token=ec_`);
    // Nothing moved before the confirm.
    expect((await resolveSession(auth.config, me.token))?.user.email).toBe(EMAIL);
    const r = await confirmEmailChange(auth.config, {
      token: linkOf(auth, NEW),
      ip: "3.3.3.3",
      userAgent: "Agent/3",
    });
    expect(r).toMatchObject({
      ok: true,
      value: { user: { email: NEW, emailVerified: true }, next: "/" },
    });
    expect((await resolveSession(auth.config, me.token))?.user.email).toBe(NEW);
    expect(await resolveSession(auth.config, other.token)).toBeNull();
    // Every other session ends with email_change: the device and the sign-in of the verify link.
    const left = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: me.user.id },
    ]);
    expect(left.map((x) => x.id)).toEqual([me.session.id]);
    expect(ended).toContain(`${other.session.id}:email_change`);
    expect(ended.length).toBeGreaterThan(1);
    for (const e of ended) expect(e.endsWith(":email_change")).toBe(true);
    expect(await emailSubjects(auth, me.user.id)).toEqual([NEW]);
    const purposes: VerificationPurpose[] = [
      "magic-link",
      "password-reset",
      "email-otp",
      "password-reset-otp",
      "reauth-otp",
    ];
    for (const purpose of purposes)
      expect(
        await auth.storage.findMany("verification", [
          { field: "identifier", op: "eq", value: EMAIL },
          { field: "purpose", op: "eq", value: purpose },
        ]),
        purpose,
      ).toEqual([]);
    const notice = auth.mail.at(-1);
    expect(notice?.to).toBe(EMAIL);
    expect(notice?.subject).toBe(NOTICE);
    expect(notice?.text).toContain(`The new address is ${NEW}.`);
    expect(notice?.text).toContain("IP address: 3.3.3.3.");
    expect(notice?.text).toContain("contact the support of api.example.com");
    expect(notices(auth)).toHaveLength(1);
  });

  it("serves a confirm page that a mail scanner fetches with no effect, then the form post moves the address", async () => {
    const auth = totpAuth();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, next: "/settings" });
    const token = linkOf(auth, NEW);
    const reads = vi.spyOn(auth.config.storage, "findOne");
    const many = vi.spyOn(auth.config.storage, "findMany");
    const allow = vi.spyOn(auth.config.limiter, "allow");
    for (let i = 0; i < 2; i++) {
      const page = await handle(get(`/auth/user/change-email/confirm?token=${token}`));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("set-cookie")).toBeNull();
      const html = await page.text();
      expect(html).toContain(`value="${token}"`);
      expect(html).toContain('action="/auth/user/change-email/confirm"');
    }
    expect(reads).not.toHaveBeenCalled();
    expect(many).not.toHaveBeenCalled();
    expect(allow).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const row = await auth.storage.findOne("verification", [
      { field: "purpose", op: "eq", value: "email-change" },
    ]);
    expect(row?.consumedAt).toBeNull();
    const form = await handle(
      new Request(`${BASE_URL}/auth/user/change-email/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE_URL,
        },
        // A form may carry the name of its button.
        body: new URLSearchParams({ token, confirm: "" }).toString(),
      }),
    );
    expect(form.status).toBe(302);
    expect(form.headers.get("location")).toBe("https://api.example.com/settings");
    expect((await resolveSession(auth.config, me.token))?.user.email).toBe(NEW);
  });

  it("sends a note and no proof to an address that an unverified user holds, and writes a decoy row", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    // An unverified user at the new address: a sign-up whose verify link nobody opened.
    await unverifiedUser(auth, NEW);
    for (const method of ["link", "code"] as const) {
      expect(await requestEmailChange(auth.config, { session: me, newEmail: NEW, method })).toEqual(
        { ok: true, value: { sent: true } },
      );
      const mail = auth.mail.at(-1);
      expect(mail?.to).toBe(NEW);
      expect(mail?.subject).toBe("An account uses this address on api.example.com");
      expect(mail?.text).not.toContain("token=");
      expect(mail?.text).not.toMatch(/\d{6}/);
    }
    // The decoy rows: the same purposes and writes as a free address, marked taken (review M1).
    const rows = await auth.storage.findMany("verification", [
      { field: "purpose", op: "in", value: ["email-change", "email-change-otp"] },
    ]);
    expect(
      rows.map((r) => [r.purpose, r.identifier, (r.data as { taken?: unknown }).taken]),
    ).toEqual(
      expect.arrayContaining([
        ["email-change", me.user.id, true],
        ["email-change-otp", me.user.id, true],
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("answers email_taken at the confirm when another user took the address after the request", async () => {
    const beforeUpdate = vi.fn();
    const auth = totpAuth({ hooks: { user: { beforeUpdate } } });
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    await unverifiedUser(auth, NEW);
    expect(await confirmEmailChange(auth.config, { token, ip: null, userAgent: null })).toEqual({
      ok: false,
      code: "email_taken",
      status: 409,
    });
    expect((await resolveSession(auth.config, me.token))?.user.email).toBe(EMAIL);
    expect(await emailSubjects(auth, me.user.id)).toEqual([EMAIL]);
    expect(notices(auth)).toEqual([]);
    // The check comes before the hook, so no app code runs for a taken address.
    expect(beforeUpdate).not.toHaveBeenCalled();
  });

  it("refuses a stale session, an unverified user, the same address, a malformed one, and an unknown method, and a second request spends the first link", async () => {
    const beforeUpdate = vi.fn();
    const auth = totpAuth({ hooks: { user: { beforeUpdate } } });
    const me = await verifiedSession(auth);
    for (const newEmail of [EMAIL, " ADA@example.com ", "not an address"])
      expect(await requestEmailChange(auth.config, { session: me, newEmail })).toMatchObject({
        code: "invalid_body",
      });
    expect(
      await requestEmailChange(auth.config, {
        session: me,
        newEmail: NEW,
        method: "sms" as never,
      }),
    ).toMatchObject({ code: "invalid_body" });
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const first = linkOf(auth, NEW);
    await requestEmailChange(auth.config, { session: me, newEmail: OTHER });
    expect(
      await confirmEmailChange(auth.config, { token: first, ip: null, userAgent: null }),
    ).toEqual({ ok: false, code: "invalid_token", status: 400 });
    // A spent link runs no app code.
    expect(beforeUpdate).not.toHaveBeenCalled();
    auth.clock.advance(DAY);
    const old = await resolveSession(auth.config, me.token);
    if (!old) throw new Error("the session ended");
    expect(await requestEmailChange(auth.config, { session: old, newEmail: NEW })).toEqual({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
    const unverified = { ...old, user: { ...old.user, emailVerified: false } };
    expect(await requestEmailChange(auth.config, { session: unverified, newEmail: NEW })).toEqual({
      ok: false,
      code: "email_unverified",
      status: 403,
    });
  });

  it("answers token_expired for an old link, invalid_token for a spent, an unknown, or a malformed link", async () => {
    const beforeUpdate = vi.fn();
    const auth = totpAuth({ hooks: { user: { beforeUpdate } } });
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    const confirm = (t: string) =>
      confirmEmailChange(auth.config, { token: t, ip: null, userAgent: null });
    expect(await confirm(`ec_${"A".repeat(43)}`)).toMatchObject({ code: "invalid_token" });
    const allow = vi.spyOn(auth.config.limiter, "allow");
    for (const bad of ["", "ec_short", `ml_${"A".repeat(43)}`, `ec_${"A".repeat(44)}`])
      expect(await confirm(bad)).toMatchObject({ code: "invalid_token" });
    // A malformed token counts no try.
    expect(allow).not.toHaveBeenCalled();
    auth.clock.advance(15 * 60_000);
    expect(await confirm(token)).toEqual({ ok: false, code: "token_expired", status: 400 });
    // An old link runs no app code.
    expect(beforeUpdate).not.toHaveBeenCalled();
    auth.clock.advance(-1);
    expect((await confirm(token)).ok).toBe(true);
    expect(await confirm(token)).toEqual({ ok: false, code: "invalid_token", status: 400 });
  });
});

describe("the user hooks of the change of address (plan 12a)", () => {
  it("gives user.beforeUpdate the stored row and the patch, and user.afterUpdate both rows, with via email_change", async () => {
    const before: unknown[] = [];
    const after: unknown[] = [];
    const auth = totpAuth({
      hooks: {
        user: {
          beforeUpdate: (e) => void before.push(e),
          afterUpdate: (e) => void after.push(e),
        },
      },
    });
    const me = await verifiedSession(auth);
    const stored = await userRow(auth, me.user.id);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    auth.clock.advance(1000);
    expect(
      (
        await confirmEmailChange(auth.config, {
          token: linkOf(auth, NEW),
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
    const moved = await userRow(auth, me.user.id);
    expect(moved.updatedAt.getTime()).toBe(auth.clock.now().getTime());
    expect(before).toEqual([{ user: stored, patch: { email: NEW }, via: "email_change" }]);
    expect(after).toEqual([{ user: moved, previous: stored, via: "email_change" }]);
    // The code path gives the same events.
    before.length = 0;
    after.length = 0;
    const s = await verifiedSession(auth, NEW);
    await requestEmailChange(auth.config, { session: s, newEmail: OTHER, method: "code" });
    const code = codeTo(auth, OTHER);
    expect(
      (await verifyEmailChange(auth.config, { session: s, code, ip: null, userAgent: null })).ok,
    ).toBe(true);
    const again = await userRow(auth, me.user.id);
    expect(before).toEqual([{ user: moved, patch: { email: OTHER }, via: "email_change" }]);
    expect(after).toEqual([{ user: again, previous: moved, via: "email_change" }]);
  });

  it("a refusal or a throw of user.beforeUpdate moves nothing, spends nothing, and ends nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let mode: "refuse" | "throw" | "pass" = "refuse";
    const afterUpdate = vi.fn();
    const ended: string[] = [];
    const auth = totpAuth({
      hooks: {
        user: {
          beforeUpdate: (e) => {
            if (e.via !== "email_change" || mode === "pass") return;
            if (mode === "refuse") throw hookRefusal("Ask support to change it.");
            throw new Error(`boom ${NEW}`);
          },
          afterUpdate,
        },
        session: { afterEnd: (e) => void ended.push(e.reason) },
      },
    });
    const other = await verifiedSession(auth);
    const me = await verifiedSession(auth);
    ended.length = 0;
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    const confirm = () => confirmEmailChange(auth.config, { token, ip: null, userAgent: null });
    expect(await confirm()).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Ask support to change it.",
    });
    mode = "throw";
    expect(await confirm()).toEqual({ ok: false, code: "hook_failed", status: 500 });
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "user.beforeUpdate", "Error"],
    ]);
    expect((await userRow(auth, me.user.id)).email).toBe(EMAIL);
    expect(await emailSubjects(auth, me.user.id)).toEqual([EMAIL]);
    expect(await resolveSession(auth.config, other.token)).not.toBeNull();
    expect(afterUpdate).not.toHaveBeenCalled();
    expect(ended).toEqual([]);
    expect(notices(auth)).toEqual([]);
    // The link is still live: the stop ran before the spend.
    mode = "pass";
    expect((await confirm()).ok).toBe(true);
  });

  it("keeps the move and logs one line when user.afterUpdate throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = totpAuth({
      hooks: {
        user: {
          afterUpdate: () => {
            throw new Error(`boom ${NEW}`);
          },
        },
      },
    });
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    expect(
      await confirmEmailChange(auth.config, {
        token: linkOf(auth, NEW),
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: true, value: { user: { email: NEW } } });
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "user.afterUpdate", me.user.id, "Error"],
    ]);
    expect(notices(auth)).toHaveLength(1);
  });
});

describe("the races of the change of address (plan 12a)", () => {
  it("a parallel profile update between the read and the write: the move reads again, and afterUpdate gets the row it replaced", async () => {
    const seen: (string | null)[] = [];
    const after: { previous: UserRow; user: UserRow }[] = [];
    const auth = hooked((read) => ({
      beforeUpdate: async (e) => {
        seen.push(e.user.name);
        // The first round: a parallel profile update of the name lands, with its own write.
        if (seen.length === 1)
          await read().storage.update("user", byId(e.user.id), {
            name: "Other",
            updatedAt: later(read().clock.now(), e.user.updatedAt),
          });
      },
      afterUpdate: (e) => void after.push(e),
    }));
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const r = await confirmEmailChange(auth.config, {
      token: linkOf(auth, NEW),
      ip: null,
      userAgent: null,
    });
    expect(r).toMatchObject({ ok: true, value: { user: { email: NEW, name: "Other" } } });
    expect(seen).toEqual([null, "Other"]);
    const stored = await userRow(auth, me.user.id);
    expect(stored).toMatchObject({ email: NEW, name: "Other" });
    expect(after).toHaveLength(1);
    expect(after[0]?.previous).toMatchObject({ email: EMAIL, name: "Other" });
    expect(after[0]?.user).toEqual(stored);
  });

  it("a parallel profile update that writes the same name: the move sees it by updatedAt alone", async () => {
    let rounds = 0;
    let stamped: Date | null = null;
    const after: { previous: UserRow }[] = [];
    const auth = hooked((read) => ({
      beforeUpdate: async (e) => {
        rounds++;
        if (rounds > 1) return;
        stamped = later(read().clock.now(), e.user.updatedAt);
        await read().storage.update("user", byId(e.user.id), {
          name: e.user.name,
          updatedAt: stamped,
        });
      },
      afterUpdate: (e) => void after.push(e),
    }));
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    expect(
      (
        await confirmEmailChange(auth.config, {
          token: linkOf(auth, NEW),
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
    expect(rounds).toBe(2);
    expect(stamped).not.toBeNull();
    expect(after[0]?.previous.updatedAt).toEqual(stamped);
  });

  it("answers conflict after 5 lost rounds, moves nothing, and logs the user id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let rounds = 0;
    const auth = hooked((read) => ({
      beforeUpdate: async (e) => {
        rounds++;
        await read().storage.update("user", byId(e.user.id), {
          name: `Other ${rounds}`,
          updatedAt: later(read().clock.now(), e.user.updatedAt),
        });
      },
    }));
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    expect(await confirmEmailChange(auth.config, { token, ip: null, userAgent: null })).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(rounds).toBe(5);
    expect(await userRow(auth, me.user.id)).toMatchObject({ email: EMAIL, name: "Other 5" });
    expect(log.mock.calls).toEqual([["authtempo: email change gave up", me.user.id]]);
    expect(notices(auth)).toEqual([]);
  });

  it("a parallel request spends the link between the read and the move: the move undoes, and both rows stay", async () => {
    const afterUpdate = vi.fn();
    const ended: string[] = [];
    let me: Awaited<ReturnType<typeof verifiedSession>> | null = null;
    const auth = hooked(
      (read) => ({
        beforeUpdate: async () => {
          // A second request of the same user spends every earlier link, outside any transaction.
          if (me) await requestEmailChange(read().config, { session: me, newEmail: OTHER });
        },
        afterUpdate,
      }),
      { hooks: { session: { afterEnd: (e) => void ended.push(e.reason) } } },
    );
    const other = await verifiedSession(auth);
    me = await verifiedSession(auth);
    ended.length = 0;
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    expect(
      await confirmEmailChange(auth.config, {
        token: linkOf(auth, NEW),
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "invalid_token", status: 400 });
    expect((await userRow(auth, me.user.id)).email).toBe(EMAIL);
    expect(await emailSubjects(auth, me.user.id)).toEqual([EMAIL]);
    expect(await resolveSession(auth.config, other.token)).not.toBeNull();
    expect(afterUpdate).not.toHaveBeenCalled();
    expect(ended).toEqual([]);
    expect(notices(auth)).toEqual([]);
  });

  it("a parallel request spends the code between the check and the move: the move undoes", async () => {
    let me: Awaited<ReturnType<typeof verifiedSession>> | null = null;
    const auth = hooked((read) => ({
      beforeUpdate: async () => {
        if (me)
          await requestEmailChange(read().config, {
            session: me,
            newEmail: OTHER,
            method: "code",
          });
      },
    }));
    me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    const code = codeTo(auth, NEW);
    expect(
      await verifyEmailChange(auth.config, { session: me, code, ip: null, userAgent: null }),
    ).toEqual({ ok: false, code: "invalid_code", status: 400 });
    expect((await userRow(auth, me.user.id)).email).toBe(EMAIL);
    expect(await emailSubjects(auth, me.user.id)).toEqual([EMAIL]);
    expect(notices(auth)).toEqual([]);
  });

  // On memory the second confirm meets consumedAt before the transaction, so
  // this test proves that check only. The race inside the transaction is
  // proved on Postgres: "two confirms of one link at once" in
  // adapter-postgres/test/account-races.test.ts (review L2).
  it("two confirms of one link at once: one moves, one answers invalid_token, and one notice goes", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    const answers = await Promise.all(
      [0, 1].map(() => confirmEmailChange(auth.config, { token, ip: null, userAgent: null })),
    );
    expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual(["invalid_token", "ok"]);
    expect(notices(auth)).toHaveLength(1);
  });

  it("another user takes the address between the check and the write: email_taken, and nothing moves", async () => {
    const auth = hooked((read) => ({
      beforeUpdate: async () => {
        // A parallel sign-up of the new address commits its user row.
        const now = read().clock.now();
        await read().storage.create("user", {
          id: "01PARALLELSIGNUP0000000000",
          email: NEW,
          emailVerified: false,
          name: null,
          image: null,
          createdAt: now,
          updatedAt: now,
        });
      },
    }));
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    expect(
      await confirmEmailChange(auth.config, {
        token: linkOf(auth, NEW),
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "email_taken", status: 409 });
    expect((await userRow(auth, me.user.id)).email).toBe(EMAIL);
    expect(await emailSubjects(auth, me.user.id)).toEqual([EMAIL]);
    expect(notices(auth)).toEqual([]);
  });

  it("sends the notice to the address of the request, though a second move lands before the send", async () => {
    let nested = false;
    let me: Awaited<ReturnType<typeof verifiedSession>> | null = null;
    const auth = hooked((read) => ({
      afterUpdate: async () => {
        if (nested || !me) return;
        nested = true;
        // A second change, from NEW to OTHER, lands after the first commit and before its notice.
        const now = await resolveSession(read().config, me.token);
        if (!now) throw new Error("no session");
        await requestEmailChange(read().config, { session: now, newEmail: OTHER });
        const r = await confirmEmailChange(read().config, {
          token: linkOf(read(), OTHER),
          ip: null,
          userAgent: null,
        });
        if (!r.ok) throw new Error(r.code);
      },
    }));
    me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    expect(
      (
        await confirmEmailChange(auth.config, {
          token: linkOf(auth, NEW),
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
    expect((await userRow(auth, me.user.id)).email).toBe(OTHER);
    expect(notices(auth).map((m) => [m.to, m.text.split("\n")[1]])).toEqual([
      [NEW, `The new address is ${OTHER}.`],
      [EMAIL, `The new address is ${NEW}.`],
    ]);
  });

  it("moves the user row and the identity row in one transaction: a failed commit leaves both", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    const store = auth.config.storage as StorageAdapter;
    const origTx = store.transaction.bind(store);
    (store as { transaction: StorageAdapter["transaction"] }).transaction = (async <R>(
      fn: (tx: StorageAdapter) => Promise<R>,
    ) =>
      origTx(async (tx) => {
        await fn(tx);
        throw new Error("probe: the commit failed");
      })) as StorageAdapter["transaction"];
    await expect(
      confirmEmailChange(auth.config, { token, ip: null, userAgent: null }),
    ).rejects.toThrow("probe: the commit failed");
    (store as { transaction: StorageAdapter["transaction"] }).transaction = origTx;
    expect((await userRow(auth, me.user.id)).email).toBe(EMAIL);
    expect(await emailSubjects(auth, me.user.id)).toEqual([EMAIL]);
    expect(notices(auth)).toEqual([]);
    // The link is still live.
    expect((await confirmEmailChange(auth.config, { token, ip: null, userAgent: null })).ok).toBe(
      true,
    );
  });
});

describe("the change of address by code (plan 12a)", () => {
  it("mails a code to the new address, and only the same user's session moves the address with it", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    const mail = auth.mail.at(-1);
    expect(mail?.to).toBe(NEW);
    expect(mail?.text).not.toContain("token=");
    const code = codeTo(auth, NEW);
    const bob = await verifiedSession(auth, "bob@example.com");
    expect(
      await verifyEmailChange(auth.config, { session: bob, code, ip: null, userAgent: null }),
    ).toEqual({ ok: false, code: "invalid_code", status: 400 });
    const r = await verifyEmailChange(auth.config, {
      session: me,
      code,
      ip: null,
      userAgent: null,
    });
    expect(r).toMatchObject({ ok: true, value: { user: { email: NEW, emailVerified: true } } });
    expect((await userRow(auth, bob.user.id)).email).toBe("bob@example.com");
    expect(notices(auth).map((m) => m.to)).toEqual([EMAIL]);
  });

  it("two verifies of one code at once: one moves, one answers invalid_code", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    const code = codeTo(auth, NEW);
    const answers = await Promise.all(
      [0, 1].map(() =>
        verifyEmailChange(auth.config, { session: me, code, ip: null, userAgent: null }),
      ),
    );
    expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual(["invalid_code", "ok"]);
    expect(notices(auth)).toHaveLength(1);
  });

  it("keeps the session that verifies, and ends the others with email_change", async () => {
    const ended: string[] = [];
    const auth = totpAuth({
      hooks: { session: { afterEnd: (e) => void ended.push(`${e.session.id}:${e.reason}`) } },
    });
    const asked = await verifiedSession(auth);
    const verifies = await verifiedSession(auth);
    ended.length = 0;
    await requestEmailChange(auth.config, { session: asked, newEmail: NEW, method: "code" });
    const code = codeTo(auth, NEW);
    expect(
      (await verifyEmailChange(auth.config, { session: verifies, code, ip: null, userAgent: null }))
        .ok,
    ).toBe(true);
    expect(await resolveSession(auth.config, verifies.token)).not.toBeNull();
    expect(await resolveSession(auth.config, asked.token)).toBeNull();
    expect(ended).toContain(`${asked.session.id}:email_change`);
    for (const e of ended) expect(e.endsWith(":email_change")).toBe(true);
    const left = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: verifies.user.id },
    ]);
    expect(left.map((x) => x.id)).toEqual([verifies.session.id]);
  });

  it("counts wrong codes to the cap, then answers too_many_attempts, and a code with no request is invalid", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    const verify = (code: string) =>
      verifyEmailChange(auth.config, { session: me, code, ip: null, userAgent: null });
    expect(await verify("123456")).toEqual({ ok: false, code: "invalid_code", status: 400 });
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    const code = codeTo(auth, NEW);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect(await verify(wrong)).toMatchObject({ code: "invalid_code" });
    expect(await verify(wrong)).toEqual({ ok: false, code: "too_many_attempts", status: 400 });
    expect(await verify(code)).toMatchObject({ code: "too_many_attempts" });
    expect((await userRow(auth, me.user.id)).email).toBe(EMAIL);
  });

  it("answers email_taken for a code when another user took the address after the request", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    const code = codeTo(auth, NEW);
    await unverifiedUser(auth, NEW);
    expect(
      await verifyEmailChange(auth.config, { session: me, code, ip: null, userAgent: null }),
    ).toEqual({ ok: false, code: "email_taken", status: 409 });
  });

  it("answers not_found for the code method and the verify with emailOtp off, and counts no try", async () => {
    const auth = totpAuth({ emailOtp: false });
    const me = await verifiedSession(auth);
    const allow = vi.spyOn(auth.config.limiter, "allow");
    expect(
      await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" }),
    ).toEqual({ ok: false, code: "not_found", status: 404 });
    expect(
      await verifyEmailChange(auth.config, {
        session: me,
        code: "123456",
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "not_found", status: 404 });
    expect(allow).not.toHaveBeenCalled();
    // The link stays on.
    expect((await requestEmailChange(auth.config, { session: me, newEmail: NEW })).ok).toBe(true);
  });
});

describe("the limits of the change of address (plan 12a)", () => {
  // The literals are the numbers that the README and the limits page promise.
  it("allows 5 requests per user in 1 hour, on a key of its own per user", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    const bob = await verifiedSession(auth, "bob@example.com");
    const allow = vi.spyOn(auth.config.limiter, "allow");
    // A new address each time, so the per-address key stays below its cap.
    for (let i = 0; i < 5; i++)
      expect(
        (await requestEmailChange(auth.config, { session: me, newEmail: `n${i}@example.com` })).ok,
      ).toBe(true);
    expect(
      await requestEmailChange(auth.config, { session: me, newEmail: "n5@example.com" }),
    ).toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(allow).toHaveBeenLastCalledWith(`email-change:user:${me.user.id}`, {
      seconds: 3600,
      max: 5,
    });
    expect((await requestEmailChange(auth.config, { session: bob, newEmail: NEW })).ok).toBe(true);
    // Fresh again, so the window and not the fresh rule decides.
    auth.clock.advance(3600_000 - 1);
    const s1 = await verifiedSession(auth);
    expect(
      await requestEmailChange(auth.config, { session: s1, newEmail: "n6@example.com" }),
    ).toMatchObject({ code: "rate_limited" });
    auth.clock.advance(1);
    expect(
      (await requestEmailChange(auth.config, { session: s1, newEmail: "n7@example.com" })).ok,
    ).toBe(true);
  });

  it("allows 3 requests per new address in 15 minutes, whoever asks, after the per-user key", async () => {
    const auth = totpAuth();
    const users = await Promise.all(
      ["a", "b", "c", "d"].map((x) => verifiedSession(auth, `${x}@example.com`)),
    );
    const allow = vi.spyOn(auth.config.limiter, "allow");
    for (const s of users.slice(0, 3))
      expect((await requestEmailChange(auth.config, { session: s, newEmail: NEW })).ok).toBe(true);
    const last = users[3];
    if (!last) throw new Error("no user");
    expect(await requestEmailChange(auth.config, { session: last, newEmail: NEW })).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
    expect(allow.mock.calls.slice(-2)).toEqual([
      [`email-change:user:${last.user.id}`, { seconds: 3600, max: 5 }],
      [`email-change:email:${NEW}`, { seconds: 900, max: 3 }],
    ]);
    expect((await requestEmailChange(auth.config, { session: last, newEmail: OTHER })).ok).toBe(
      true,
    );
    auth.clock.advance(15 * 60_000 - 1);
    const fresh = await verifiedSession(auth, "d@example.com");
    expect(await requestEmailChange(auth.config, { session: fresh, newEmail: NEW })).toMatchObject({
      code: "rate_limited",
    });
    auth.clock.advance(1);
    expect((await requestEmailChange(auth.config, { session: fresh, newEmail: NEW })).ok).toBe(
      true,
    );
  });

  it("allows 20 link confirms per IP in 15 minutes, on the IP key", async () => {
    const auth = totpAuth();
    const allow = vi.spyOn(auth.config.limiter, "allow");
    const confirm = (ip: string | null) =>
      confirmEmailChange(auth.config, { token: `ec_${"A".repeat(43)}`, ip, userAgent: null });
    for (let i = 0; i < 20; i++)
      expect(await confirm("1.2.3.4")).toMatchObject({ code: "invalid_token" });
    expect(await confirm("1.2.3.4")).toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(allow).toHaveBeenLastCalledWith("email-change-confirm:ip:1.2.3.4", {
      seconds: 900,
      max: 20,
    });
    expect(await confirm("::ffff:1.2.3.4")).toMatchObject({ code: "rate_limited" });
    expect(await confirm("5.6.7.8")).toMatchObject({ code: "invalid_token" });
    await confirm(null);
    expect(allow).toHaveBeenLastCalledWith("email-change-confirm:ip:unknown", {
      seconds: 900,
      max: 20,
    });
    auth.clock.advance(15 * 60_000 - 1);
    expect(await confirm("1.2.3.4")).toMatchObject({ code: "rate_limited" });
    auth.clock.advance(1);
    expect(await confirm("1.2.3.4")).toMatchObject({ code: "invalid_token" });
  });

  it("counts a code verify on the shared verify keys of the new address", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    const allow = vi.spyOn(auth.config.limiter, "allow");
    await verifyEmailChange(auth.config, {
      session: me,
      code: "123456",
      ip: "1.2.3.4",
      userAgent: null,
    });
    // With no request, there is no new address: the IP key only.
    expect(allow.mock.calls).toEqual([["otp-verify:ip:1.2.3.4", { seconds: 900, max: 30 }]]);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    allow.mockClear();
    await verifyEmailChange(auth.config, {
      session: me,
      code: "123456",
      ip: "1.2.3.4",
      userAgent: null,
    });
    expect(allow.mock.calls).toEqual([
      ["otp-verify:ip:1.2.3.4", { seconds: 900, max: 30 }],
      [`otp-verify:email:${NEW}`, { seconds: 900, max: 10 }],
    ]);
  });

  it("counts no try for a stale session, an unverified user, a bad address, or a bad method", async () => {
    const auth = totpAuth({ emailOtp: false });
    const me = await verifiedSession(auth);
    const allow = vi.spyOn(auth.config.limiter, "allow");
    const calls = [
      { session: { ...me, user: { ...me.user, emailVerified: false } }, newEmail: NEW },
      { session: me, newEmail: "bad" },
      { session: me, newEmail: EMAIL },
      { session: me, newEmail: NEW, method: "code" as const },
      { session: me, newEmail: NEW, method: "x" as never },
      { session: { ...me, session: { ...me.session, freshAt: null } }, newEmail: NEW },
    ];
    for (let round = 0; round < 6; round++)
      for (const c of calls) expect((await requestEmailChange(auth.config, c)).ok).toBe(false);
    expect(allow).not.toHaveBeenCalled();
  });
});

describe("no oracle for a taken address (plan 12a)", () => {
  it.each(["link", "code"] as const)(
    "answers a taken address as an untaken one by %s: the status, the body, the keys, the writes, and one mail to it",
    async (method) => {
      const answer = async (taken: boolean) => {
        const auth = totpAuth();
        const handle = createRouter(auth.config, coreRoutes(auth.config));
        const me = await verifiedSession(auth);
        if (taken) await verifiedSession(auth, NEW);
        const before = auth.mail.length;
        const allow = vi.spyOn(auth.config.limiter, "allow");
        const writes: string[] = [];
        for (const op of ["create", "update", "delete"] as const) {
          const orig = auth.config.storage[op].bind(auth.config.storage);
          vi.spyOn(auth.config.storage, op).mockImplementation(((
            model: string,
            ...rest: never[]
          ) => {
            writes.push(`${op}:${model}`);
            return (orig as (...a: unknown[]) => unknown)(model, ...rest);
          }) as never);
        }
        const res = await handle(
          post(
            "/auth/user/change-email",
            { newEmail: NEW, method },
            { authorization: `Bearer ${me.token}` },
          ),
        );
        const keys = allow.mock.calls.map((c) => c[0].replace(me.user.id, "<id>"));
        vi.restoreAllMocks();
        const mails = auth.mail.slice(before);
        return {
          status: res.status,
          body: await res.json(),
          keys,
          writes,
          to: mails.map((m) => m.to),
        };
      };
      const free = await answer(false);
      const taken = await answer(true);
      expect(free).toMatchObject({
        status: 200,
        body: { sent: true },
        keys: ["email-change:user:<id>", `email-change:email:${NEW}`],
        to: [NEW],
      });
      expect(free.writes).toContain("create:verification");
      expect(taken).toEqual(free);
    },
  );

  // The reviewer's probe P1 (review M1): the verify after the request must not tell either.
  it("answers the code verify of a taken address as a free one: the answers and the limiter keys of six wrong guesses", async () => {
    const run = async (taken: boolean) => {
      const auth = totpAuth();
      const me = await verifiedSession(auth);
      if (taken) await verifiedSession(auth, NEW);
      codes.fixed = "444444";
      try {
        expect(
          (await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" }))
            .ok,
        ).toBe(true);
      } finally {
        codes.fixed = null;
      }
      const allow = vi.spyOn(auth.config.limiter, "allow");
      const answers: string[] = [];
      for (let i = 0; i < 6; i++) {
        const v = await verifyEmailChange(auth.config, {
          session: me,
          code: "000001",
          ip: "7.7.7.7",
          userAgent: null,
        });
        answers.push(v.ok ? "ok" : v.code);
      }
      const keys = allow.mock.calls.map((c) => c[0]);
      allow.mockRestore();
      return { answers, keys };
    };
    const free = await run(false);
    const taken = await run(true);
    expect(free.answers).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "too_many_attempts",
      "too_many_attempts",
    ]);
    expect(free.keys).toContain(`otp-verify:email:${NEW}`);
    expect(taken).toEqual(free);
  });
});

describe("the change-of-address routes (plan 12a)", () => {
  async function setup(extra: Parameters<typeof totpAuth>[0] = {}) {
    const auth = totpAuth(extra);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const me = await verifiedSession(auth);
    const bearer = { authorization: `Bearer ${me.token}` };
    return { auth, handle, me, bearer };
  }
  const form = (body: Record<string, string>) =>
    new Request(`${BASE_URL}/auth/user/change-email/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
      body: new URLSearchParams(body).toString(),
    });

  it("POST /user/change-email: the answer and every error status", async () => {
    const { auth, handle, me, bearer } = await setup();
    const call = (body: unknown, headers: Record<string, string> = bearer) =>
      handle(post("/auth/user/change-email", body, headers));
    const ok = await call({ newEmail: NEW });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sent: true });
    for (const body of [
      {},
      { newEmail: NEW, extra: 1 },
      { newEmail: 5 },
      { newEmail: "bad" },
      { newEmail: NEW, method: "sms" },
    ]) {
      const r = await call(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_body" });
    }
    expect((await call({ newEmail: NEW }, {})).status).toBe(401);
    auth.clock.advance(DAY);
    const stale = await call({ newEmail: NEW });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "session_not_fresh" });
    const fresh = await verifiedSession(auth);
    const b2 = { authorization: `Bearer ${fresh.token}` };
    // The day moved past the hour of the first call, so 5 new calls fill the key.
    for (let i = 0; i < 5; i++)
      expect((await call({ newEmail: `x${i}@example.com` }, b2)).status).toBe(200);
    const limited = await call({ newEmail: "x9@example.com" }, b2);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(fresh.user.id).toBe(me.user.id);
    const off = await setup({ emailOtp: false });
    const nf = await off.handle(
      post("/auth/user/change-email", { newEmail: NEW, method: "code" }, off.bearer),
    );
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not_found" });
  });

  it("GET /user/change-email/confirm: a malformed token goes to the error page, and account.confirmPage replaces the page", async () => {
    const { handle } = await setup({
      account: { confirmPage: (i) => `<p>${i.action}|${i.token}|${i.appName}</p>` },
    });
    const bad = await handle(get("/auth/user/change-email/confirm?token=nope"));
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe("https://api.example.com/?auth_error=invalid_token");
    const token = `ec_${"B".repeat(43)}`;
    const page = await handle(get(`/auth/user/change-email/confirm?token=${token}`));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(
      `<p>/auth/user/change-email/confirm|${token}|api.example.com</p>`,
    );
  });

  it("POST /user/change-email/confirm: JSON answers the user or the error, and a form goes to next or the error page", async () => {
    const { auth, handle, me } = await setup();
    const json = (token: unknown) => handle(post("/auth/user/change-email/confirm", { token }));
    const noToken = await handle(post("/auth/user/change-email/confirm", {}));
    expect(noToken.status).toBe(400);
    expect(await noToken.json()).toEqual({ error: "invalid_token" });
    const noForm = await handle(form({}));
    expect(noForm.headers.get("location")).toBe(
      "https://api.example.com/?auth_error=invalid_token",
    );
    const unknown = await handle(form({ token: `ec_${"C".repeat(43)}` }));
    expect(unknown.status).toBe(302);
    expect(unknown.headers.get("location")).toBe(
      "https://api.example.com/?auth_error=invalid_token",
    );
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    const moved = await json(token);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({
      user: { id: me.user.id, email: NEW, emailVerified: true, name: null, image: null },
    });
    expect(moved.headers.get("set-cookie")).toBeNull();
    const spent = await json(token);
    expect(spent.status).toBe(400);
    expect(await spent.json()).toEqual({ error: "invalid_token" });
    // A taken address: 409 by JSON, the error page by a form.
    const s = await verifiedSession(auth, NEW);
    await requestEmailChange(auth.config, { session: s, newEmail: OTHER });
    const t2 = linkOf(auth, OTHER);
    await unverifiedUser(auth, OTHER);
    const taken = await json(t2);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "email_taken" });
    const takenForm = await handle(form({ token: t2 }));
    expect(takenForm.headers.get("location")).toBe(
      "https://api.example.com/?auth_error=email_taken",
    );
    // An old link: 400 token_expired.
    await requestEmailChange(auth.config, { session: s, newEmail: "z@example.com" });
    const t3 = linkOf(auth, "z@example.com");
    auth.clock.advance(15 * 60_000);
    const old = await json(t3);
    expect(old.status).toBe(400);
    expect(await old.json()).toEqual({ error: "token_expired" });
    for (let i = 0; i < 20; i++) await json(`ec_${"D".repeat(43)}`);
    const limited = await json(`ec_${"D".repeat(43)}`);
    expect(limited.status).toBe(429);
  });

  it("POST /user/change-email/confirm: a form lands on appURL for an app path, and on baseURL for an auth path", async () => {
    const { auth, handle, me } = await setup({ appURL: "https://app.example.com" });
    for (const [next, landing] of [
      ["/settings", "https://app.example.com/settings"],
      ["/auth/handoff/continue?x=1", `${BASE_URL}/auth/handoff/continue?x=1`],
    ] as const) {
      const s = await resolveSession(auth.config, me.token);
      if (!s) throw new Error("no session");
      const target = next === "/settings" ? NEW : OTHER;
      await requestEmailChange(auth.config, { session: s, newEmail: target, next });
      const res = await handle(form({ token: linkOf(auth, target) }));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(landing);
    }
    const bad = await handle(form({ token: `ec_${"E".repeat(43)}` }));
    expect(bad.headers.get("location")).toBe("https://app.example.com/?auth_error=invalid_token");
  });

  it("POST /user/change-email/confirm: a hook refusal answers 403 with its message, and a throw 500", async () => {
    let mode: "refuse" | "throw" = "refuse";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth, handle, me } = await setup({
      hooks: {
        user: {
          beforeUpdate: () => {
            if (mode === "refuse") throw hookRefusal("No.");
            throw new Error("boom");
          },
        },
      },
    });
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    const refused = await handle(post("/auth/user/change-email/confirm", { token }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "hook_refused", message: "No." });
    mode = "throw";
    const failedRes = await handle(post("/auth/user/change-email/confirm", { token }));
    expect(failedRes.status).toBe(500);
    expect(await failedRes.json()).toEqual({ error: "hook_failed" });
  });

  it("POST /user/change-email/verify: the answer and every error status, and no route with emailOtp off", async () => {
    const { auth, handle, me, bearer } = await setup();
    const call = (body: unknown, headers: Record<string, string> = bearer) =>
      handle(post("/auth/user/change-email/verify", body, headers));
    expect((await call({ code: "123456" }, {})).status).toBe(401);
    for (const body of [{}, { code: "" }, { code: "1", extra: 1 }]) {
      const r = await call(body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_body" });
    }
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    const code = codeTo(auth, NEW);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await call({ code: wrong });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_code" });
    const moved = await call({ code });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({
      user: { id: me.user.id, email: NEW, emailVerified: true, name: null, image: null },
    });
    const off = await setup({ emailOtp: false });
    const absent = await off.handle(post("/auth/user/change-email/verify", { code }, off.bearer));
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "not_found" });
  });

  it("POST /user/change-email/verify: too_many_attempts, email_taken, and rate_limited", async () => {
    const { auth, handle, me, bearer } = await setup();
    const call = (code: string) => handle(post("/auth/user/change-email/verify", { code }, bearer));
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    const code = codeTo(auth, NEW);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await call(wrong);
    const capped = await call(wrong);
    expect(capped.status).toBe(400);
    expect(await capped.json()).toEqual({ error: "too_many_attempts" });
    await requestEmailChange(auth.config, { session: me, newEmail: OTHER, method: "code" });
    const c2 = codeTo(auth, OTHER);
    await unverifiedUser(auth, OTHER);
    const taken = await call(c2);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "email_taken" });
    // otp-verify:email of the new address takes 10 in 15 minutes: the taken call and 9 more.
    for (let i = 0; i < 9; i++) expect((await call(wrong)).status).toBe(400);
    const limited = await call(wrong);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("sends the renewed cookie on the request and the verify when the read slides the expiry", async () => {
    const { auth, handle, me } = await setup();
    // At the sliding refresh, and past the fresh window: the request answers 403 with the cookie.
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    const cookie = { cookie: `${auth.config.cookieName}=${me.token}` };
    const renewed = (r: Response) =>
      expect(r.headers.getSetCookie().join("\n")).toContain(
        `${auth.config.cookieName}=${me.token};`,
      );
    const stale = await handle(post("/auth/user/change-email", { newEmail: NEW }, cookie));
    expect(stale.status).toBe(403);
    renewed(stale);
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    const bad = await handle(post("/auth/user/change-email", { role: "x" }, cookie));
    expect(bad.status).toBe(400);
    renewed(bad);
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    const verify = await handle(post("/auth/user/change-email/verify", { code: "123456" }, cookie));
    expect(verify.status).toBe(400);
    renewed(verify);
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    const badVerify = await handle(post("/auth/user/change-email/verify", {}, cookie));
    expect(badVerify.status).toBe(400);
    renewed(badVerify);
  });
});

describe("api.user and the config of the change of address (plan 12a)", () => {
  it("serves changeEmail, confirmEmailChange, and verifyEmailChange on the engine calls", async () => {
    const auth = totpAuth();
    const api = createAuth({
      baseURL: BASE_URL,
      secret: SECRET,
      trustedOrigins: [],
      storage: auth.config.storage,
      mail: auth.config.mail,
      clock: auth.clock,
    }).api;
    const me = await verifiedSession(auth);
    expect((await api.user.changeEmail({ session: me, newEmail: NEW })).ok).toBe(true);
    expect(
      await api.user.confirmEmailChange({ token: linkOf(auth, NEW), ip: null, userAgent: null }),
    ).toMatchObject({ ok: true, value: { user: { email: NEW }, next: "/" } });
    const s = await verifiedSession(auth, NEW);
    expect((await api.user.changeEmail({ session: s, newEmail: OTHER, method: "code" })).ok).toBe(
      true,
    );
    expect(
      await api.user.verifyEmailChange({
        session: s,
        code: codeTo(auth, OTHER),
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: true, value: { user: { email: OTHER } } });
  });

  it("escapes the default page, and refuses an account.confirmPage that is no function", () => {
    const html = defaultEmailChangePage({ action: '/a"b', token: "t<x>", appName: "A&B" });
    expect(html).toContain('action="/a&quot;b"');
    expect(html).toContain('value="t&lt;x&gt;"');
    expect(html).toContain("Confirm your new email address for A&amp;B");
    expect(html).not.toContain("<script");
    expect(() => totpAuth({ account: { confirmPage: "x" } as never })).toThrow(
      new ConfigError("account.confirmPage must be a function"),
    );
    expect(() => totpAuth({ account: { confirm: () => "" } as never })).toThrow(
      new ConfigError(
        "account.confirm is not an option; core has mail, notices, confirmPage, delete",
      ),
    );
  });
});

describe("the logs of the change of address (plan 12a)", () => {
  it("writes no log line with a token, a code, a link, or an address", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let rounds = 0;
    let mode: "throw" | "conflict" | "pass" = "throw";
    const auth = hooked(
      (read) => ({
        beforeUpdate: async (e) => {
          if (mode === "throw") throw new Error(`${NEW} ${EMAIL}`);
          if (mode === "conflict") {
            rounds++;
            await read().storage.update("user", byId(e.user.id), {
              name: `R${rounds}`,
              updatedAt: later(read().clock.now(), e.user.updatedAt),
            });
          }
        },
        afterUpdate: () => {
          throw new Error(`${NEW} ${EMAIL}`);
        },
      }),
      {
        account: {
          notices: {
            mail: () => {
              throw new Error(`${NEW} ${EMAIL}`);
            },
          },
        },
      },
    );
    const me = await verifiedSession(auth);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const token = linkOf(auth, NEW);
    await confirmEmailChange(auth.config, { token, ip: null, userAgent: null });
    mode = "conflict";
    await confirmEmailChange(auth.config, { token, ip: null, userAgent: null });
    mode = "pass";
    expect((await confirmEmailChange(auth.config, { token, ip: null, userAgent: null })).ok).toBe(
      true,
    );
    const s = await verifiedSession(auth, NEW);
    await requestEmailChange(auth.config, { session: s, newEmail: OTHER, method: "code" });
    const code = codeTo(auth, OTHER);
    await verifyEmailChange(auth.config, { session: s, code: "000001", ip: null, userAgent: null });
    await verifyEmailChange(auth.config, { session: s, code, ip: null, userAgent: null });
    const lines = log.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines)
      for (const secret of [token, code, NEW, EMAIL, OTHER, "token=", "@"])
        expect(line, line).not.toContain(secret);
  });
});
