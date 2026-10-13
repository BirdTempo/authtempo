import { csvRecords } from "../csv.js";
import type { ImportOrganization, ImportUser, SkipReason, Source } from "../types.js";
import { asArray, asRecord, LINKEDIN_LEGACY, noSourceIdUser, parseMillis, str } from "./common.js";

/**
 * Clerk: two files, joined on the user id. The dashboard CSV (Settings,
 * User exports) carries `password_digest` and `password_hasher` but no
 * created date and no external accounts. The Backend API `GET /v1/users`
 * carries those but no digest. Shapes: Clerk's migration tool
 * samples/clerk.csv and the Backend API spec 2026-05-12, read 2026-10-11.
 * Unverified, checked by owner runbook item 3: the unit of `created_at`
 * (Clerk's docs do not state it; see `clerkTime`), the `password_hasher`
 * values of a real export (any value other than `bcrypt` is refused by
 * name), and the `banned` field (any value other than `false` or absent
 * skips the user). Clerk's `locked` field is not read. This reader reads the
 * address flag from the API JSON, not from the CSV address lists, because
 * their separator is unverified.
 */
export interface ClerkExport {
  /** The dashboard CSV. Header: id, first_name, last_name, username, primary_email_address, ..., password_digest, password_hasher. */
  csv: string;
  /** A JSON array of `GET /v1/users` user objects (every page, joined; see the README). */
  users: string;
  /** A JSON array of `GET /v1/organizations` objects, each with `memberships`: the `GET /v1/organizations/{id}/memberships` data. */
  organizations?: string;
}

/** Clerk's two default roles (Clerk docs, read 2026-10-11). An org admin manages members and deletes the organization: core's owner. */
export const CLERK_ROLES = { "org:admin": "owner", "org:member": "member" } as const;

/**
 * Clerk's strategy names (SSO types reference, read 2026-10-12): `oauth_` and
 * the provider. `oauth_github` becomes `github` by the prefix rule below.
 * `oauth_linkedin_oidc` is LinkedIn's OIDC `sub`; `oauth_linkedin` is the
 * older LinkedIn API (plan 9b2).
 */
const PROVIDERS: Record<string, string> = {
  oauth_google: "google",
  oauth_apple: "apple",
  oauth_linkedin_oidc: "linkedin",
  oauth_linkedin: LINKEDIN_LEGACY,
};

/**
 * The skip for an id that one file holds twice. No copy wins: an older row
 * last in the file would bring back an old password. A conflict: the CLI exits 1.
 */
const DUPLICATE: SkipReason = "duplicate_row";

/**
 * Clerk's docs do not state the unit of `created_at` (unverified; owner
 * runbook item 3). A value below 1e11 is read as seconds, because in
 * milliseconds it is a date before March 1973, before Clerk existed.
 */
function clerkTime(v: unknown): Date | null {
  const d = parseMillis(v);
  // 0 or below is 1970 or earlier, before Clerk existed: no date, not a guess.
  if (d === null || d.getTime() <= 0) return null;
  if (d.getTime() >= 1e11) return d;
  return new Date(d.getTime() * 1000);
}

/** The top-level JSON array of one input; any other value is an error, never an empty list. */
function jsonArray(text: string, input: "users" | "organizations"): unknown[] {
  const v = JSON.parse(text) as unknown;
  if (!Array.isArray(v))
    throw new Error(
      `authtempo import: the Clerk ${input} input is not a JSON array (save the data array of every page)`,
    );
  return v;
}

export function clerkSource(input: ClerkExport): Source {
  return {
    name: "clerk",
    roles: CLERK_ROLES,
    async *records() {
      const rows = new Map<string, Record<string, string>>();
      const duplicates = new Set<string>();
      // A row with no id is listed, never dropped in silence (yielded below).
      const noIdRows: string[] = [];
      for (const [n, r] of csvRecords(input.csv).entries()) {
        if (!r.id) {
          // csvRecords numbers a row as its index plus 2 (the header is row 1).
          noIdRows.push(`csv row ${n + 2}`);
          continue;
        }
        if (rows.has(r.id)) duplicates.add(r.id);
        rows.set(r.id, r);
      }
      const users = jsonArray(input.users, "users").map(asRecord);
      const seen = new Set<string>();
      for (const u of users) {
        const id = str(u.id);
        if (!id) continue;
        if (seen.has(id)) duplicates.add(id);
        seen.add(id);
      }
      for (const [n, u] of users.entries()) {
        const id = str(u.id);
        if (!id) {
          yield noSourceIdUser(`users item ${n + 1}`);
          continue;
        }
        // Exact ids: no trim and no case fold (Review Focus 5).
        const row = duplicates.has(id) ? undefined : rows.get(id);
        const primaryId = str(u.primary_email_address_id);
        // A null primary id matches no address, also not one with no id.
        const primary = asArray(u.email_addresses)
          .map(asRecord)
          .find((e) => primaryId !== null && str(e.id) === primaryId);
        const dropped: string[] = [];
        for (const _ of asArray(u.passkeys)) dropped.push("passkey:no_public_key");
        let password: ImportUser["password"] = null;
        const digest = row?.password_digest ?? "";
        if (digest)
          password =
            row?.password_hasher === "bcrypt"
              ? { hash: digest }
              : { refused: row?.password_hasher || "unknown" };
        else if (row && u.password_enabled === true)
          password = { refused: "missing (the CSV row has no digest)" };
        const name = [str(u.first_name), str(u.last_name)].filter((x) => x !== null).join(" ");
        const record: ImportUser = {
          kind: "user",
          sourceId: id,
          email: str(primary?.email_address),
          // Only the status "verified"; unverified, failed, expired, or none is false.
          emailVerified: str(asRecord(primary?.verification).status) === "verified",
          name: name || null,
          image: str(u.image_url),
          createdAt: clerkTime(u.created_at),
          identities: asArray(u.external_accounts)
            .map(asRecord)
            .map((a) => {
              const provider = str(a.provider) ?? "unknown";
              return {
                provider: PROVIDERS[provider] ?? provider.replace(/^oauth_/, ""),
                subject: str(a.provider_user_id) ?? "",
              };
            })
            .filter((i) => i.subject.length > 0),
          password,
          passkeys: [],
          dropped,
        };
        // Fail closed: a ban in any form but `false` skips the user.
        if (u.banned !== undefined && u.banned !== false) record.skip = "banned";
        // An API user with no CSV row: the two files disagree on this id (ruling M-3).
        if (!row) record.skip = "unmatched_row";
        if (duplicates.has(id)) record.skip = DUPLICATE;
        yield record;
      }
      // A CSV row with no API user: the two files disagree on this id.
      for (const [id, r] of rows) {
        if (seen.has(id)) continue;
        yield {
          kind: "user",
          sourceId: id,
          email: r.primary_email_address || null,
          emailVerified: false,
          name: null,
          image: null,
          createdAt: null,
          identities: [],
          password: null,
          passkeys: [],
          skip: duplicates.has(id) ? DUPLICATE : "unmatched_row",
        } satisfies ImportUser;
      }
      for (const where of noIdRows) yield noSourceIdUser(where);
      if (!input.organizations) return;
      for (const [n, raw] of jsonArray(input.organizations, "organizations").entries()) {
        const o = asRecord(raw);
        const id = str(o.id);
        yield {
          kind: "organization",
          // No id: no import key. Two such organizations would share one importId.
          sourceId: id ?? `(none) organizations item ${n + 1}`,
          ...(id === null ? { skip: "no_source_id" as const } : {}),
          // As the export states it; the importer checks it (ruling I-5).
          name: typeof o.name === "string" ? o.name : null,
          slug: str(o.slug),
          createdAt: clerkTime(o.created_at),
          members: asArray(o.memberships)
            .map(asRecord)
            .map((m) => ({
              userSourceId: str(asRecord(m.public_user_data).user_id) ?? "",
              roles: str(m.role) ? [str(m.role) as string] : [],
            })),
        } satisfies ImportOrganization;
      }
    },
  };
}
