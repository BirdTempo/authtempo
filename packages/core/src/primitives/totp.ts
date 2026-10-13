import { constantTimeEqual } from "./crypto.js";

/**
 * HOTP (RFC 4226) and TOTP (RFC 6238) with HMAC-SHA1 on `crypto.subtle`, the
 * base32 of RFC 4648 with no padding, the `otpauth://` key URI, and the
 * backup code (plan 9f). Every authenticator app reads SHA-1, 6 digits, and
 * 30 seconds, so core fixes these three values.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 31 characters: the lower-case letters and the digits, less 0, 1, i, l, and o, which look alike. */
export const BACKUP_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** RFC 4648 base32 with no padding, as the key URI carries a secret. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    // At most 4 bits stay from the last byte, so 16 bits hold the buffer.
    buffer = ((buffer << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/** The bytes of a base32 text. Lower case, spaces, and `=` padding are accepted; any other character throws. */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v === -1) throw new Error("not base32");
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The HOTP value of `counter` (RFC 4226 section 5.3): HMAC-SHA1 over the 8-byte big-endian counter, then the dynamic truncation. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits = TOTP_DIGITS,
): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac[19] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The 30-second step of a time: RFC 6238's T with T0 = 0. */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The 6-digit code of `secret` at the step of `at`. */
export function totpCode(secret: Uint8Array, at: Date): Promise<string> {
  return hotp(secret, totpStep(at));
}

/**
 * The step whose code is `code`, from `window` steps before the step of
 * `now` to `window` steps after it, or null. The one place of the code
 * compare (plan 9f): every step of the window runs the HMAC and
 * `constantTimeEqual`, also after a match, so the time does not tell which
 * step matched. The caller writes the matched step as `lastStep` in the
 * same conditional update as its check, so a code passes once.
 */
export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  now: Date,
  window: number,
): Promise<number | null> {
  const step = totpStep(now);
  let matched: number | null = null;
  for (let s = step - window; s <= step + window; s++)
    if (constantTimeEqual(await hotp(secret, s), code)) matched = s;
  return matched;
}

/**
 * The key URI an authenticator app scans, in the Key Uri Format of Google
 * Authenticator (not re-read when the plan was written, 2026-10-13; the
 * example Worker test and a real app scan are the checks):
 * `otpauth://totp/<issuer>:<account>?…`.
 * Each part goes through `encodeURIComponent`, so a space is `%20`, not `+`.
 */
export function otpauthUri(input: { secret: Uint8Array; issuer: string; account: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  const label = `${issuer}:${encodeURIComponent(input.account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(input.secret)}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

/**
 * `length` characters of `BACKUP_CODE_ALPHABET` from `crypto.getRandomValues`.
 * A byte of 248 or more is drawn again: 248 is the largest multiple of 31
 * below 256, and `byte % 31` on 0 to 255 makes the first 8 characters more
 * likely than the rest.
 */
export function randomBackupCode(length: number): string {
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 248) continue;
      out += BACKUP_CODE_ALPHABET.charAt(b % 31);
      if (out.length === length) break;
    }
  }
  return out;
}

/** A typed backup code as core stores it: lower case, with no space and no dash. */
export function normalizeBackupCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}
