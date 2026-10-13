const BASE64URL = /[+/=]/g;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(BASE64URL, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""));
}

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

/** Decodes base64url with no padding. Throws on a character outside the alphabet. */
export function fromBase64Url(text: string): Uint8Array {
  if (!BASE64URL_ALPHABET.test(text)) throw new Error("not base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `bytes` random bytes as base64url with no padding. 32 bytes make 43 characters. */
export function randomBase64Url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/** 32 random bytes, base64url, behind a prefix that names the token kind. */
export function randomToken(prefix: string): string {
  return prefix + randomBase64Url(32);
}

/** The PKCE S256 transform: base64url of the SHA-256 of the input. */
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toBase64Url(new Uint8Array(digest));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two strings in time that depends on the longer length only, not
 * on where the first difference is. Length still leaks; callers compare
 * fixed-length digests, so the length is public.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** HMAC-SHA256 of `text` under the key `secret` (its UTF-8 bytes), as lowercase hex (plan 9e). */
export async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `length` decimal digits from `crypto.getRandomValues` (plan 9e). A byte of
 * 250 or more is drawn again, so each digit is uniform: 250 is the largest
 * multiple of 10 below 256, and `byte % 10` on 0 to 255 makes 0 to 5 more
 * likely than 6 to 9.
 */
export function randomDigits(length: number): string {
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 250) continue;
      out += String(b % 10);
      if (out.length === length) break;
    }
  }
  return out;
}
