/**
 * The form of the operator secret (plan 11c): 32 to 512 visible ASCII
 * characters. The operator route and `authtempo keys rotate` read this one
 * rule, so the CLI refuses a value before it costs one of the five calls per
 * hour. The entry `@authtempo/core/operator-secret` exports it, outside the
 * main entry: it is for the CLI, not for an app.
 */
export const OPERATOR_SECRET = /^[\x21-\x7e]{32,512}$/;

/** True when `value` has the form of an operator secret. */
export function isOperatorSecret(value: string): boolean {
  return OPERATOR_SECRET.test(value);
}
