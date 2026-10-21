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

/**
 * Replaces each secret in a line with ***, the longest first. An empty secret
 * is skipped: a split on it writes *** between each character.
 */
export function scrub(text: string, secrets: ReadonlySet<string>): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length))
    if (s !== "") out = out.split(s).join("***");
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
  | "hash"
  | "clientRef"
  | "method";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const HASH_RE = /^[0-9a-f]{32}$/;
/** A `cl_` id as it is, or `cimd:` and 32 hex of a metadata document URL (spec 31 item 8). */
const CLIENT_REF_RE = /^(cl_[A-Za-z0-9_-]{1,64}|cimd:[0-9a-f]{32})$/;
/**
 * A request method: a token of RFC 9110 section 5.6.2, one or more tchar
 * characters. The client chooses the method, so the kind caps it at 32.
 */
const METHOD_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
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
    // A name over 64 characters writes `Error`, as in `errorClass`: the thrower
    // sets the name, so without a bound a field can grow without a limit.
    errorName: (value: unknown) =>
      typeof value !== "string"
        ? REJECT
        : value.length <= 64 && (ERROR_CLASS_RE.test(value) || TYPEOF_NAMES.has(value))
          ? value
          : "Error",
    errorClass: (value: unknown) =>
      typeof value !== "string" ? REJECT : IDENTIFIER_RE.test(value) ? value : "Error",
    count: whole,
    durationMs: whole,
    status: whole,
    hash: matches(HASH_RE),
    clientRef: matches(CLIENT_REF_RE),
    method: matches(METHOD_RE),
  });

/**
 * The reference of a client in an event and a log line (spec 31 item 8).
 * A `cl_` id stays as it is. Any other id gives `cimd:` and the first 32 hex
 * of the SHA-256 of the metadata document URL. An event never holds the URL.
 */
export async function clientRef(clientId: string): Promise<string> {
  if (clientId.startsWith("cl_")) return clientId;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `cimd:${hex.slice(0, 32)}`;
}

/** The HKDF info of each opt-in keyed hash (spec 31 item 8). Task 2 reads them here. */
export const KEYED_HASH_INFO = Object.freeze({
  ip: "authtempo observe ip v1",
  email: "authtempo observe email v1",
} as const);

/** One of the two infos: a free or an empty info would give a key of no spec. */
export type KeyedHashInfo = (typeof KEYED_HASH_INFO)[keyof typeof KEYED_HASH_INFO];

/**
 * The HMAC key of a keyed hash: HKDF-SHA256 derives it from `secret` with an
 * empty salt and `info`. A caller that hashes many values derives it once.
 */
export async function keyedHashKey(secret: string, info: KeyedHashInfo): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** HMAC-SHA256 of `value` under a key of `keyedHashKey`, cut to 32 lowercase hex. */
export async function keyedHashWith(key: CryptoKey, value: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * HMAC-SHA256 of `value` under a key that HKDF-SHA256 derives from `secret`
 * with an empty salt and `info`, cut to 32 lowercase hex (spec 31 item 8).
 * Web Crypto only.
 */
export async function keyedHash(
  secret: string,
  info: KeyedHashInfo,
  value: string,
): Promise<string> {
  return keyedHashWith(await keyedHashKey(secret, info), value);
}
