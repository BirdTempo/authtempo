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
 * The user pool must accept the email as USERNAME (email as a username
 * attribute or an alias).
 *
 * A password longer than core's policy (128 code points) never reaches
 * Cognito: core refuses it before it asks the old system. Such a user cannot
 * sign in with the old password and must reset it.
 *
 * The check never logs or stores the password. It sends it only in the
 * request body to Cognito.
 */
export interface CognitoLegacyVerifyOptions {
  /** For example "eu-west-1". */
  region: string;
  clientId: string;
  /** Needed when the app client has a secret: Cognito then wants SECRET_HASH. */
  clientSecret?: string;
  /**
   * Challenge names that count as a right password. Default none. Cognito
   * asks for a challenge only after it checked the password, so a name here
   * signs the user in without that challenge: an MFA name drops the user's
   * second factor, which tempo-auth does not carry over (plan 9f).
   */
  acceptChallenges?: readonly string[];
  /** Default: the global fetch. Tests inject one. */
  fetch?: typeof fetch;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

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

/** Resolves `false` when `signal` aborts, so a fetch that ignores the signal cannot hold the check. */
function abortedAnswer(signal: AbortSignal): { answer: Promise<false>; stop: () => void } {
  let stop = () => {};
  const answer = new Promise<false>((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    stop = () => signal.removeEventListener("abort", onAbort);
  });
  return { answer, stop };
}

/**
 * `true` only for a 2xx answer with an AuthenticationResult object, or with
 * a challenge name in `acceptChallenges`. Every other outcome answers
 * `false`: a refusal (NotAuthorizedException, UserNotFoundException,
 * UserNotConfirmedException, PasswordResetRequiredException; InitiateAuth
 * errors, read 2026-10-11), any other non-2xx (TooManyRequestsException, a
 * 5xx), a malformed answer, a network error, and an abort of `signal` (core
 * aborts it at its timeout). Core turns a throw into invalid_credentials
 * too, but this check answers `false` itself.
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
  const url = `https://cognito-idp.${options.region}.amazonaws.com/`;
  const accept = new Set(options.acceptChallenges ?? []);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function ask(email: string, password: string, signal: AbortSignal): Promise<boolean> {
    try {
      const params: Record<string, string> = { USERNAME: email, PASSWORD: password };
      if (options.clientSecret !== undefined)
        params.SECRET_HASH = await secretHash(options.clientSecret, email + options.clientId);
      const res = await fetchFn(url, {
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
      if (!res.ok) return false;
      const body: unknown = await res.json();
      if (!isObject(body)) return false;
      if (isObject(body.AuthenticationResult)) return true;
      if (typeof body.ChallengeName === "string") return accept.has(body.ChallengeName);
      return false;
    } catch {
      // A network error, an abort, or a body that is not JSON.
      return false;
    }
  }

  return async (email, password, signal) => {
    // An aborted signal sends no request, so the password does not leave.
    if (signal.aborted) return false;
    const aborted = abortedAnswer(signal);
    try {
      return await Promise.race([ask(email, password, signal), aborted.answer]);
    } finally {
      aborted.stop();
    }
  };
}
