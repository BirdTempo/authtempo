/**
 * The form of the operator secret (plan 11c): 32 to 512 visible ASCII
 * characters. The operator route and `authtempo keys rotate` read this one
 * rule, so the CLI refuses a value before it costs one of the five calls per
 * hour. The entry `@authtempo/core/operator-secret` exports it, outside the
 * main entry: it is for the CLI, not for an app. The entry exports the
 * limits of the operator routes that the CLI prints too.
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
 * (plan 12f, spec 26 item 12). 600 per IP per hour, with a right or a
 * wrong secret. A support script that pages through 50 000 users at 100
 * per page needs 500 calls. A guess costs one count of 600. The CLI prints
 * this value (ruling 10 of plan 12f).
 */
export const OPERATOR_USERS_PER_IP = { seconds: 3600, max: 600 };

/**
 * The limit of each operator secret on the user, session, and audit routes
 * (ruling 38 of plan 12f): 600 calls per hour after the secret matches,
 * from any address. The count per IP bounds the guesses. This count bounds
 * a stolen secret: at 100 users a page it reads at most 60 000 users an
 * hour, from any number of addresses.
 */
export const OPERATOR_USERS_PER_SECRET = { seconds: 3600, max: 600 };
