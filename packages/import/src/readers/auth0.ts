import { normalizeEmail } from "@authtempo/core";
import { formatName } from "../import.js";
import type { ImportOrganization, ImportUser, SkipReason, Source } from "../types.js";
import {
  asArray,
  asRecord,
  LINKEDIN_LEGACY,
  ndjson,
  noSourceIdUser,
  parseJson,
  parseTime,
  str,
} from "./common.js";

/**
 * Auth0: the bulk user export (`POST /api/v2/jobs/users-exports` with
 * `format: "json"`, which is NDJSON), and the password hash file that only a
 * support case gives (PGP-encrypted; decrypt it first). Shapes: Auth0 docs
 * and the support article "How to Use the Password Hashes Export", read
 * 2026-10-11. The hash file's fields come from the support article, not the
 * official docs: check them against the real file (README step).
 * Unverified, checked by owner runbook item 4: the hash algorithm (`$2b$10$`
 * in every sample), the hash file's field list, and whether `user_id`
 * carries `_id` or `alt_id`. Auth0 stores bcrypt only, so this reader
 * accepts only a `$2a$` or `$2b$` string and refuses any other by its
 * format name: a hash in another format is not a password Auth0 issued.
 */
export interface Auth0Export {
  /** NDJSON, one user per line: user_id, email, email_verified, created_at, name, picture, identities, blocked. */
  users: string;
  /** NDJSON, one line per user: _id (a string or { $oid }), alt_id, email, passwordHash. */
  hashes?: string;
  /** A JSON array of `GET /api/v2/organizations` objects, each with `members`: `{ user_id, roles: [{ id, name }] }`. */
  organizations?: string;
}

/**
 * Auth0's built-in LinkedIn connection asked for `r_liteprofile` (an Auth0
 * community thread of 2023); unverified on 2026-10-12 whether a current
 * `linkedin` identity carries the OIDC `sub`. So every Auth0 `linkedin`
 * identity is `linkedin_legacy`, which the importer drops and lists (plan 9b2).
 */
const PROVIDERS: Record<string, string> = {
  "google-oauth2": "google",
  apple: "apple",
  linkedin: LINKEDIN_LEGACY,
};

/** Auth0 stores bcrypt only (research 1c). */
const BCRYPT = /^\$2[ab]\$\d{2}\$/;

/**
 * The skip for a user id that the export holds twice. No line wins: the
 * address check would compare against one line and the importer write the
 * other. A conflict: the CLI exits 1.
 */
const DUPLICATE: SkipReason = "duplicate_row";

function oid(v: unknown): string | null {
  return str(v) ?? str(asRecord(v).$oid);
}

export function auth0Source(input: Auth0Export): Source {
  return {
    name: "auth0",
    roles: {},
    async *records() {
      // Read first, so a misshaped organizations file throws before any
      // record. Any value but a JSON array is an error, never an empty list:
      // a saved `{ "organizations": [...] }` page would lose every organization.
      let organizations: unknown[] = [];
      if (input.organizations) {
        const v = parseJson(input.organizations, "Auth0 organizations");
        if (!Array.isArray(v))
          throw new Error(
            "authtempo import: the Auth0 organizations input is not a JSON array (save the organizations array, not the page object)",
          );
        organizations = v;
      }
      const users = ndjson(input.users).map(asRecord);
      const byId = new Map<string, Record<string, unknown>>();
      const duplicates = new Set<string>();
      for (const u of users) {
        const id = str(u.user_id);
        if (!id) continue;
        if (byId.has(id)) duplicates.add(id);
        byId.set(id, u);
      }
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
        // Two lines for one user: no line wins, the user gets no password, and the report names it.
        if (hashOf.has(userId)) {
          hashOf.set(userId, { refused: "duplicate_hash_line" });
          continue;
        }
        const userEmail = normalizeEmail(str(byId.get(userId)?.email) ?? "");
        const lineEmail = normalizeEmail(str(line.email) ?? "");
        hashOf.set(
          userId,
          userEmail === null || userEmail !== lineEmail
            ? { refused: "hash_email_mismatch" }
            : BCRYPT.test(hash)
              ? { hash }
              : { refused: formatName(hash) },
        );
      }
      const yielded = new Set<string>();
      for (const [n, u] of users.entries()) {
        const id = str(u.user_id);
        // ndjson numbers a line among the non-empty lines, as its errors do.
        if (!id) {
          yield noSourceIdUser(`users line ${n + 1}`);
          continue;
        }
        if (duplicates.has(id)) {
          // One record for every copy of the id, with no hash.
          if (yielded.has(id)) continue;
          yielded.add(id);
          yield {
            kind: "user",
            sourceId: id,
            email: str(u.email),
            emailVerified: false,
            name: null,
            image: null,
            createdAt: null,
            identities: [],
            password: null,
            passkeys: [],
            skip: DUPLICATE,
          } satisfies ImportUser;
          continue;
        }
        const dropped: string[] = [];
        const created = str(u.created_at);
        const createdAt = parseTime(created);
        if (created !== null && createdAt === null) dropped.push("created_at:unreadable");
        const record: ImportUser = {
          kind: "user",
          sourceId: id,
          email: str(u.email),
          emailVerified: u.email_verified === true,
          name: str(u.name),
          image: str(u.picture),
          createdAt,
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
          dropped,
        };
        // Fail closed: a block in any form but `false` skips the user.
        if (u.blocked !== undefined && u.blocked !== false) record.skip = "banned";
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
      for (const [n, raw] of organizations.entries()) {
        const o = asRecord(raw);
        const id = str(o.id);
        yield {
          kind: "organization",
          // No id: no import key. Two such organizations would share one importId.
          sourceId: id ?? `(none) organizations item ${n + 1}`,
          ...(id === null ? { skip: "no_source_id" as const } : {}),
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
