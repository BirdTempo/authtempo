import type { FirebaseHashConfig } from "@tempo-auth/legacy-hashes";
import { csvRecords, parseCsv } from "../csv.js";
import type { ImportUser, Source } from "../types.js";
import { asRecord, parseTime } from "./common.js";

/**
 * Supabase Auth: two CSV files from the project's Postgres, made with the
 * commands in the README (`\copy` of a select on `auth.users` and
 * `auth.identities`). The select fixes the column names, so a column that
 * Supabase adds later does not change this reader. Columns checked in the
 * supabase/auth migrations on 2026-10-11.
 *
 * Columns the select leaves out, so they do not move (research 1a):
 * - `auth.users.phone`, `phone_confirmed_at`: core has no phone sign-in. A
 *   phone-only user has no email and is skipped as `no_email`.
 * - `auth.users.confirmed_at`: generated as LEAST(email, phone); it is not the
 *   email flag. `email_confirmed_at` is.
 * - `auth.users.raw_app_meta_data`: holds `provider` and `providers`, which
 *   the identities file gives row by row.
 * - `auth.users.updated_at`, `last_sign_in_at`: core sets its own times.
 * - `auth.identities.id`, `created_at`, `updated_at`, `last_sign_in_at`: core
 *   makes its own identity id and times.
 * - `auth.identities.identity_data`, `email`: the reader links an identity by
 *   `user_id`, never by an address, so the identity email is not used.
 * - `auth.webauthn_credentials`: the `public_key` encoding is unverified
 *   (spec 17.5).
 */
export interface SupabaseExport {
  /** The columns of `SUPABASE_USER_COLUMNS`. */
  users: string;
  /** Columns: provider, provider_id, user_id. */
  identities: string;
  /** The Firebase project parameters, when the project imported Firebase users (`$fbscrypt$` rows). */
  firebase?: FirebaseHashConfig;
  /** For the banned_until test. Default the system time. */
  now?: () => Date;
}

// supabase/auth internal/crypto/password.go, read 2026-10-11. ss and sk are base64 with padding.
const FBSCRYPT_RE =
  /^\$fbscrypt\$v=1,n=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})(?:,ss=([A-Za-z0-9+/=]+))?(?:,sk=([A-Za-z0-9+/=]+))?\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

/**
 * Supabase routes a hash by prefix: `$argon2` to Argon2, `$fbscrypt` to
 * Firebase scrypt, everything else to bcrypt (password.go). This reader
 * passes `$2a$`, `$2b$`, and `$argon2id$` through, and turns a
 * `$fbscrypt$` row into `$firescrypt$` only when its signer key and salt
 * separator are this import's Firebase parameters, because the seam holds
 * one project's parameters. Any other string goes through for the importer
 * to name and refuse.
 */
export function supabasePassword(
  raw: string,
  firebase: FirebaseHashConfig | undefined,
): ImportUser["password"] {
  if (raw.length === 0) return null;
  if (!raw.startsWith("$fbscrypt$")) return { hash: raw };
  const m = FBSCRYPT_RE.exec(raw);
  if (!m) return { refused: "fbscrypt (malformed)" };
  const [, n, r, p, ss, sk, salt, hash] = m;
  if (!firebase || ss !== firebase.saltSeparator || sk !== firebase.signerKey)
    return { refused: "fbscrypt (not this import's Firebase project)" };
  return { hash: `$firescrypt$n=${n},r=${r},p=${p}$${salt}$${hash}` };
}

/**
 * A Postgres boolean as `psql` writes it: `t` or `true`, `f` or `false`.
 * Null for any other text, such as `TRUE` or `1` from another tool. Both
 * columns it reads are NOT NULL, so only `f` or `false` is a proven false,
 * and the reader skips the user on null (fail closed, spec 17.3).
 */
function pgBool(v: string | undefined): boolean | null {
  if (v === "t" || v === "true") return true;
  if (v === "f" || v === "false") return false;
  return null;
}

/**
 * Fail closed: a ban is the source's promise. Any value that is not a time in
 * the past counts as banned, so `infinity` and a timestamp in a DateStyle
 * that `parseTime` does not read keep the user out. An expired ban imports.
 */
function bannedNow(text: string | undefined, now: Date): boolean {
  if (!text) return false;
  const until = parseTime(text);
  return until === null || until.getTime() > now.getTime();
}

/** The columns of the README's two selects. One source for the check and the doc comments above. */
export const SUPABASE_USER_COLUMNS = [
  "id",
  "email",
  "encrypted_password",
  "email_confirmed_at",
  "raw_user_meta_data",
  "created_at",
  "is_anonymous",
  "deleted_at",
  "banned_until",
  "is_sso_user",
] as const;
export const SUPABASE_IDENTITY_COLUMNS = ["provider", "provider_id", "user_id"] as const;

/**
 * Fail closed: a missing column reads as empty, and an empty `banned_until`
 * or `is_sso_user` imports a banned or SSO user. So every column must be in
 * the header, and the check runs before any record is read.
 */
function requireColumns(file: string, text: string, columns: readonly string[]): void {
  const end = text.search(/\r?\n/);
  const header = parseCsv(end === -1 ? text : text.slice(0, end))[0] ?? [];
  for (const c of columns)
    if (!header.includes(c))
      throw new Error(
        `tempo-auth import: the Supabase ${file} file has no ${c} column; run the README's select`,
      );
}

export function supabaseSource(input: SupabaseExport): Source {
  requireColumns("users", input.users, SUPABASE_USER_COLUMNS);
  requireColumns("identities", input.identities, SUPABASE_IDENTITY_COLUMNS);
  const now = input.now ?? (() => new Date());
  return {
    name: "supabase",
    roles: {},
    async *records() {
      const byUser = new Map<string, { provider: string; subject: string }[]>();
      for (const i of csvRecords(input.identities)) {
        // The email identity is the user's own address; the importer writes it from the user row.
        if (i.provider === "email" || !i.user_id || !i.provider_id) continue;
        const list = byUser.get(i.user_id) ?? [];
        list.push({ provider: i.provider ?? "", subject: i.provider_id });
        byUser.set(i.user_id, list);
      }
      for (const u of csvRecords(input.users)) {
        const dropped: string[] = [];
        // A jsonb null, or any value that is not an object, gives no name and no image.
        let meta: Record<string, unknown> = {};
        try {
          meta = u.raw_user_meta_data ? asRecord(JSON.parse(u.raw_user_meta_data)) : {};
        } catch {
          // Postgres writes valid JSON; a file edited by hand can break it.
          dropped.push("meta:invalid");
        }
        const text = (k: string) =>
          typeof meta[k] === "string" && meta[k] ? (meta[k] as string) : null;
        const record: ImportUser = {
          kind: "user",
          sourceId: u.id ?? "",
          email: u.email || null,
          // email_confirmed_at, not confirmed_at: confirmed_at is LEAST(email, phone) (migration 20210710035447).
          emailVerified: parseTime(u.email_confirmed_at) !== null,
          name: text("full_name") ?? text("name"),
          image: text("avatar_url") ?? text("picture"),
          createdAt: parseTime(u.created_at),
          identities: byUser.get(u.id ?? "") ?? [],
          password: supabasePassword(u.encrypted_password ?? "", input.firebase),
          passkeys: [],
        };
        if (dropped.length > 0) record.dropped = dropped;
        if (pgBool(u.is_anonymous) !== false) record.skip = "anonymous";
        else if (u.deleted_at) record.skip = "deleted";
        else if (bannedNow(u.banned_until, now())) record.skip = "banned";
        // tempo-auth has no SAML mapping. The email unique index skips SSO users
        // (users_email_partial_key, migration 20221215195500, read 2026-10-11),
        // so an SSO user can share an address with a password user, and CSV
        // order must not decide who owns it.
        else if (pgBool(u.is_sso_user) !== false) record.skip = "sso_user";
        yield record;
      }
    },
  };
}
