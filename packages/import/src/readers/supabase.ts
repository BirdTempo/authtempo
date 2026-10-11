import type { FirebaseHashConfig } from "@tempo-auth/legacy-hashes";
import { csvRecords } from "../csv.js";
import type { ImportUser, Source } from "../types.js";
import { parseTime } from "./common.js";

/**
 * Supabase Auth: two CSV files from the project's Postgres, made with the
 * commands in the README (`\copy` of a select on `auth.users` and
 * `auth.identities`). The select fixes the column names, so a column that
 * Supabase adds later does not change this reader. Columns checked in the
 * supabase/auth migrations on 2026-10-11.
 */
export interface SupabaseExport {
  /** Columns: id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, is_anonymous, deleted_at, banned_until. */
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

const truthy = (v: string | undefined) => v === "t" || v === "true";

export function supabaseSource(input: SupabaseExport): Source {
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
        let meta: Record<string, unknown> = {};
        try {
          meta = u.raw_user_meta_data
            ? (JSON.parse(u.raw_user_meta_data) as Record<string, unknown>)
            : {};
        } catch {}
        const text = (k: string) =>
          typeof meta[k] === "string" && meta[k] ? (meta[k] as string) : null;
        const banned = parseTime(u.banned_until);
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
        if (truthy(u.is_anonymous)) record.skip = "anonymous";
        else if (u.deleted_at) record.skip = "deleted";
        else if (banned && banned.getTime() > now().getTime()) record.skip = "banned";
        yield record;
      }
    },
  };
}
