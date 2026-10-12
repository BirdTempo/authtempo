import { encodeBase64 } from "./grammar.js";

/**
 * The old-system check for users imported from Amazon Cognito (spec 17.4).
 * Pass the answer to core's `password.legacyVerify.verify`. Request shape:
 * Cognito API reference, InitiateAuth and CreateUserPoolClient, read
 * 2026-10-11.
 *
 * Why this check exists: Cognito exports no password hash. That fact is
 * unverified in an AWS primary source. The AWS docs show no export API, and
 * only secondary sources (an AWS re:Post answer, the Cloudar blog) say that
 * hashes cannot be exported (plan 9b research item 1f).
 *
 * The app client must list ALLOW_USER_PASSWORD_AUTH in ExplicitAuthFlows.
 * The default client does not, and then every Cognito user fails to sign in.
 *
 * USERNAME is the email that the importer stored, in the lower case of core's
 * normalizeEmail, not the Cognito username (often an opaque id). The user pool
 * must accept the email as a sign-in name (email as a username attribute or
 * an alias). A pool that does not accept it answers `NotAuthorizedException`
 * (with `PreventUserExistenceErrors` `ENABLED`) or `UserNotFoundException`
 * (`LEGACY`) for every user; the default `onFailure` line names it (AWS docs,
 * read 2026-10-12). A pool with case-sensitive usernames
 * (UsernameConfiguration.CaseSensitive true, the default of older pools) can
 * refuse "ada@example.com" for a user stored as "Ada@Example.com". Unverified
 * whether the email alias follows that setting. Then each mixed-case user
 * answers false and must reset; the owner runbook (Task 20) checks one
 * mixed-case sign-in.
 *
 * Every challenge answers false. Cognito asks for a challenge only after the
 * password is right, but no challenge is safe to skip: an MFA challenge
 * (SMS_MFA, SOFTWARE_TOKEN_MFA) would drop the user's second factor, which
 * tempo-auth does not carry over (plan 9f), and NEW_PASSWORD_REQUIRED means
 * the password is a temporary one that an admin set and mailed. A user with
 * a challenge must reset the password in tempo-auth.
 *
 * A password longer than core's policy (128 code points) never reaches
 * Cognito: core refuses it before it asks the old system. Such a user cannot
 * sign in with the old password and must reset it.
 *
 * The check never logs or stores the password. It sends it only in the
 * request body to Cognito.
 */
export interface CognitoLegacyVerifyOptions {
  /** For example "eu-west-1". A "cn-" region uses the amazonaws.com.cn host. */
  region: string;
  clientId: string;
  /** Needed when the app client has a secret: Cognito then wants SECRET_HASH. */
  clientSecret?: string;
  /**
   * Called once for each failed check, with only the reason: the Cognito
   * error `__type` with its namespace removed (for example
   * "NotAuthorizedException", or "InvalidParameterException" for a client
   * without ALLOW_USER_PASSWORD_AUTH), or one of "timeout", "network",
   * "malformed", "challenge". It never gets the username or the password.
   *
   * Default: one `console.error` line, `COGNITO_FAILURE_LOG` and the reason.
   * Why a default (plan 9b2): every failure answers false, so a pool that does
   * not accept the email as a user name failed every imported user in
   * silence. An app that passes its own `onFailure` replaces the line.
   *
   * It runs after the answer, on a timer of 0 ms, so a slow callback cannot
   * move the answer time past core's floor, and the answer never waits for
   * it. A throw or a rejected promise from it is dropped. Pass `waitUntil`
   * so that Workers keeps the timer alive after the response.
   */
  // The return is `unknown`, not `void | Promise<void>`: that union refuses
  // a callback such as `(r) => list.push(r)`, which returns a number.
  onFailure?: (reason: string) => unknown;
  /**
   * The shape of `ExecutionContext.waitUntil`: `ctx.waitUntil.bind(ctx)` for
   * an app that builds its config per request, or `waitUntil` from
   * `cloudflare:workers` (Cloudflare changelog, 2025-08-08, read 2026-10-12).
   * The check passes it the `onFailure` call of each failure, and on a
   * "timeout" also the Cognito request still in flight. Without it, Workers
   * can drop both after the response, because on a timeout core answers at
   * once. A throw from it is dropped: the answer never changes.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Default: the global fetch. Tests inject one. */
  fetch?: typeof fetch;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** The default `onFailure` line, followed by one space and the reason. */
export const COGNITO_FAILURE_LOG = "tempo-auth: cognito legacy verify failed";
const logFailure = (reason: string) => console.error(`${COGNITO_FAILURE_LOG} ${reason}`);

async function secretHash(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
  );
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/**
 * Resolves when `signal` aborts later, so a fetch that ignores the signal
 * cannot hold the check. It never resolves for a signal that aborted before
 * the call: the abort event does not fire again. `ask` covers that case with
 * its `signal.aborted` check before the fetch, so do not remove that check.
 */
function onAbort(signal: AbortSignal): { aborted: Promise<void>; stop: () => void } {
  let stop = () => {};
  const aborted = new Promise<void>((resolve) => {
    const listener = () => resolve();
    signal.addEventListener("abort", listener, { once: true });
    stop = () => signal.removeEventListener("abort", listener);
  });
  return { aborted, stop };
}

/**
 * `true` only for a 2xx answer whose AuthenticationResult holds a non-empty
 * AccessToken and that has no ChallengeName. Every other outcome answers
 * `false` and calls `onFailure` once: a refusal (NotAuthorizedException,
 * UserNotFoundException, UserNotConfirmedException,
 * PasswordResetRequiredException; InitiateAuth errors, read 2026-10-11), any
 * other non-2xx (TooManyRequestsException, a 5xx), a challenge, a malformed
 * answer, a network error, and an abort of `signal` (core aborts it at its
 * timeout). Core turns a throw into invalid_credentials too, but this check
 * answers `false` itself.
 */
export function createCognitoLegacyVerify(
  options: CognitoLegacyVerifyOptions,
): (email: string, password: string, signal: AbortSignal) => Promise<boolean> {
  if (!REGION_RE.test(options.region))
    throw new Error(
      `tempo-auth legacy-hashes: cognito region ${options.region} is not a region name`,
    );
  if (options.clientId.length === 0)
    throw new Error("tempo-auth legacy-hashes: cognito clientId is empty");
  // The China partition has its own domain (AWS service endpoints, read 2026-10-11).
  const domain = options.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  const url = `https://cognito-idp.${options.region}.${domain}/`;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const onFailure = options.onFailure ?? logFailure;
  /** Hands a promise to `waitUntil`. A throw there (no request context) must not change the answer. */
  const keep = (promise: Promise<unknown>) => {
    try {
      options.waitUntil?.(promise);
    } catch {
      // The app's waitUntil threw; the work still runs, and Workers may drop it.
    }
  };
  const report = (reason: string) => {
    // A timer, not a microtask: the caller's continuation after the answer
    // runs first. The callback is the owner's; its error must not change the
    // answer or become an unhandled rejection.
    const done = new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          Promise.resolve(onFailure(reason))
            .catch(() => {})
            .finally(resolve);
        } catch {
          // A synchronous throw.
          resolve();
        }
      }, 0);
    });
    keep(done);
  };

  /** `true`, or the failure reason. */
  async function ask(email: string, password: string, signal: AbortSignal): Promise<true | string> {
    const params: Record<string, string> = { USERNAME: email, PASSWORD: password };
    if (options.clientSecret !== undefined)
      params.SECRET_HASH = await secretHash(options.clientSecret, email + options.clientId);
    // An aborted signal sends no request, so the password does not leave. The
    // check is after the secret hash, because the hash is async and an abort
    // can land during it.
    if (signal.aborted) return "timeout";
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          // The reference sample shows 1.0 and the SDKs send 1.1. Unverified
          // which one Cognito needs; the owner runbook (Task 20) checks it.
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
        },
        body: JSON.stringify({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: options.clientId,
          AuthParameters: params,
        }),
        signal,
      });
    } catch {
      return signal.aborted ? "timeout" : "network";
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return signal.aborted ? "timeout" : "malformed";
    }
    if (!res.ok) {
      // `__type` may carry a namespace prefix, for example "com.amazonaws...#NotAuthorizedException".
      const type = isObject(body) && typeof body.__type === "string" ? body.__type : "";
      return type.split("#").pop() || "malformed";
    }
    if (!isObject(body)) return "malformed";
    if (body.ChallengeName !== undefined) return "challenge";
    const result = body.AuthenticationResult;
    if (isObject(result) && typeof result.AccessToken === "string" && result.AccessToken !== "")
      return true;
    return "malformed";
  }

  return async (email, password, signal) => {
    const abort = onAbort(signal);
    try {
      const asked = ask(email, password, signal).catch(() => "malformed" as const);
      const answer = await Promise.race([asked, abort.aborted.then(() => "timeout" as const)]);
      if (answer === true) return true;
      // Core answers at once on a timeout; the request may still be in flight.
      if (answer === "timeout") keep(asked);
      report(answer);
      return false;
    } finally {
      abort.stop();
    }
  };
}
