/** The print of an answer shows this many characters of a token. */
export const CUT_LENGTH = 6;

/** Keys whose value is a secret: a token, the TOTP secret and its key URI, a backup code, a challenge. */
const SECRET_KEYS = new Set(["secret", "uri", "backupCodes", "challenge"]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key) || /token$/i.test(key);
}

/** A copy of `value` with each string under a secret key cut to its first CUT_LENGTH characters. */
export function cutTokens(value: unknown, key = ""): unknown {
  if (typeof value === "string")
    return isSecretKey(key) && value.length > CUT_LENGTH ? `${value.slice(0, CUT_LENGTH)}…` : value;
  if (Array.isArray(value)) return value.map((v) => cutTokens(v, key));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutTokens(v, k)]));
  return value;
}
