/**
 * The one redaction source of the repo (plan 12h, spec 31 item 9). The CLI
 * imports it. This file imports no Node.js module.
 */
import { ERROR_CLASS_RE } from "./primitives/app-error.js";

export { appErrorName } from "./primitives/app-error.js";

/**
 * The text of a secret, and the parts that a driver can print alone: the
 * password of a URL, its decoded form, and the user and password pair. A part
 * under 4 characters is dropped: a scrub of one letter mangles every line.
 */
export function secretParts(value: string): string[] {
  const parts = [value];
  try {
    const u = new URL(value);
    if (u.password)
      parts.push(u.password, decodeURIComponent(u.password), `${u.username}:${u.password}`);
  } catch {
    // Not a URL: the value alone.
  }
  return [...new Set(parts)].filter((p) => p.length >= 4);
}

/** Replaces each secret in a line with ***, the longest first. */
export function scrub(text: string, secrets: ReadonlySet<string>): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return out;
}

/**
 * Each C0 control character but tab, and DEL. Text from a server, a driver,
 * or wrangler can hold an escape sequence that moves the cursor or clears
 * the terminal (spec 19: the CLI writes no escape sequence).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the filter matches control characters on purpose.
export const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

/** The answer of a field kind for a value that fails it: `emit` drops the field and names it. */
export const REJECT: unique symbol = Symbol("authtempo.redact.reject");

/** The kind of an event field (spec 31 item 7). No kind is free text. */
export type FieldKind =
  | "id"
  | "enum"
  | "code"
  | "route"
  | "routePath"
  | "name"
  | "identifier"
  | "errorName"
  | "errorClass"
  | "count"
  | "durationMs"
  | "status"
  | "hash";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const HASH_RE = /^[0-9a-f]{32}$/;
/** The `typeof` names that `appErrorName` gives for a thrown value that is no Error. */
const TYPEOF_NAMES = new Set([
  "bigint",
  "boolean",
  "function",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
]);

const matches = (re: RegExp) => (value: unknown) =>
  typeof value === "string" && re.test(value) ? value : REJECT;
/** `enum`, `code`, `route`, and `routePath` check the closed list in `validateEvent` (Task 3); here only the length. */
const listed = (value: unknown) =>
  typeof value === "string" && value.length <= 128 ? value : REJECT;
const whole = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : REJECT;

/**
 * The rule of each field kind. A rule answers the value to write, or
 * `REJECT`. `errorName` and `errorClass` write `Error` for a name that fails
 * them, because the thrower sets the name and it can hold data.
 */
export const FIELD_KINDS: Readonly<Record<FieldKind, (value: unknown) => unknown | typeof REJECT>> =
  Object.freeze({
    id: matches(ID_RE),
    enum: listed,
    code: listed,
    route: listed,
    routePath: listed,
    name: matches(NAME_RE),
    identifier: matches(IDENTIFIER_RE),
    errorName: (value: unknown) =>
      typeof value !== "string"
        ? REJECT
        : ERROR_CLASS_RE.test(value) || TYPEOF_NAMES.has(value)
          ? value
          : "Error",
    errorClass: (value: unknown) =>
      typeof value !== "string" ? REJECT : IDENTIFIER_RE.test(value) ? value : "Error",
    count: whole,
    durationMs: whole,
    status: whole,
    hash: matches(HASH_RE),
  });

/**
 * HMAC-SHA256 of `value` under a key that HKDF-SHA256 derives from `secret`
 * with an empty salt and `info`, cut to 32 lowercase hex (spec 31 item 8).
 * Web Crypto only.
 */
export async function keyedHash(secret: string, info: string, value: string): Promise<string> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
