import type { ResolvedConfig } from "./config.js";
import { ERRORS } from "./errors.js";
import type { Result } from "./result.js";

/**
 * The captcha port (plan 12b). Core names no supplier: an adapter package
 * answers `verify`, and may describe its widget for core's sign-in page.
 */
export type CaptchaFlow =
  | "password-sign-up"
  | "password-sign-in"
  | "magic-link-request"
  | "email-otp-request"
  | "password-reset-request";

export const CAPTCHA_FLOWS: readonly CaptchaFlow[] = Object.freeze([
  "password-sign-up",
  "password-sign-in",
  "magic-link-request",
  "email-otp-request",
  "password-reset-request",
]);

/** The flows that send mail or write rows, so a bot costs the app money. The sign-in is opt-in. */
export const DEFAULT_CAPTCHA_FLOWS: readonly CaptchaFlow[] = Object.freeze([
  "password-sign-up",
  "magic-link-request",
  "email-otp-request",
  "password-reset-request",
]);

/** The header of the token: Better Auth's own, so a client that leaves Better Auth keeps its call. */
export const CAPTCHA_HEADER = "x-captcha-response";
/** Longer tokens answer `captcha_failed` with no call. A Turnstile token is at most 2048 characters (its siteverify page, 2026-10-14). */
export const CAPTCHA_TOKEN_MAX = 2048;

/** What core's sign-in page needs to show the widget. */
export interface CaptchaPage {
  /** The https URL of the widget's script. The page loads it under its nonce. */
  scriptSrc: string;
  /** The widget's markup, put in each gated form as given: the adapter owns it. */
  widgetHtml: string;
  /** The form field that the widget fills with the token. */
  responseField: string;
  /** The https origins that the page's policy adds to `script-src` and `frame-src`. */
  cspSources: string[];
}

export interface CaptchaPort {
  /** `unavailable`: the supplier gave no answer (a timeout, a 5xx, a body that is not JSON). A throw counts as `unavailable`. */
  verify(input: {
    token: string;
    ip: string | null;
    flow: CaptchaFlow;
  }): Promise<"pass" | "fail" | "unavailable">;
  page?: CaptchaPage;
}

export interface CaptchaConfig {
  port: CaptchaPort;
  /** Default `DEFAULT_CAPTCHA_FLOWS`. */
  flows?: CaptchaFlow[];
  /** Default `"allow"`: the owned limits still bound each flow. `"refuse"`: 503 `captcha_unavailable`. */
  onUnavailable?: "allow" | "refuse";
}

export interface ResolvedCaptcha {
  port: CaptchaPort;
  flows: ReadonlySet<CaptchaFlow>;
  onUnavailable: "allow" | "refuse";
  /** The checked copy of `port.page`, or null. The sign-in page reads this one. */
  page: Readonly<Omit<CaptchaPage, "cspSources"> & { cspSources: readonly string[] }> | null;
}

type Failure = Extract<Result<never>, { ok: false }>;

function refuse(code: "captcha_required" | "captcha_failed" | "captcha_unavailable"): Failure {
  return { ok: false, code, status: ERRORS[code] };
}

/**
 * The check of one gated flow (plan 12b). Null: the flow goes on.
 *
 * The order in every flow: the per-IP limit, then this check, then every
 * per-email limit, the policy and the breach check, and the first read. The
 * per-IP limit bounds the calls to the supplier. A request with no token
 * must not spend a victim address's per-email limit, which would block the
 * mail to that address, and must not cost a breach-range call. Before the
 * first read, the refusal is the same for every address.
 *
 * `token` undefined is an in-process call, which skips the check; null or
 * "" is a request with no header.
 */
export async function checkCaptcha(
  config: ResolvedConfig,
  flow: CaptchaFlow,
  token: string | null | undefined,
  ip: string | null,
): Promise<Failure | null> {
  const captcha = config.captcha;
  if (!captcha?.flows.has(flow) || token === undefined) return null;
  if (token === null || token === "") return refuse("captcha_required");
  if (token.length > CAPTCHA_TOKEN_MAX) return refuse("captcha_failed");
  let answer: "pass" | "fail" | "unavailable";
  try {
    answer = await captcha.port.verify({ token, ip, flow });
  } catch (e) {
    config.observe.emit({ name: "captcha.port_threw", flow, errorName: e });
    answer = "unavailable";
  }
  if (answer === "pass") return null;
  if (answer === "fail") return refuse("captcha_failed");
  if (captcha.onUnavailable === "refuse") return refuse("captcha_unavailable");
  config.observe.emit({ name: "captcha.no_answer", flow });
  return null;
}
