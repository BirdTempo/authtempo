import { checkCaptcha } from "../captcha.js";
import type { ResolvedConfig, ResolvedPhone } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow, VerificationRow } from "../schema.js";
import { StorageError, type Where } from "../storage/port.js";
import { handleProved } from "./address.js";
import { createSteps } from "./create-steps.js";
import { compareCode, consumeCode, issueCode } from "./email-otp.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import { guardedRemove } from "./identities.js";
import { sendNotice } from "./notices.js";
import { unchanged } from "./profile.js";
import {
  gatedSteps,
  later,
  type Opened,
  ROUNDS,
  type TwoFactorPending,
  touchTrust,
} from "./second-factor.js";
import { challengeOpened, type ResolvedSession, sessionOpened } from "./sessions.js";
import { draftUserRow } from "./users.js";

/**
 * The phone code (plan 12i, spec 32 items 4 and 5). The SMS port only sends
 * text. Core draws the code as it draws an email code, keys its hash under
 * the current secret version, binds it to its identifier and purpose,
 * counts each guess by compare-and-set, and counts every send against the
 * daily cap of the deployment. So no supplier keeps a promise of core.
 */

/** A phone number in E.164: a plus sign, no leading zero, and 8 to 15 digits. */
export const PHONE_RE = /^\+[1-9][0-9]{7,14}$/;

export type PhoneCodePurpose = "phone-otp" | "phone-add-otp";

// Per 15 minutes and per 24 hours (spec 32 item 5). The request limits run
// before the branch on a known or an unknown number, so a 429 tells nothing
// about an account. 3 codes per number at `maxAttempts` 3 bound the guesses
// on one number: at most 30 a day with the 24-hour key.
const REQUEST_PER_IP = { seconds: 900, max: 10 };
const REQUEST_PER_PHONE = { seconds: 900, max: 3 };
const REQUEST_PER_PHONE_DAY = { seconds: 86_400, max: 10 };
// Per 15 minutes, for every check of a code.
const VERIFY_PER_IP = { seconds: 900, max: 30 };
const VERIFY_PER_PHONE = { seconds: 900, max: 10 };
// Per 15 minutes, per user: the codes and notes of `/phone/add` (spec 32 item 5).
const ADD_PER_USER = { seconds: 900, max: 3 };
// Per 24 hours, per number, over every user: the codes and notes of
// `/phone/add` (ruling 23 of plan 12i). The add has its own key, so an add
// by another account spends no sign-in key of the holder. The maximum is
// the day key of a request, so a number gets no more texts a day than before.
const ADD_PER_PHONE = { seconds: 86_400, max: 10 };
/** The window of the daily cap. The max is `phone.dailyCap`. */
const CAP_WINDOW_SECONDS = 86_400;
/** The subject of the daily cap: one count for the deployment. */
const CAP_SUBJECT = "deployment";

/** True when `phone` is E.164 and inside a prefix of `phone.regions`. False with phone off. */
export function inRegion(config: ResolvedConfig, phone: string): boolean {
  const regions = config.phone?.regions ?? [];
  return PHONE_RE.test(phone) && regions.some((prefix) => phone.startsWith(prefix));
}

/**
 * The form check, then the region check, of a number that a caller typed.
 * Null when the config accepts the number.
 */
export function phoneRefusal(
  config: ResolvedConfig,
  phone: string,
): "phone_invalid" | "phone_region" | null {
  if (!PHONE_RE.test(phone)) return "phone_invalid";
  return inRegion(config, phone) ? null : "phone_region";
}

/**
 * True when the stored phone of `user` signs in (ruling 15 of plan 12i).
 * Only with `phone` on, and only for a number that the config accepts, so
 * the phone code can reach it. Core writes a phone only after a code proved
 * it (Task 5); the compat package reads one only where Better Auth marks it
 * verified. The last-credential guard, the verified handle, and the
 * password sign-in by phone (`inRegion` there) hold this rule.
 */
export function phoneSignsIn(config: ResolvedConfig, user: UserRow): boolean {
  return config.phone !== null && user.phone !== null && inRegion(config, user.phone);
}

/**
 * The gate of a code request (spec 32 item 5), before the branch on a known
 * or an unknown number: the per-IP limit, the captcha, the form and region
 * checks, and the per-number limits. The order follows `checkCaptcha`: a
 * request with no token spends no per-number key of a victim. With `add`,
 * the per-number key is `phone-add:phone`, and the two sign-in keys stay
 * unspent (ruling 23 of plan 12i). Answers the number that the config accepts.
 */
export async function phoneRequestGate(
  config: ResolvedConfig,
  input: { phone: string; ip: string | null; captchaToken?: string | null | undefined },
  keys: "request" | "add" = "request",
): Promise<Result<string>> {
  if (!config.phone) return fail("not_found");
  if (!(await limit(config, "phone-otp:ip", ipKey(input.ip), REQUEST_PER_IP)))
    return fail("rate_limited");
  const captcha = await checkCaptcha(config, "phone-request", input.captchaToken, input.ip);
  if (captcha) return captcha;
  // Before the per-number keys: a key trusts a number that the config accepts.
  const refused = phoneRefusal(config, input.phone);
  if (refused) return fail(refused);
  if (keys === "add")
    return (await limit(config, "phone-add:phone", input.phone, ADD_PER_PHONE))
      ? ok(input.phone)
      : fail("rate_limited");
  if (!(await limit(config, "phone-otp:phone", input.phone, REQUEST_PER_PHONE)))
    return fail("rate_limited");
  if (!(await limit(config, "phone-otp:phone-day", input.phone, REQUEST_PER_PHONE_DAY)))
    return fail("rate_limited");
  return ok(input.phone);
}

/**
 * Sends one code to `to` and answers what happened. The order: the form
 * and region checks, then the daily cap, then the row, then the send. A
 * refused number gets no SMS. A send over the cap writes no row and makes
 * no call. A send that the port answers `"unavailable"` still counts: the
 * cap bounds the calls to the supplier, not the delivered texts. The
 * earlier live codes of the purpose and identifier are spent with the
 * write, so one code is live. The SMS goes after the row, never inside a
 * transaction. A throw of `phone.message` or of the port answers
 * `"unavailable"` with one `sms.port_threw` line. With `phone` off the
 * answer is `"unavailable"`.
 *
 * The identifier of a `phone-otp` code is the number; of a `phone-add-otp`
 * code, the user id, with the number in `data`.
 */
export async function sendPhoneCode(
  config: ResolvedConfig,
  input: {
    purpose: PhoneCodePurpose;
    identifier: string;
    to: string;
    data: Record<string, unknown>;
  },
): Promise<"sent" | "unavailable" | "capped" | "phone_invalid" | "phone_region"> {
  const phone = config.phone;
  if (!phone) return "unavailable";
  const refused = phoneRefusal(config, input.to);
  if (refused) return refused;
  // A sign-in code binds to its number (ASVS 5.0.0 6.6.2): a caller cannot send it elsewhere.
  if (input.purpose === "phone-otp" && input.identifier !== input.to)
    throw new Error("authtempo phone: a phone-otp code goes to its own number");
  return countedSend(config, phone, input.to, async () => {
    const code = await issueCode(config, phone, input.purpose, input.identifier, input.data);
    return () => phone.message({ code, appName: config.appName, ttlMinutes: phone.ttlMinutes });
  });
}

/**
 * The one send of an SMS in core (plan 12i Task 5). The daily cap counts
 * first: a refusal answers `"capped"`, runs no `prepare`, and makes no
 * call. Then `prepare` (the row of a code, or nothing for a note) and the
 * send. The text builder runs inside the try: its throw answers as a failed
 * send. A source test holds that no other call of `sms.send` exists, so
 * every SMS counts against the cap.
 */
async function countedSend(
  config: ResolvedConfig,
  phone: ResolvedPhone,
  to: string,
  prepare: () => Promise<() => string>,
): Promise<"sent" | "unavailable" | "capped"> {
  const cap = { seconds: CAP_WINDOW_SECONDS, max: phone.dailyCap };
  if (!(await limit(config, "phone-otp:all-day", CAP_SUBJECT, cap))) return "capped";
  const text = await prepare();
  try {
    // To the number of the caller, whatever the builder wrote.
    return (await phone.sms.send({ to, text: text() })) === "sent" ? "sent" : "unavailable";
  } catch (e) {
    // The line names the error, never the number or the text.
    config.observe.emit({ name: "sms.port_threw", errorName: e });
    return "unavailable";
  }
}

/**
 * Compares `code` with the live code of the identifier and purpose, after
 * the verify limits. A right code is not spent here: the caller spends it
 * with `consumeCode` in the transaction of its act, so a code is used once.
 * The compare is the email code's (`compareCode`): one keyed HMAC and one
 * constant-time compare on every path, and a wrong guess counted by
 * compare-and-set. No row, an expired row, and a spent row answer
 * `invalid_code`; a row that its cap spent answers `too_many_attempts`.
 */
export async function checkPhoneCode(
  config: ResolvedConfig,
  input: { purpose: PhoneCodePurpose; identifier: string; code: string; ip: string | null },
): Promise<Result<VerificationRow>> {
  const phone = config.phone;
  if (!phone) return fail("not_found");
  if (!(await limit(config, "phone-verify:ip", ipKey(input.ip), VERIFY_PER_IP)))
    return fail("rate_limited");
  // The identifier of a sign-in code is the number. An add code names the
  // user, whose fresh session and per-user limit bound its guesses.
  if (input.purpose === "phone-otp") {
    // No code goes to a number that is not E.164, and a key trusts the form.
    if (!PHONE_RE.test(input.identifier)) return fail("invalid_code");
    if (!(await limit(config, "phone-verify:phone", input.identifier, VERIFY_PER_PHONE)))
      return fail("rate_limited");
  }
  const now = config.clock.now();
  return compareCode(config, phone.maxAttempts, input.purpose, input.identifier, input.code, now);
}

/** The where of one stored phone. */
function byPhone(phone: string): Where<"user">[] {
  return [{ field: "phone", op: "eq", value: phone }];
}

/**
 * The answer of a route that sent an SMS. `"capped"` answers 429 and
 * `"unavailable"` 503 (spec 32 item 5). The form and region refusals come
 * from the gate first, so they reach here only as a guard.
 */
function sentAnswer(
  answer: "sent" | "unavailable" | "capped" | "phone_invalid" | "phone_region",
): Result<{ sent: true }> {
  if (answer === "sent") return ok({ sent: true });
  if (answer === "capped") return fail("rate_limited");
  if (answer === "unavailable") return fail("sms_unavailable");
  return fail(answer);
}

/** The text of the note to a number that another user holds. It holds no code. */
function takenNote(config: ResolvedConfig): string {
  return `This number is already in use with ${config.appName}.`;
}

export interface PhoneRequest {
  phone: string;
  ip: string | null;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
}

/**
 * `POST /phone/request` (spec 32 item 5). The gate runs first: the limits,
 * the captcha, and the form and region checks. So a 429 and a refusal tell
 * nothing about an account. Then one read by number. A known number gets a
 * code. An unknown number gets a code only with `phone.signUp`; else it
 * gets no SMS and the same `{ sent: true }`.
 *
 * With `after` (the route), the send runs after the answer: the cap, the
 * row, and the SMS (ruling 23 of plan 12i). So the answer time does not
 * tell whether a number has an account. A cap refusal or an outage then
 * becomes an `sms.not_sent` line, not a 429 or a 503. With no `after` (a
 * call in process), the send runs before the answer. A cap or an outage
 * then answers 429 or 503 only on a branch that sends.
 */
export async function requestPhone(
  config: ResolvedConfig,
  input: PhoneRequest,
  after?: (work: Promise<unknown>) => void,
): Promise<Result<{ sent: true }>> {
  const phone = config.phone;
  if (!phone) return fail("not_found");
  const gate = await phoneRequestGate(config, input);
  if (!gate.ok) return gate;
  const number = gate.value;
  const known = await config.storage.findOne("user", byPhone(number));
  if (!known && !phone.signUp) return ok({ sent: true });
  const send = { purpose: "phone-otp", identifier: number, to: number, data: {} } as const;
  if (!after) return sentAnswer(await sendPhoneCode(config, send));
  after(sendLater(config, send));
  return ok({ sent: true });
}

/**
 * A send after the answer (ruling 23 of plan 12i). No caller reads its
 * result, so a send that did not go out writes one `sms.not_sent` line
 * with the reason. A throw of the port has its `sms.port_threw` line too.
 */
async function sendLater(
  config: ResolvedConfig,
  input: Parameters<typeof sendPhoneCode>[1],
): Promise<void> {
  const answer = await sendPhoneCode(config, input);
  if (answer === "capped" || answer === "unavailable")
    config.observe.emit({ name: "sms.not_sent", reason: answer });
}

export interface PhoneVerify {
  phone: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
  /** The clear `td_` token of a trusted device (plan 12c): it skips the gate. */
  trustDevice?: string | undefined;
}

/** A sign-in by a phone code: the session token, the user, and the session row. */
export interface PhoneSession {
  token: string;
  user: UserRow;
  session: SessionRow;
}

/**
 * `POST /phone/verify` (spec 32 item 5). The check of the code, then one
 * transaction: the read by number, or with `phone.signUp` a new user with
 * no address. The sign-up rule and `user.beforeCreate` run on the draft
 * (`createSteps`). The gate of plan 12c (`totp.gate.phone`) and the session
 * hook run before the first write. Then the spend of the code, so a code
 * is used once and a refusal before it leaves the code live. A user with
 * the factor on gets the challenge, with no email method: the code proves
 * the phone, not the mailbox.
 */
export async function verifyPhone(
  config: ResolvedConfig,
  input: PhoneVerify,
): Promise<Result<PhoneSession | TwoFactorPending>> {
  if (!config.phone) return fail("not_found");
  const checked = await checkPhoneCode(config, {
    purpose: "phone-otp",
    identifier: input.phone,
    code: input.code,
    ip: input.ip,
  });
  if (!checked.ok) return checked;
  const row = checked.value;
  const now = config.clock.now();
  const steps = gatedSteps(
    config,
    {
      ip: input.ip,
      userAgent: input.userAgent,
      via: "phone",
      next: "/",
      trustDevice: input.trustDevice,
      gate: config.totp?.gate.phone ?? false,
    },
    now,
  );
  const made = createSteps(config, "phone", { signUpRule: true });
  const resolved = await hookGuard(async () =>
    ok(await resolvePhoneUser(config, input.phone, row, now, steps, made)),
  );
  if (!resolved.ok) return resolved;
  const { user, opened } = resolved.value;
  await made.after(user);
  if (opened.kind === "challenge") {
    challengeOpened(config, user, "phone");
    return ok(opened.pending);
  }
  await touchTrust(config, steps.trustId(), now);
  await sessionOpened(config, opened.session, user, "phone");
  return ok({ token: opened.token, user, session: opened.session });
}

/**
 * The transaction of `verifyPhone`. Every hook runs before the first write
 * (the D1 undo, `BeforeResolveWrite` in users.ts). Two parallel sign-ups of
 * one number race on the unique key of `phone`. The loser runs once more,
 * outside its failed transaction, and finds the winner.
 */
async function resolvePhoneUser(
  config: ResolvedConfig,
  phone: string,
  row: VerificationRow,
  now: Date,
  steps: ReturnType<typeof gatedSteps>,
  made: ReturnType<typeof createSteps>,
): Promise<{ user: UserRow; opened: Opened }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await config.storage.transaction(async (tx) => {
        made.begin();
        const found = await tx.findOne("user", byPhone(phone));
        // A code that went out with `signUp` on, and a config that turned it off since.
        if (!found && !config.phone?.signUp) stopWith("invalid_code");
        const user =
          found ??
          (await made.user(
            tx,
            draftUserRow({ email: null, emailVerified: false, name: null, phone }, now),
          ));
        await steps.before(tx, user);
        // The spend of the code, in the transaction of the act (ruling 20 of plan 12i).
        if (!(await consumeCode(tx, row, now)).ok) stopWith("invalid_code");
        if (!found) await tx.create("user", user);
        return { user, opened: await steps.write(tx) };
      });
    } catch (err) {
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        err.model === "user"
      )
        continue;
      throw err;
    }
  }
}

export interface PhoneAdd {
  session: ResolvedSession;
  phone: string;
  ip: string | null;
}

/**
 * `POST /phone/add` (spec 32 item 5). It needs a proved handle and a fresh
 * session, as the username does: the phone becomes a way in. The per-user
 * limit, then the gate of a request, run before the read by number. A free
 * number gets a code bound to the user, with the number in its row. A
 * number that another user holds gets a note with no code and the same
 * answer. The note counts against the daily cap as a code does.
 */
export async function addPhone(
  config: ResolvedConfig,
  input: PhoneAdd,
): Promise<Result<{ sent: true }>> {
  const phone = config.phone;
  if (!phone) return fail("not_found");
  const { user, session } = input.session;
  if (!(await handleProved(config, config.storage, user))) return fail("email_unverified");
  const fresh = requireFresh(config, session);
  if (!fresh.ok) return fresh;
  if (!(await limit(config, "phone-add:user", user.id, ADD_PER_USER))) return fail("rate_limited");
  // No captcha: the fresh session and the per-user limit bound the sends.
  // The add keys of the number spend no sign-in key of the number's holder.
  const gate = await phoneRequestGate(config, { phone: input.phone, ip: input.ip }, "add");
  if (!gate.ok) return gate;
  const number = gate.value;
  const holder = await config.storage.findOne("user", byPhone(number));
  // A taken number gets a decoy row and a note with no code. The writes are
  // the writes of a free number, so the time does not tell a held number (plan 12a).
  if (holder && holder.id !== user.id)
    return sentAnswer(
      await countedSend(config, phone, number, async () => {
        await issueCode(config, phone, "phone-add-otp", user.id, { phone: number, taken: true });
        return () => takenNote(config);
      }),
    );
  return sentAnswer(
    await sendPhoneCode(config, {
      purpose: "phone-add-otp",
      identifier: user.id,
      to: number,
      data: { phone: number },
    }),
  );
}

export interface PhoneAddVerify {
  session: ResolvedSession;
  code: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * `POST /phone/add/verify` (spec 32 item 5). It needs a proved handle and
 * a fresh session. The check of the code that `addPhone` sent comes next.
 * Then one transaction: the compare-and-set of the user row with the
 * number, then the spend of the code. The unique key of `phone` decides a
 * race of two users. The loser answers `phone_taken`. Its transaction spent
 * nothing, so its code stays live. The notice goes after the commit, to the
 * address when the user has one.
 */
export async function verifyAddPhone(
  config: ResolvedConfig,
  input: PhoneAddVerify,
): Promise<Result<{ phone: string }>> {
  if (!config.phone) return fail("not_found");
  const { user, session } = input.session;
  if (!(await handleProved(config, config.storage, user))) return fail("email_unverified");
  const fresh = requireFresh(config, session);
  if (!fresh.ok) return fresh;
  const checked = await checkPhoneCode(config, {
    purpose: "phone-add-otp",
    identifier: user.id,
    code: input.code,
    ip: input.ip,
  });
  if (!checked.ok) return checked;
  const row = checked.value;
  const data = row.data as { phone?: unknown; taken?: unknown } | null;
  const number = data?.phone;
  // Only `addPhone` writes the row, so a row with no number is damaged.
  if (typeof number !== "string" || !PHONE_RE.test(number)) return fail("invalid_code");
  // A decoy row answers as a wrong code. Its code went to no one.
  if (data?.taken === true) return fail("invalid_code");
  const written = await writePhone(config, user.id, number, row);
  if (!written.ok) return written;
  await runAfter(
    config.observe,
    "user.afterUpdate",
    config.hooks.user.afterUpdate,
    { user: written.value.user, previous: written.value.previous, via: "phone" },
    user.id,
  );
  await sendNotice(config, {
    event: "phone_changed",
    email: written.value.user.email,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ phone: number });
}

/**
 * The transaction of `verifyAddPhone`: the compare-and-set of the user row
 * with the number, then the spend of the code. `user.beforeUpdate` runs
 * before the write of each round, with no row lock held. A loser of the
 * unique key of `phone` answers `phone_taken`.
 */
async function writePhone(
  config: ResolvedConfig,
  userId: string,
  number: string,
  row: VerificationRow,
): Promise<Result<{ previous: UserRow; user: UserRow }>> {
  const now = config.clock.now();
  const hooks = config.hooks.user;
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  let written: Result<{ previous: UserRow; user: UserRow }>;
  try {
    written = await hookGuard(() =>
      config.storage.transaction(
        async (tx): Promise<Result<{ previous: UserRow; user: UserRow }>> => {
          let previous = await tx.findOne("user", byId);
          for (let round = 0; round < ROUNDS; round++) {
            if (!previous) return fail("unauthorized");
            await runBefore(config.observe, "user.beforeUpdate", hooks.beforeUpdate, {
              user: previous,
              patch: { phone: number },
              via: "phone",
            });
            // `updatedAt` moves past the read, so a later compare-and-set sees this write.
            const updatedAt = later(now, previous.updatedAt);
            const n = await tx.update("user", unchanged(previous), { phone: number, updatedAt });
            if (n === 1) {
              // After the phone write: a loser of the unique key spends no code.
              if (!(await consumeCode(tx, row, now)).ok) stopWith("invalid_code");
              return ok({ previous, user: { ...previous, phone: number, updatedAt } });
            }
            previous = await tx.findOne("user", byId);
          }
          config.observe.emit({ name: "phone.set_gave_up", userId });
          return fail("conflict");
        },
      ),
    );
  } catch (err) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (err instanceof StorageError && err.code === "unique_violation" && err.model === "user")
      return fail("phone_taken");
    throw err;
  }
  return written;
}

export interface PhoneRemove {
  session: ResolvedSession;
  ip: string | null;
  userAgent: string | null;
}

/**
 * `POST /phone/remove` (spec 32 item 5). A fresh session, then the removal
 * under the last-credential guard of plan 12a (`guardedRemove`): a user
 * whose phone is the last way in answers `last_credential`. A user with no
 * phone answers `not_found`. The notice goes after the commit.
 */
export async function removePhone(
  config: ResolvedConfig,
  input: PhoneRemove,
): Promise<Result<{ ok: true }>> {
  if (!config.phone) return fail("not_found");
  const { user, session } = input.session;
  const fresh = requireFresh(config, session);
  if (!fresh.ok) return fresh;
  const hooks = config.hooks.user;
  // The row before the remove, for `user.afterUpdate`.
  const seen: { previous: UserRow | null } = { previous: null };
  const removed = await guardedRemove(
    config,
    user.id,
    async (tx, held) => {
      if (held.phone === null) return 0;
      seen.previous = held;
      await runBefore(config.observe, "user.beforeUpdate", hooks.beforeUpdate, {
        user: held,
        patch: { phone: null },
        via: "phone",
      });
      return tx.update("user", [{ field: "id", op: "eq", value: held.id }], { phone: null });
    },
    { phone: null },
  );
  if (!removed.ok) return removed;
  if (seen.previous)
    await runAfter(
      config.observe,
      "user.afterUpdate",
      hooks.afterUpdate,
      { user: removed.value, previous: seen.previous, via: "phone" },
      user.id,
    );
  await sendNotice(config, {
    event: "phone_changed",
    email: removed.value.email,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ ok: true });
}
