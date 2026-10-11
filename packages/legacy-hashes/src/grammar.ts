/**
 * The tagged string format of a legacy password hash (spec 17.2). The
 * segment order is Ory Kratos's (`hash/hash_comparator.go`, read 2026-10-11):
 * `$<tag>$<params>$<salt>$<hash>`. Two changes from Ory, because Ory's
 * `ln` means N for `$scrypt$` and log2 N for `$firescrypt$`: this grammar
 * names log2 N `n` in both, and the Firebase signer key and salt separator
 * are not in the string (they are a project secret, in the seam's options).
 *
 * Base64 segments use the standard alphabet (`A-Z a-z 0-9 + /`), with or
 * without `=` padding. bcrypt keeps its own alphabet.
 *
 * Every bound keeps one derive under 32 MiB of memory and bounds its CPU,
 * so a stored row cannot ask for an unbounded derive. A string outside a
 * bound does not parse.
 */
export type LegacyFormat = "bcrypt" | "argon2id" | "pbkdf2-sha256" | "scrypt" | "firescrypt";

export const LEGACY_FORMATS: readonly LegacyFormat[] = [
  "bcrypt",
  "argon2id",
  "pbkdf2-sha256",
  "scrypt",
  "firescrypt",
];

export type ParsedLegacyHash =
  | { format: "bcrypt"; cost: number; stored: string }
  | { format: "argon2id"; m: number; t: number; p: number; salt: Uint8Array; hash: Uint8Array }
  | { format: "pbkdf2-sha256"; i: number; salt: Uint8Array; hash: Uint8Array }
  | { format: "scrypt"; n: number; r: number; p: number; salt: Uint8Array; hash: Uint8Array }
  | { format: "firescrypt"; n: number; r: number; p: number; salt: Uint8Array; hash: Uint8Array };

/** bcrypt cost 4 to 12. Cost 10 (Supabase, Clerk, Auth0) is about 50 ms of CPU (research, 2026-10-11); 12 is four times that. */
export const BCRYPT_MAX_COST = 12;
/** One Argon2id derive holds `m` KiB. 32 MiB is the bound the scrypt gate of plan 9 uses. */
export const ARGON2_MAX_MEMORY_KIB = 32_768;
export const ARGON2_MAX_TIME = 10;
export const ARGON2_MAX_PARALLELISM = 4;
/** noble's PBKDF2 is pure JavaScript. 600000 is OWASP's count for PBKDF2-HMAC-SHA256 and the highest count this seam runs. */
export const PBKDF2_MAX_ITERATIONS = 600_000;
/** One scrypt derive holds 128 * N * r bytes. N * r at most 2^18 keeps it at 32 MiB. */
export const SCRYPT_MAX_N_TIMES_R = 2 ** 18;
export const SCRYPT_MAX_P = 16;
/** A derived key or a stored hash of 16 to 64 bytes. */
const KEY_MIN = 16;
const KEY_MAX = 64;
/** RFC 7914's vectors use 4-byte salts ("salt", "NaCl"). Argon2 needs 8 (RFC 9106 section 3.1). */
const SALT_MIN = 4;
const SALT_MIN_ARGON2 = 8;
const SALT_MAX = 64;

const B64 = "([A-Za-z0-9+/]+={0,2})";
const BCRYPT_RE = /^\$2[ab]\$(\d{2})\$[./A-Za-z0-9]{53}$/;
const ARGON2_RE = new RegExp(
  `^\\$argon2id\\$v=19\\$m=(\\d{1,6}),t=(\\d{1,2}),p=(\\d{1,2})\\$${B64}\\$${B64}$`,
);
const PBKDF2_RE = new RegExp(`^\\$pbkdf2-sha256\\$i=(\\d{1,7}),l=(\\d{1,3})\\$${B64}\\$${B64}$`);
const SCRYPT_RE = new RegExp(
  `^\\$scrypt\\$n=(\\d{1,2}),r=(\\d{1,2}),p=(\\d{1,2})\\$${B64}\\$${B64}$`,
);
const FIRESCRYPT_RE = new RegExp(
  `^\\$firescrypt\\$n=(\\d{1,2}),r=(\\d{1,2}),p=1\\$${B64}\\$${B64}$`,
);

/** Standard base64 with or without padding, strict: a stray character or a bad length answers null. */
export function decodeBase64(text: string): Uint8Array | null {
  const bare = text.replace(/=+$/, "");
  if (bare.length % 4 === 1) return null;
  if (text.length !== bare.length && text.length % 4 !== 0) return null;
  const padded = bare + "=".repeat((4 - (bare.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const within = (x: Uint8Array | null, min: number, max: number): x is Uint8Array =>
  x !== null && x.length >= min && x.length <= max;

function int(text: string | undefined): number {
  return text === undefined ? Number.NaN : Number(text);
}

/**
 * The parsed hash, or null when the string is not in this grammar or is
 * outside a bound. A string that does not start with `$` is not a legacy
 * hash (core's PBKDF2 starts with `pbkdf2-sha256$`, Better Auth's with hex).
 */
export function parseLegacyHash(stored: string): ParsedLegacyHash | null {
  let m = BCRYPT_RE.exec(stored);
  if (m) {
    const cost = int(m[1]);
    return cost >= 4 && cost <= BCRYPT_MAX_COST ? { format: "bcrypt", cost, stored } : null;
  }
  m = ARGON2_RE.exec(stored);
  if (m) {
    const [mem, t, p] = [int(m[1]), int(m[2]), int(m[3])];
    const salt = decodeBase64(m[4] ?? "");
    const hash = decodeBase64(m[5] ?? "");
    if (p < 1 || p > ARGON2_MAX_PARALLELISM || t < 1 || t > ARGON2_MAX_TIME) return null;
    // Argon2 needs at least 8 KiB per lane (RFC 9106 section 3.1).
    if (mem < 8 * p || mem > ARGON2_MAX_MEMORY_KIB) return null;
    if (!within(salt, SALT_MIN_ARGON2, SALT_MAX) || !within(hash, KEY_MIN, KEY_MAX)) return null;
    return { format: "argon2id", m: mem, t, p, salt, hash };
  }
  m = PBKDF2_RE.exec(stored);
  if (m) {
    const [i, l] = [int(m[1]), int(m[2])];
    const salt = decodeBase64(m[3] ?? "");
    const hash = decodeBase64(m[4] ?? "");
    if (i < 1 || i > PBKDF2_MAX_ITERATIONS) return null;
    if (!within(salt, SALT_MIN, SALT_MAX) || !within(hash, KEY_MIN, KEY_MAX)) return null;
    // `l` is the key length Ory writes. It must agree with the hash it names.
    if (l !== hash.length) return null;
    return { format: "pbkdf2-sha256", i, salt, hash };
  }
  for (const [re, format] of [
    [SCRYPT_RE, "scrypt"],
    [FIRESCRYPT_RE, "firescrypt"],
  ] as const) {
    m = re.exec(stored);
    if (!m) continue;
    const [n, r] = [int(m[1]), int(m[2])];
    const p = format === "firescrypt" ? 1 : int(m[3]);
    const salt = decodeBase64(m[format === "firescrypt" ? 3 : 4] ?? "");
    const hash = decodeBase64(m[format === "firescrypt" ? 4 : 5] ?? "");
    if (n < 1 || r < 1 || p < 1 || p > SCRYPT_MAX_P) return null;
    if (2 ** n * r > SCRYPT_MAX_N_TIMES_R) return null;
    if (!within(salt, SALT_MIN, SALT_MAX) || !within(hash, KEY_MIN, KEY_MAX)) return null;
    return { format, n, r, p, salt, hash };
  }
  return null;
}
