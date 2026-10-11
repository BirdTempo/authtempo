import { csvRecords } from "../csv.js";
import type { ImportOrganization, ImportUser, Source } from "../types.js";
import { asArray, asRecord, parseMillis, str } from "./common.js";

/**
 * Clerk: two files, joined on the user id. The dashboard CSV (Settings,
 * User exports) carries `password_digest` and `password_hasher` but no
 * created date and no external accounts. The Backend API `GET /v1/users`
 * carries those but no digest. Shapes: Clerk's migration tool
 * samples/clerk.csv and the Backend API spec 2026-05-12, read 2026-10-11.
 * Unverified, checked by the owner runbook: `created_at` in milliseconds,
 * the `password_hasher` values of a real export (any value other than
 * `bcrypt` is refused by name), and the `banned` field. This reader reads
 * the address flag from the API JSON, not from the CSV address lists,
 * because their separator is unverified.
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

const PROVIDERS: Record<string, string> = { oauth_google: "google", oauth_apple: "apple" };

export function clerkSource(input: ClerkExport): Source {
  return {
    name: "clerk",
    roles: CLERK_ROLES,
    async *records() {
      const rows = new Map<string, Record<string, string>>();
      for (const r of csvRecords(input.csv)) if (r.id) rows.set(r.id, r);
      const seen = new Set<string>();
      for (const raw of asArray(JSON.parse(input.users))) {
        const u = asRecord(raw);
        const id = str(u.id);
        if (!id) continue;
        seen.add(id);
        // Exact ids: no trim and no case fold (Review Focus 5).
        const row = rows.get(id);
        const primaryId = str(u.primary_email_address_id);
        const primary = asArray(u.email_addresses)
          .map(asRecord)
          .find((e) => str(e.id) === primaryId);
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
          password = { refused: "missing (no CSV row with a digest)" };
        const name = [str(u.first_name), str(u.last_name)].filter((x) => x !== null).join(" ");
        const record: ImportUser = {
          kind: "user",
          sourceId: id,
          email: str(primary?.email_address),
          // Only the status "verified"; unverified, failed, expired, or none is false.
          emailVerified: str(asRecord(primary?.verification).status) === "verified",
          name: name || null,
          image: str(u.image_url),
          createdAt: parseMillis(u.created_at),
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
        if (u.banned === true) record.skip = "banned";
        // An API user with no CSV row: the two files disagree on this id (ruling M-3).
        if (!row) record.skip = "unmatched_row";
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
          skip: "unmatched_row",
        } satisfies ImportUser;
      }
      if (!input.organizations) return;
      for (const raw of asArray(JSON.parse(input.organizations))) {
        const o = asRecord(raw);
        yield {
          kind: "organization",
          sourceId: str(o.id) ?? "",
          // As the export states it; the importer checks it (ruling I-5).
          name: typeof o.name === "string" ? o.name : null,
          slug: str(o.slug),
          createdAt: parseMillis(o.created_at),
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
