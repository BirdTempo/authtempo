import { describe, expect, it } from "vitest";
import type { AuthConfig, ResolvedConfig } from "../src/config.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { continueHandoff, startHandoff } from "../src/engine/handoff.js";
import type { HooksConfig } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { operatorApi } from "../src/engine/operator/index.js";
import {
  CONFIRM_LOST_DETAIL,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial } from "../src/engine/social.js";
import { confirmUserInvite } from "../src/engine/user-invite.js";
import { MAILED_CODES_PER_EMAIL_DAY } from "../src/engine/verification.js";
import type { AuthEvent } from "../src/observe/port.js";
import { randomBase64Url, sha256Base64Url } from "../src/primitives/crypto.js";
import type { Result } from "../src/result.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { d1Like } from "./d1-like.js";
import { tokenFromMail } from "./helpers.js";
import { FAST, sessionOnly, upSession } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  googleClaims,
  socialAuth,
  startGoogle,
} from "./social-helpers.js";

// Plan 12o on the memory store. A mailbox proof is final (decision 10). A
// lost flip mails a new proof of its kind (decision 11). Every row comes
// from a real flow. The memory store keeps a claim after `keep`, as D1 does.

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";
const D1_REFUSAL = "Too many API requests by single worker invocation.";

/** The verify points and the session ends, in order. */
function recorded() {
  const verify: string[] = [];
  const ended: { id: string; reason: string }[] = [];
  const hooks: HooksConfig = {
    user: {
      beforeVerify: (e) => void verify.push(`before:${e.via}`),
      afterVerify: (e) => void verify.push(`after:${e.via}`),
    },
    // A listener of `afterEnd`: the claim reads its sessions and ends them by `deleteRows`.
    session: { afterEnd: (e) => void ended.push({ id: e.session.id, reason: e.reason }) },
  };
  return { verify, ended, hooks };
}

function world(extra: Partial<AuthConfig> = {}) {
  const r = recorded();
  const tokens: Record<string, FakeIdToken> = {};
  const auth = socialAuth(
    {
      hooks: r.hooks,
      password: { hash: FAST, uniformSignUp: false },
      handoff: { schemes: ["consumera://"] },
      ...extra,
    },
    fakeJwt(tokens),
  );
  return { ...r, auth, tokens };
}
type World = ReturnType<typeof world>;

/** The newest mail of a subject start to the address. */
const newest = (w: World, subject: string) =>
  w.auth.mail.findLast((m) => m.to === EMAIL && m.subject.startsWith(subject));

/** The count of the mails of a subject start to the address. */
const mailsOf = (w: World, subject: string) =>
  w.auth.mail.filter((m) => m.to === EMAIL && m.subject.startsWith(subject)).length;

const CONFIRM = "Confirm your email";
const MAGIC = "Sign in to";
const CODE = "Your sign-in code";

function verifyLink(
  config: ResolvedConfig,
  w: World,
  token = tokenFromMail(newest(w, CONFIRM)?.text ?? ""),
) {
  return verifyPasswordEmail(config, { token, ip: null, userAgent: null });
}

async function magicLink(config: ResolvedConfig, w: World, ask = true) {
  if (ask) await requestMagicLink(config, { email: EMAIL, ip: null });
  return verifyMagicLink(config, {
    token: tokenFromMail(newest(w, MAGIC)?.text ?? ""),
    ip: null,
    userAgent: null,
  });
}

async function emailCode(config: ResolvedConfig, w: World, ask = true) {
  if (ask) await requestEmailOtp(config, { email: EMAIL, ip: null });
  const code = /\b(\d{6})\b/.exec(newest(w, CODE)?.text ?? "")?.[1] ?? "";
  return verifyEmailOtp(config, { email: EMAIL, code, ip: null, userAgent: null });
}

async function google(w: World, claims: Record<string, unknown> = {}) {
  const s = await startGoogle(w.auth);
  w.tokens["idtok-default"] = googleClaims(s.nonce, claims);
  return completeSocial(w.auth.config, {
    provider: "google",
    state: s.state,
    code: "c",
    error: null,
    bindToken: s.bindToken,
    ip: null,
    userAgent: null,
  });
}

async function resetLink(w: World, config: ResolvedConfig = w.auth.config) {
  await requestPasswordReset(config, { email: EMAIL, ip: null });
  return resetPassword(config, {
    token: tokenFromMail(w.auth.mail.at(-1)?.text ?? ""),
    password: "a new long password",
    ip: null,
    userAgent: null,
  });
}

/** A handoff code minted for the claimant's browser session. */
async function handoffCode(w: World, token: string) {
  const me = await resolveSession(w.auth.config, token);
  if (!me) throw new Error("no session");
  const h = await startHandoff(w.auth.config, {
    challenge: await sha256Base64Url(randomBase64Url(32)),
    redirect: "consumera://auth",
    ip: null,
  });
  if (!h.ok) throw new Error(h.code);
  const c = await continueHandoff(w.auth.config, {
    handoffId: h.value.handoffId,
    userId: me.user.id,
    sessionId: me.session.id,
  });
  if (!c.ok) throw new Error(c.code);
}

/** The claimant of a password sign-up: a password row, two sessions, and a handoff code. */
async function passwordClaimant(w: World) {
  const up = await passwordSignUp(w.auth.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!up.ok) throw new Error(up.code);
  const s = await sessionOnly(
    passwordSignIn(w.auth.config, { email: EMAIL, password: PASSWORD, ip: null, userAgent: null }),
  );
  if (!s.ok) throw new Error(s.code);
  await handoffCode(w, upSession(up.value).token);
}

/** The claimant of a Google sign-in with an unverified address: an identity, a session, and a handoff code. */
async function socialClaimant(w: World) {
  const g = await google(w, { email_verified: false, sub: "g-claimant" });
  if (!g.ok) throw new Error(g.code);
  await handoffCode(w, (g.value as { token: string }).token);
}

/** The operator tool, for an invitation and a ban (plans 12f and 12f2). */
const OPERATOR: Partial<AuthConfig> = {
  operator: {
    users: true,
    secrets: [{ name: "support", secretHash: "e".repeat(64), scopes: ["users"] }],
  },
};
const APP_ACTOR = { kind: "app", name: "support-tool" } as const;

/** An invited user: the operator creates the address, and the link goes out. Answers its token. */
async function invited(w: World): Promise<string> {
  const made = await operatorApi(w.auth.config).users.create({
    actor: APP_ACTOR,
    email: EMAIL,
    reason: "Ticket 1",
    ip: null,
    userAgent: null,
  });
  if (!made.ok) throw new Error(made.code);
  return tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
}

/** The rows of the user that a claim must remove, read on the store. */
async function rowsOf(w: World) {
  const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
  if (!user) throw new Error("no user");
  const byUser = [{ field: "userId" as const, op: "eq" as const, value: user.id }];
  const codes = async (purpose: string) =>
    (
      await w.auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: purpose },
        { field: "identifier", op: "eq", value: user.id },
      ])
    ).map((r) => r.id);
  return {
    user,
    sessions: (await w.auth.storage.findMany("session", byUser)).map((r) => r.id).sort(),
    identities: (await w.auth.storage.findMany("identity", byUser))
      .filter((r) => r.provider !== "email")
      .map((r) => r.id)
      .sort(),
    emailIdentities: (await w.auth.storage.findMany("identity", byUser)).filter(
      (r) => r.provider === "email",
    ).length,
    passwords: (await w.auth.storage.findMany("password", byUser)).map((r) => r.id).sort(),
    passkeys: (await w.auth.storage.findMany("passkey", byUser)).length,
    challenges: (await codes("passkey-challenge")).length,
    handoffCodes: (await codes("handoff-code")).length,
  };
}

/**
 * The next transaction throws at its session insert after it called `keep`:
 * the error that D1 throws at query 51. So the throw comes after the claim
 * is final.
 */
function throwAfterKeep(storage: StorageAdapter) {
  const original = storage.transaction.bind(storage);
  const seen = { kept: 0, thrown: 0 };
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
    original((tx) => {
      let kept = false;
      return fn({
        ...tx,
        keep: async () => {
          kept = true;
          seen.kept++;
          return tx.keep();
        },
        create: async (m, d) => {
          if (kept && seen.thrown === 0 && m === "session") {
            seen.thrown++;
            throw new Error(D1_REFUSAL);
          }
          return tx.create(m, d);
        },
      });
    });
  return seen;
}

describe("a throw after keep leaves the claimant no way in (Review Focus 1 of plan 12o)", () => {
  const PROOFS: {
    name: string;
    via: string;
    claimant: (w: World) => Promise<void>;
    run: (w: World) => Promise<Result<unknown>>;
    /** The password row that the proof keeps: the confirmed one, the reset's, or none. */
    password: "confirmed" | "reset" | "none";
    /** True when the proof is the claimant's own identity: the claim keeps that identity. */
    ownIdentity?: true;
  }[] = [
    {
      name: "the verify link",
      via: "password_verify",
      claimant: passwordClaimant,
      run: (w) => verifyLink(w.auth.config, w),
      password: "confirmed",
    },
    {
      name: "a magic link",
      via: "magic_link",
      claimant: passwordClaimant,
      run: (w) => magicLink(w.auth.config, w),
      password: "none",
    },
    {
      name: "an email code",
      via: "email_otp",
      claimant: passwordClaimant,
      run: (w) => emailCode(w.auth.config, w),
      password: "none",
    },
    {
      name: "a Google sign-in with a verified address",
      via: "social",
      claimant: passwordClaimant,
      run: (w) => google(w),
      password: "none",
    },
    {
      name: "a reset",
      via: "password_reset",
      claimant: passwordClaimant,
      run: resetLink,
      password: "reset",
    },
    {
      name: "a magic link of the claimant of a Google identity",
      via: "magic_link",
      claimant: socialClaimant,
      run: (w) => magicLink(w.auth.config, w),
      password: "none",
    },
    {
      // The branch of a known identity: the claim, `keep`, the `email` identity, `keep` (L2 of the 12o review).
      name: "a Google sign-in through the claimant's own identity, now with a verified address",
      via: "social",
      claimant: socialClaimant,
      run: (w) => google(w, { sub: "g-claimant" }),
      password: "none",
      ownIdentity: true,
    },
  ];

  for (const proof of PROOFS)
    it(`keeps the claim of ${proof.name}, ends every way in of the claimant, and fires the after points on the error`, async () => {
      const w = world();
      await proof.claimant(w);
      const before = await rowsOf(w);
      expect(before.user.emailVerified).toBe(false);
      expect(before.sessions.length).toBeGreaterThan(0);
      expect(before.handoffCodes).toBe(1);
      const seen = throwAfterKeep(w.auth.storage);
      await expect(proof.run(w)).rejects.toThrow(D1_REFUSAL);
      expect(seen).toEqual({ kept: seen.kept, thrown: 1 });
      expect(seen.kept).toBeGreaterThan(0);
      const after = await rowsOf(w);
      // The flag stays true, and the claimant holds nothing.
      expect(after.user.emailVerified).toBe(true);
      expect(after.sessions).toEqual([]);
      // The proving identity stays. Every other identity of the claimant goes.
      expect(after.identities.filter((id) => before.identities.includes(id))).toEqual(
        proof.ownIdentity ? before.identities : [],
      );
      // The `email` identity comes before the last `keep`, so it stays once (L2 of the 12o review).
      expect(before.emailIdentities).toBe(0);
      expect(after.emailIdentities).toBe(1);
      expect(after.passkeys).toBe(0);
      expect(after.challenges).toBe(0);
      expect(after.handoffCodes).toBe(0);
      if (proof.password === "none") expect(after.passwords).toEqual([]);
      else expect(after.passwords).toEqual(before.passwords);
      if (proof.password !== "none") {
        // The confirm keeps the sign-up's password; the reset's hash replaced the claimant's.
        const old = await passwordSignIn(w.auth.config, {
          email: EMAIL,
          password: PASSWORD,
          ip: null,
          userAgent: null,
        });
        expect(old.ok).toBe(proof.password === "confirmed");
      }
      // The claim committed, so its after points fired on the error answer (decision 10).
      expect(w.verify).toEqual([`before:${proof.via}`, `after:${proof.via}`]);
      expect(w.ended.filter((e) => before.sessions.includes(e.id))).toEqual(
        before.sessions.map((id) => ({ id, reason: "claim" })),
      );
    });

  // An invited user holds no session, so this row has a case of its own (L2 of the 12o review).
  it("keeps the claim of an invitation link, with its spend and its email identity, and fires the after points on the error", async () => {
    const w = world(OPERATOR);
    const token = await invited(w);
    const before = await rowsOf(w);
    expect(before.user.emailVerified).toBe(false);
    expect(before.emailIdentities).toBe(0);
    const seen = throwAfterKeep(w.auth.storage);
    const confirm = () => confirmUserInvite(w.auth.config, { token, ip: null, userAgent: null });
    await expect(confirm()).rejects.toThrow(D1_REFUSAL);
    expect(seen).toEqual({ kept: 1, thrown: 1 });
    const after = await rowsOf(w);
    expect(after.user.emailVerified).toBe(true);
    expect(after.sessions).toEqual([]);
    // The `email` identity and the spend come before the claim's `keep`, so both stay.
    expect(after.emailIdentities).toBe(1);
    expect(await confirm()).toMatchObject({ ok: false, code: "invalid_token" });
    expect(w.verify).toEqual(["before:invite", "after:invite"]);
  });
});

/**
 * The claim runs on the D1 view of the memory store (`d1Like`). The view has
 * no transaction lock. So an operator ban of the user runs on the store
 * between the claim's `keep` and its session insert, as another invocation
 * does. `writeSession` then reads the ban and stops the flow with
 * `account_banned`. That is an error answer after a kept claim, not a throw.
 */
function banAfterKeep(w: World) {
  const cfg = d1Like(w.auth.config);
  const view = cfg.storage;
  const original = view.transaction.bind(view);
  const seen = { kept: 0, banned: 0 };
  view.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
    original((tx) => {
      let kept = false;
      return fn({
        ...tx,
        keep: async () => {
          kept = true;
          seen.kept++;
          return tx.keep();
        },
        create: async (m, d) => {
          if (kept && seen.banned === 0 && m === "session") {
            seen.banned++;
            const user = await w.auth.storage.findOne("user", [
              { field: "email", op: "eq", value: EMAIL },
            ]);
            if (!user) throw new Error("no user");
            const r = await operatorApi(w.auth.config).users.ban({
              actor: APP_ACTOR,
              userId: user.id,
              reason: "Abuse report 1",
              ip: null,
              userAgent: null,
            });
            if (!r.ok) throw new Error(r.code);
          }
          return tx.create(m, d);
        },
      });
    });
  return { cfg, seen };
}

describe("an error answer after keep fires the claim's after points once (L1 of the 12o review)", () => {
  const FLOWS: {
    name: string;
    via: string;
    /** Makes the claimant. Answers the invitation token, or null. */
    claimant: (w: World) => Promise<string | null>;
    run: (cfg: ResolvedConfig, w: World, token: string | null) => Promise<Result<unknown>>;
  }[] = [
    {
      name: "the verify link",
      via: "password_verify",
      claimant: async (w) => {
        await passwordClaimant(w);
        return null;
      },
      run: (cfg, w) => verifyLink(cfg, w),
    },
    {
      name: "a magic link",
      via: "magic_link",
      claimant: async (w) => {
        await passwordClaimant(w);
        return null;
      },
      run: (cfg, w) => magicLink(cfg, w),
    },
    {
      name: "a reset",
      via: "password_reset",
      claimant: async (w) => {
        await passwordClaimant(w);
        return null;
      },
      run: (cfg, w) => resetLink(w, cfg),
    },
    {
      name: "an invitation link",
      via: "invite",
      claimant: invited,
      run: (cfg, _w, token) =>
        confirmUserInvite(cfg, { token: token ?? "", ip: null, userAgent: null }),
    },
  ];

  for (const f of FLOWS)
    it(`${f.name}: a ban between keep and the session write answers account_banned, and the kept claim fires each after point once`, async () => {
      const w = world(OPERATOR);
      const token = await f.claimant(w);
      const before = await rowsOf(w);
      expect(before.user.emailVerified).toBe(false);
      const race = banAfterKeep(w);
      expect(await f.run(race.cfg, w, token)).toEqual({
        ok: false,
        code: "account_banned",
        status: 403,
      });
      expect(race.seen.banned).toBe(1);
      expect(race.seen.kept).toBeGreaterThan(0);
      const after = await rowsOf(w);
      // The claim stays, and the stop undid the session insert.
      expect(after.user.emailVerified).toBe(true);
      expect(after.sessions).toEqual([]);
      expect(after.emailIdentities).toBe(1);
      // The claim committed, so its after points fired once on the error answer (decision 10).
      expect(w.verify).toEqual([`before:${f.via}`, `after:${f.via}`]);
      expect(w.ended.filter((e) => before.sessions.includes(e.id))).toEqual(
        before.sessions.map((id) => ({ id, reason: "claim" })),
      );
    });
});

/**
 * A lost flip on the D1 view of the memory store (`d1Like`). It has no
 * transaction lock. Its undo writes back a column only while the column
 * holds the written value, as on D1. At the flip of the next claim, `winner` claims the user
 * first, as a commit of another invocation does. The view claims a query
 * limit per invocation, as D1 does, so the loser answers 409 with no claim
 * retry.
 */
function loseNextFlip(w: World, winner: (cfg: ResolvedConfig) => Promise<Result<unknown>>) {
  const cfg = d1Like(w.auth.config);
  const view = cfg.storage;
  view.queryLimitPerInvocation = true;
  const original = view.transaction.bind(view);
  const state = { armed: true, won: null as Result<unknown> | null };
  view.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
    original((tx) =>
      fn({
        ...tx,
        update: async (m, where, d) => {
          if (
            state.armed &&
            m === "user" &&
            (d as { emailVerified?: unknown }).emailVerified === true &&
            where.some((x) => x.field === "emailVerified")
          ) {
            state.armed = false;
            state.won = await winner(cfg);
          }
          return tx.update(m, where, d);
        },
      }),
    );
  return {
    cfg,
    state,
    /** Arms the next flip again. */
    rearm: () => {
      state.armed = true;
      state.won = null;
    },
  };
}

/** The session of a winner's answer, for the account delete of the next round. */
function sessionToken(won: Result<unknown> | null): string {
  if (!won?.ok) throw new Error(`the winner answered ${won ? won.code : "nothing"}`);
  const v = won.value as { token?: string; signedIn?: { token: string } | null };
  const token = v.token ?? v.signedIn?.token;
  if (!token) throw new Error("the winner opened no session");
  return token;
}

const FALLBACKS: {
  name: string;
  subject: string;
  /** The per-address limit of the kind in one window: the most mails of a loop of races. */
  limit: number;
  /**
   * The races of five rounds. A round needs a live proof of the kind. The
   * account delete of a round removes the pending proofs of the address, so
   * each round asks for one. The confirm gets one from each sign-up. The
   * magic link and the code ask, until the limit refuses.
   */
  races: number;
  /** Asks for a proof of the kind. */
  ask: (w: World) => Promise<unknown>;
  /** The flow that loses its flip, with the newest proof of the kind. */
  lose: (cfg: ResolvedConfig, w: World) => Promise<Result<unknown>>;
  /** The proof that claims first. */
  win: (cfg: ResolvedConfig, w: World) => Promise<Result<unknown>>;
}[] = [
  {
    name: "the magic link",
    subject: MAGIC,
    // PER_EMAIL of magic-link.ts: the request and the new link count on it.
    limit: 5,
    races: 3,
    ask: (w) => requestMagicLink(w.auth.config, { email: EMAIL, ip: null }),
    lose: (cfg, w) => magicLink(cfg, w, false),
    win: (cfg, w) => verifyLink(cfg, w),
  },
  {
    name: "the email code",
    subject: CODE,
    // REQUEST_PER_EMAIL of email-otp.ts: the request and the new code count on it.
    limit: 3,
    races: 2,
    ask: (w) => requestEmailOtp(w.auth.config, { email: EMAIL, ip: null }),
    lose: (cfg, w) => emailCode(cfg, w, false),
    win: (cfg, w) => verifyLink(cfg, w),
  },
];

describe("a lost flip mails a new proof of its kind (decision 11 of plan 12o)", () => {
  for (const f of FALLBACKS) {
    it(`${f.name}: answers 409 conflict and mails one new proof`, async () => {
      const w = world();
      await passwordClaimant(w);
      await f.ask(w);
      const race = loseNextFlip(w, (cfg) => f.win(cfg, w));
      const spent = newest(w, f.subject)?.text;
      const mails = mailsOf(w, f.subject);
      expect(await f.lose(race.cfg, w)).toEqual({ ok: false, code: "conflict", status: 409 });
      expect(race.state.armed).toBe(false);
      expect(race.state.won?.ok).toBe(true);
      // The winner mails no proof of this kind, so the one new mail is the loser's.
      expect(mailsOf(w, f.subject)).toBe(mails + 1);
      expect(newest(w, f.subject)?.text).not.toBe(spent);
      // The winner's claim stays.
      expect((await rowsOf(w)).user.emailVerified).toBe(true);
    });

    it(`${f.name}: a loop of five rounds of races mails at most the per-address limit of the kind (Review Focus 2)`, async () => {
      const w = world();
      const race = loseNextFlip(w, (cfg) => f.win(cfg, w));
      let races = 0;
      let byRaces = 0;
      let used: string | undefined;
      for (let round = 0; round < 5; round++) {
        // A new claimant each round: the round before ended with an account delete.
        await passwordClaimant(w);
        await f.ask(w);
        // A full limit sends no proof, and the loop ends.
        if (newest(w, f.subject)?.text === used) break;
        used = newest(w, f.subject)?.text;
        race.rearm();
        const before = mailsOf(w, f.subject);
        expect(await f.lose(race.cfg, w)).toEqual({ ok: false, code: "conflict", status: 409 });
        races++;
        byRaces += mailsOf(w, f.subject) - before;
        // The winner signed in: its fresh session deletes the account for the next round.
        const me = await resolveSession(w.auth.config, sessionToken(race.state.won));
        if (!me) throw new Error("no session");
        expect(
          (await deleteAccount(w.auth.config, { session: me, ip: null, userAgent: null })).ok,
        ).toBe(true);
      }
      expect(races).toBe(f.races);
      // The mails of the kind in the window are the limit, never more. They
      // are the new proofs of the races, and the requests of the kind.
      expect(byRaces).toBeGreaterThan(0);
      expect(mailsOf(w, f.subject)).toBe(f.limit);
    });
  }

  it("the sign-up confirm: answers 409 conflict with a detail that says to sign in, and mails nothing (ruling 23 of plan 12o)", async () => {
    const w = world();
    await passwordClaimant(w);
    const race = loseNextFlip(w, (cfg) => magicLink(cfg, w));
    const mails = w.auth.mail.length;
    expect(await verifyLink(race.cfg, w)).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
      detail: CONFIRM_LOST_DETAIL,
    });
    expect(race.state.won?.ok).toBe(true);
    // The magic link of the winner is the one new mail: no confirm mail goes.
    expect(w.auth.mail.slice(mails).map((m) => m.subject.startsWith(MAGIC))).toEqual([true]);
    expect(mailsOf(w, CONFIRM)).toBe(1);
    expect((await rowsOf(w)).user.emailVerified).toBe(true);
  });
});

describe("the limits and the failure of the new proof (ruling 23 of plan 12o)", () => {
  it("the email code: a full day key sends no new code, while the 15-minute key has room", async () => {
    const w = world();
    await passwordClaimant(w);
    // The day key allows MAILED_CODES_PER_EMAIL_DAY codes. The 15-minute key
    // allows 3, so the clock moves on after each 3 requests.
    const day = MAILED_CODES_PER_EMAIL_DAY.max;
    for (let i = 0; i < day; i++) {
      if (i > 0 && i % 3 === 0) w.auth.clock.advance(15 * 60_000 + 1);
      expect((await requestEmailOtp(w.auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    }
    expect(mailsOf(w, CODE)).toBe(day);
    // No more request here: the last window holds 2 of 3 requests, so the
    // 15-minute key has room for the new code.
    expect(day % 3).toBe(2);
    const race = loseNextFlip(w, (cfg) => magicLink(cfg, w));
    expect(await emailCode(race.cfg, w, false)).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(race.state.won?.ok).toBe(true);
    // The 15-minute key held 2 of 3, so only the day key refuses the new code.
    expect(mailsOf(w, CODE)).toBe(day);
  });

  const FAILS: {
    name: string;
    method: string;
    ask: (w: World) => Promise<unknown>;
    lose: (cfg: ResolvedConfig, w: World) => Promise<Result<unknown>>;
  }[] = [
    {
      name: "the magic link",
      method: "magic_link",
      ask: (w) => requestMagicLink(w.auth.config, { email: EMAIL, ip: null }),
      lose: (cfg, w) => magicLink(cfg, w, false),
    },
    {
      name: "the email code",
      method: "email_otp",
      ask: (w) => requestEmailOtp(w.auth.config, { email: EMAIL, ip: null }),
      lose: (cfg, w) => emailCode(cfg, w, false),
    },
  ];

  for (const f of FAILS)
    it(`${f.name}: a throw of the mail port at the new proof emits claim.mail_failed, and the answer stays 409`, async () => {
      const batches: AuthEvent[] = [];
      const w = world({ observe: { sink: { write: (b) => void batches.push(...b) } } });
      await passwordClaimant(w);
      await f.ask(w);
      const race = loseNextFlip(w, (cfg) => verifyLink(cfg, w));
      // Only the loser's config has the failing port: the winner's flow mails as usual.
      const failing: ResolvedConfig = {
        ...race.cfg,
        mail: {
          ...race.cfg.mail,
          send: async () => {
            throw new TypeError("mail down");
          },
        },
      };
      expect(await f.lose(failing, w)).toEqual({ ok: false, code: "conflict", status: 409 });
      expect(race.state.won?.ok).toBe(true);
      await w.auth.config.observe.flush();
      const failed = batches.filter((e) => e.name === "claim.mail_failed");
      expect(failed.map((e) => ({ method: e.method, errorName: e.errorName }))).toEqual([
        { method: f.method, errorName: "TypeError" },
      ]);
      expect(JSON.stringify(failed)).not.toContain(EMAIL);
    });
});
