import { checkCaptcha } from "../captcha.js";
import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow, VerificationRow } from "../schema.js";
import { compareCode, issueCode } from "./email-otp.js";

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
 * checks, and the two per-number limits. The order follows `checkCaptcha`:
 * a request with no token spends no per-number key of a victim. Answers
 * the number that the config accepts.
 */
export async function phoneRequestGate(
  config: ResolvedConfig,
  input: { phone: string; ip: string | null; captchaToken?: string | null | undefined },
): Promise<Result<string>> {
  if (!config.phone) return fail("not_found");
  if (!(await limit(config, "phone-otp:ip", ipKey(input.ip), REQUEST_PER_IP)))
    return fail("rate_limited");
  const captcha = await checkCaptcha(config, "phone-request", input.captchaToken, input.ip);
  if (captcha) return captcha;
  // Before the per-number keys: a key trusts a number that the config accepts.
  const refused = phoneRefusal(config, input.phone);
  if (refused) return fail(refused);
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
  const cap = { seconds: CAP_WINDOW_SECONDS, max: phone.dailyCap };
  if (!(await limit(config, "phone-otp:all-day", CAP_SUBJECT, cap))) return "capped";
  const code = await issueCode(config, phone, input.purpose, input.identifier, input.data);
  try {
    // The builder runs inside the try: its throw answers as a failed send.
    const text = phone.message({ code, appName: config.appName, ttlMinutes: phone.ttlMinutes });
    // To the number of the code, whatever the builder wrote.
    return (await phone.sms.send({ to: input.to, text })) === "sent" ? "sent" : "unavailable";
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
