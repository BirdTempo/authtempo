import { hasControlChar } from "../primitives/text.js";

/** Fixed. It bounds the CPU of one hash and the body a sign-in reads. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Null when the password is acceptable. The length is in code points and
 * nothing is trimmed: a space is part of the password. The password is
 * never normalized, so the same text in another Unicode normal form is a
 * different password; the README says so.
 */
export function passwordPolicyError(
  password: string,
  email: string | null,
  minLength: number,
): "password_policy" | null {
  const length = [...password].length;
  if (length < minLength || length > PASSWORD_MAX_LENGTH) return "password_policy";
  if (hasControlChar(password)) return "password_policy";
  if (email !== null && password.toLowerCase() === email.toLowerCase()) return "password_policy";
  return null;
}
