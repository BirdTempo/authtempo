import { normalizeEmail } from "@tempo-auth/core";
import type { ImportOrganization, ImportUser, Source } from "../types.js";
import { asArray, asRecord, ndjson, str } from "./common.js";

/**
 * Auth0: the bulk user export (`POST /api/v2/jobs/users-exports` with
 * `format: "json"`, which is NDJSON), and the password hash file that only a
 * support case gives (PGP-encrypted; decrypt it first). Shapes: Auth0 docs
 * and the support article "How to Use the Password Hashes Export", read
 * 2026-10-11. The hash file's fields come from the support article, not the
 * official docs: check them against the real file (README step).
 * Unverified, checked by owner runbook item 4: the hash algorithm (`$2b$10$`
 * in every sample; the importer refuses any other format by name), the hash
 * file's field list, and whether `user_id` carries `_id` or `alt_id`.
 */
export interface Auth0Export {
  /** NDJSON, one user per line: user_id, email, email_verified, created_at, name, picture, identities, blocked. */
  users: string;
  /** NDJSON, one line per user: _id (a string or { $oid }), alt_id, email, passwordHash. */
  hashes?: string;
  /** A JSON array of `GET /api/v2/organizations` objects, each with `members`: `{ user_id, roles: [{ id, name }] }`. */
  organizations?: string;
}

const PROVIDERS: Record<string, string> = { "google-oauth2": "google", apple: "apple" };

function oid(v: unknown): string | null {
  return str(v) ?? str(asRecord(v).$oid);
}

export function auth0Source(input: Auth0Export): Source {
  return {
    name: "auth0",
    roles: {},
    async *records() {
      const users = ndjson(input.users).map(asRecord);
      const byId = new Map(users.map((u) => [str(u.user_id) ?? "", u]));
      // The hash line names the database user by `_id` or `alt_id`; the user export by `auth0|<id>`.
      // Which one Auth0 writes into user_id is not documented, so try both, and accept the line only
      // when exactly one user matches and its address equals the line's address (Review Focus 5).
      const hashOf = new Map<string, ImportUser["password"]>();
      const unmatched: { id: string; email: string | null }[] = [];
      for (const line of input.hashes ? ndjson(input.hashes).map(asRecord) : []) {
        const ids = [oid(line._id), oid(line.alt_id)].filter((x): x is string => x !== null);
        const matches = [...new Set(ids.map((i) => `auth0|${i}`))].filter((k) => byId.has(k));
        const hash = str(line.passwordHash);
        if (matches.length !== 1 || !hash) {
          unmatched.push({ id: ids[0] ?? "", email: str(line.email) });
          continue;
        }
        const userId = matches[0] as string;
        const userEmail = normalizeEmail(str(byId.get(userId)?.email) ?? "");
        const lineEmail = normalizeEmail(str(line.email) ?? "");
        hashOf.set(
          userId,
          userEmail !== null && userEmail === lineEmail
            ? { hash }
            : { refused: "hash_email_mismatch" },
        );
      }
      for (const u of users) {
        const id = str(u.user_id);
        if (!id) continue;
        const record: ImportUser = {
          kind: "user",
          sourceId: id,
          email: str(u.email),
          emailVerified: u.email_verified === true,
          name: str(u.name),
          image: str(u.picture),
          createdAt: str(u.created_at) ? new Date(str(u.created_at) as string) : null,
          identities: asArray(u.identities)
            .map(asRecord)
            // The database connection is the password, not a social identity.
            .filter((i) => str(i.provider) !== "auth0")
            .map((i) => {
              const provider = str(i.provider) ?? "unknown";
              return {
                provider: PROVIDERS[provider] ?? provider,
                subject: String(i.user_id ?? ""),
              };
            })
            .filter((i) => i.subject.length > 0),
          password: hashOf.get(id) ?? null,
          passkeys: [],
        };
        if (u.blocked === true) record.skip = "banned";
        yield record;
      }
      for (const h of unmatched) {
        yield {
          kind: "user",
          sourceId: `auth0|${h.id}`,
          email: h.email,
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
          // As the export states it, never defaulted; the importer checks it (ruling I-5).
          name: str(o.display_name) ?? str(o.name),
          // Auth0's `name` is the organization's own identifier, lower case with hyphens.
          slug: str(o.name),
          createdAt: null,
          members: asArray(o.members)
            .map(asRecord)
            .map((m) => ({
              userSourceId: str(m.user_id) ?? "",
              roles: asArray(m.roles)
                .map((r) => str(asRecord(r).name) ?? "")
                .filter((r) => r.length > 0),
            })),
        } satisfies ImportOrganization;
      }
    },
  };
}
