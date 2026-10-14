import type { CaptchaPage, CaptchaPort } from "@authtempo/core";

/**
 * Cloudflare Turnstile behind core's captcha port (plan 12b). No runtime
 * dependency. The facts are from Cloudflare's pages "Validate the token"
 * (last updated 2026-09-16), "Embed the widget" (2026-06-17), and "Content
 * Security Policy" (2026-05-05), read 2026-10-14.
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** "The api.js file must be fetched from the exact URL shown above." */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";
/** script-src and frame-src, from the CSP page. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
/** "Maximum length: 2048 characters." */
const TOKEN_MAX = 2048;
const SITE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface TurnstileOptions {
  /** The widget's secret key. Never in a log line. */
  secretKey: string;
  /** The site key. With it, core's sign-in page shows the widget. */
  siteKey?: string;
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  /** One deadline over the call and its retry, 500 to 10000 ms. Default 3000: "Set reasonable timeouts." */
  timeoutMs?: number;
  /** The widget's `action`. A token of another action fails. */
  expectedAction?: string;
  /** The hostnames that may serve the widget. A token from another fails. */
  allowedHostnames?: string[];
}

type Answer = "pass" | "fail" | "unavailable";

export function createTurnstileCaptcha(options: TurnstileOptions): CaptchaPort {
  const { secretKey, siteKey, expectedAction, allowedHostnames } = options;
  if (typeof secretKey !== "string" || secretKey.length === 0)
    throw new Error("authtempo captcha-turnstile: secretKey must be a non-empty string");
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000)
    throw new Error("authtempo captcha-turnstile: timeoutMs must be an integer from 500 to 10000");
  if (siteKey !== undefined && !SITE_KEY_RE.test(siteKey))
    throw new Error(
      "authtempo captcha-turnstile: siteKey must be 1 to 128 letters, digits, _, or -",
    );
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  /** One siteverify call: the parsed body, or null for no usable answer. */
  async function once(
    body: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    let res: Response;
    try {
      res = await fetchFn(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // No redirect: an answer that steers the call elsewhere is no answer.
        redirect: "manual",
        signal,
      });
    } catch (e) {
      console.error(
        "authtempo captcha-turnstile: siteverify failed",
        e instanceof Error ? e.name : typeof e,
      );
      return null;
    }
    if (res.status !== 200) {
      console.error("authtempo captcha-turnstile: siteverify answered", res.status);
      return null;
    }
    try {
      const parsed: unknown = await res.json();
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      console.error("authtempo captcha-turnstile: siteverify answer is not JSON");
      return null;
    }
  }

  const page: CaptchaPage | undefined =
    siteKey === undefined
      ? undefined
      : {
          scriptSrc: TURNSTILE_SCRIPT,
          // The site key passed SITE_KEY_RE, so it needs no escape in the attribute.
          widgetHtml: `<div class="cf-turnstile" data-sitekey="${siteKey}"></div>`,
          responseField: "cf-turnstile-response",
          cspSources: [TURNSTILE_ORIGIN],
        };

  return {
    ...(page ? { page } : {}),
    async verify({ token, ip }): Promise<Answer> {
      if (token.length > TOKEN_MAX) return "fail";
      const signal = AbortSignal.timeout(timeoutMs);
      // One key for the call and its retry: siteverify validates a token once.
      const body: Record<string, string> = {
        secret: secretKey,
        response: token,
        idempotency_key: crypto.randomUUID(),
        ...(ip ? { remoteip: ip } : {}),
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await once(body, signal);
        const codes = Array.isArray(answer?.["error-codes"])
          ? (answer["error-codes"] as unknown[])
          : [];
        // Retry once on no answer before the deadline, and on internal-error ("Retry the request").
        if ((answer === null && !signal.aborted) || codes.includes("internal-error")) continue;
        if (answer === null) return "unavailable";
        // A wrong or missing secret refuses every token. The answer stays
        // `fail`, so the flow stays closed, and the log line names the cause.
        if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret"))
          console.error("authtempo captcha-turnstile: siteverify refused the secret key");
        if (answer.success !== true) return "fail";
        if (expectedAction !== undefined && answer.action !== expectedAction) return "fail";
        if (allowedHostnames !== undefined && !allowedHostnames.includes(String(answer.hostname)))
          return "fail";
        return "pass";
      }
      return "unavailable";
    },
  };
}
