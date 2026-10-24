import { PROVIDER_NAME_RE } from "../social/provider.js";

/**
 * The values of the last method (plan 12i Task 12, spec 32 item 11), with
 * `social:<provider>` beside them. The set is closed: the cookie and the
 * JSON `via` hold one of these and nothing else. A value names a method,
 * never an account, so the cookie is a hint for the sign-in page only.
 * `phone` is the value of the phone routes (Task 5) and of the password
 * sign-in by phone. The anonymous sign-in has no value: it is no method.
 */
export const LAST_METHODS = [
  "password",
  "username",
  "phone",
  "magic_link",
  "email_otp",
  "passkey",
] as const;

export type LastMethod = (typeof LAST_METHODS)[number] | `social:${string}`;

const NAMED: ReadonlySet<string> = new Set(LAST_METHODS);

/** A value of the closed set. A challenge row is storage, so its value is read through this guard. */
export function isLastMethod(value: unknown): value is LastMethod {
  if (typeof value !== "string") return false;
  if (NAMED.has(value)) return true;
  return value.startsWith("social:") && PROVIDER_NAME_RE.test(value.slice("social:".length));
}

/** The value of a social sign-in. */
export function socialMethod(provider: string): LastMethod {
  return `social:${provider}`;
}

/** The value of a password sign-in by its identifier: `password` for an address. */
export function passwordMethod(by: { username?: string; phone?: string }): LastMethod {
  if (by.username !== undefined) return "username";
  return by.phone !== undefined ? "phone" : "password";
}
