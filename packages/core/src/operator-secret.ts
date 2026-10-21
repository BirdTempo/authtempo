import { hasRefusedChar } from "./primitives/text.js";

/**
 * The form of the operator secret (plan 11c): 32 to 512 visible ASCII
 * characters. The operator route and `authtempo keys rotate` read this one
 * rule, so the CLI refuses a value before it costs one of the five calls per
 * hour. The entry `@authtempo/core/operator-secret` exports it, outside the
 * main entry: it is for the CLI, not for an app. The entry also exports the
 * limits of the operator routes, which the CLI prints. It exports the text
 * rules of the operator tools too, which the CLI checks before a request (plan 12f
 * ruling 40). It imports `primitives/text.ts` only, so the CLI loads no
 * engine module.
 */
export const OPERATOR_SECRET = /^[\x21-\x7e]{32,512}$/;

/** True when `value` has the form of an operator secret. */
export function isOperatorSecret(value: string): boolean {
  return OPERATOR_SECRET.test(value);
}

/**
 * The limit of the key rotation (plan 11c): 5 calls per IP per hour,
 * right or wrong secret, in the app's limiter. A rotation is rare, so the
 * sixth call of an hour waits, and a guess costs one count of five.
 */
export const OPERATOR_PER_IP = { seconds: 3600, max: 5 };

/**
 * The limit of the secret routes and the info route (plan 11c2). 120 per IP
 * per hour for status, rewrap, and info, with a right or a wrong secret. A
 * rewrap of 100 000 rows at 1000 rows per call needs 100 calls; the 5 per
 * hour of keys/rotate would take 20 hours. A guess costs one count of 120,
 * and the secret has at least 32 visible characters. Core's limiter and the
 * stop text and help of the CLI read this one value.
 */
export const OPERATOR_SECRETS_PER_IP = { seconds: 3600, max: 120 };

/**
 * The limit of every secret call to the user, session, and audit routes
 * (plan 12f, spec 26 item 12). It is 600 per IP per hour, with a right or
 * a wrong secret. A support script that pages through 50 000 users at 100
 * per page needs 500 calls. A guess costs one count of 600. The CLI prints
 * this value (ruling 10 of plan 12f).
 */
export const OPERATOR_USERS_PER_IP = { seconds: 3600, max: 600 };

/**
 * The limit of each operator secret on the user, session, and audit routes
 * (ruling 38 of plan 12f). It allows 600 calls per hour after the secret
 * matches, from any IP. The count per IP bounds the guesses. This count bounds
 * a stolen secret: at 100 users a page it reads at most 60 000 users an
 * hour, from any number of IPs.
 */
export const OPERATOR_USERS_PER_SECRET = { seconds: 3600, max: 600 };

/**
 * The longest reason of an operator act, in UTF-16 code units (spec 26
 * item 5). A reason is a short note for a later reader of the audit row,
 * not a document. The engine and the CLI read this one value.
 */
export const REASON_MAX = 500;

/**
 * True when a reason passes the rule of spec 26 item 5: 1 to `REASON_MAX`
 * UTF-16 code units, with no character of `hasRefusedChar`. That is the
 * class of the user name: no control character, line or paragraph
 * separator, lone surrogate, or format character except U+200C and U+200D
 * (plan 12f, final review m5). A space and U+00A0 (Zs) pass. The CLI
 * states the same class in `REASON_RULE` (ruling 66). The engine
 * (`operatorReason`) and the CLI check with this one function.
 */
export function isOperatorReason(value: string): boolean {
  return value.length > 0 && value.length <= REASON_MAX && !hasRefusedChar(value);
}

/** How the operator proved the identity of the person (spec 26 item 5). */
export const PROOF_METHODS = ["document", "in_person", "video", "knowledge", "other"] as const;

/**
 * The oldest proof that a disable of the second factor accepts: 7 days.
 * ASVS 5.0.0 6.4.4: "Verify that if a multi-factor authentication factor is
 * lost, evidence of identity proofing is performed at the same level as
 * during enrollment." An old check is not evidence of the person who asks now.
 */
export const PROOF_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * The longest proof reference, in UTF-16 code units. The reference is the
 * case id in the app's own system, never the evidence: the audit table must
 * hold no personal document.
 */
export const REFERENCE_MAX = 200;
