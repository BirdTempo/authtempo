import type { ImportOrganization, ImportUser, Source } from "../types.js";
import { asRecord, LINKEDIN_LEGACY, noSourceIdUser, parseJson, parseTime, str } from "./common.js";

/**
 * WorkOS User Management: four JSON files that the guide's curl script
 * writes (owner decision 4 of 2026-10-14). The CLI reads files and makes no
 * network call, and no WorkOS key is in any file of the repo. Fields: the
 * WorkOS reference pages user-management/user, user-management/identity,
 * user-management/organization-membership, and organization, read
 * 2026-10-19 (plan 11f Task 1 Step 1).
 * WorkOS exports no password hash (the user reference: `password_hash` is a
 * write-only input), so every WorkOS user imports with no password (owner
 * decision 1 of 2026-10-14). Each user signs in by a magic link or sets a
 * new password.
 * Unverified, checked by owner runbook item 13:
 * - the provider values other than `MicrosoftOAuth`, the one value the
 *   identity page shows, and `idp_id` as the provider's own subject;
 * - the `statuses` query form of the membership list, which the guide's
 *   script uses to fetch the non-active memberships too;
 * - the `list_metadata.after` cursor of each list, which the script follows;
 * - the rate limit, which no reference page states.
 */
export interface WorkosExport {
  /** The `data` array of every page of `GET /user_management/users`, as one JSON array. */
  users: string;
  /** One JSON object of user id to the array of `GET /user_management/users/{id}/identities`. */
  identities?: string;
  /** The `data` array of every page of `GET /user_management/organization_memberships`, every status. Needs `organizations`. */
  memberships?: string;
  /** The `data` array of every page of `GET /organizations`. Needs `memberships`. */
  organizations?: string;
}

/**
 * WorkOS's two default role slugs (the organization membership reference,
 * read 2026-10-19). An admin manages members: core's admin. The importer
 * makes the first admin the owner when no member maps to owner.
 */
export const WORKOS_ROLES = { admin: "admin", member: "member" } as const;

/**
 * Only `MicrosoftOAuth` appears on the identity page (read 2026-10-19). The
 * other three values and `idp_id` as the provider's subject are unverified:
 * runbook item 13. LinkedIn: no field marks the OIDC `sub`, so it is the
 * legacy name (plan 9b2). Any other value goes to a provider the importer
 * drops and lists.
 */
const PROVIDERS: Record<string, string> = {
  GoogleOAuth: "google",
  AppleOAuth: "apple",
  GitHubOAuth: "github",
  LinkedInOAuth: LINKEDIN_LEGACY,
};

/** The hint for a list input: the guide's script saves `data` of each page, never the page object. */
const PAGE_HINT = "save the data array of every page";

/** The parsed input, or a throw that names the input and the shape the script saves. */
function parseList(text: string, input: string): unknown[] {
  const top = parseJson(text, `WorkOS ${input}`);
  if (!Array.isArray(top))
    throw new Error(`authtempo import: the WorkOS ${input} input is not an array (${PAGE_HINT})`);
  return top;
}

/**
 * The identities of one user: `GET /user_management/users/{id}/identities`
 * answers a bare array, so the script saves one object of user id to that
 * array. Every entry it cannot read is listed.
 */
function readIdentities(raw: unknown, dropped: string[]): ImportUser["identities"] {
  const out: ImportUser["identities"] = [];
  if (raw === undefined) return out;
  // A value that is not an array is one unreadable entry, never a silent empty list.
  if (!Array.isArray(raw)) {
    dropped.push("identity:unreadable");
    return out;
  }
  for (const i of raw.map(asRecord)) {
    const type = str(i.type);
    // The identity page documents `OAuth` only; another type is no social identity.
    if (type !== "OAuth") {
      dropped.push(`identity:type:${type ?? "(none)"}`);
      continue;
    }
    const subject = str(i.idp_id);
    const provider = str(i.provider);
    if (subject === null || provider === null) {
      dropped.push("identity:unreadable");
      continue;
    }
    out.push({
      provider: Object.hasOwn(PROVIDERS, provider)
        ? (PROVIDERS[provider] as string)
        : `workos:${provider}`,
      subject,
    });
  }
  return out;
}

export function workosSource(input: WorkosExport): Source {
  return {
    name: "workos",
    roles: WORKOS_ROLES,
    async *records() {
      // Every throw is inside the generator, so the CLI's pre-read pass
      // (`readSource`) sees it before storage opens.
      if ((input.memberships === undefined) !== (input.organizations === undefined))
        throw new Error(
          "authtempo import: the WorkOS memberships input needs the organizations input, and the organizations input needs the memberships input",
        );
      // A misshaped top level is an error, never an empty list: a saved page
      // object `{ "data": [...] }` would import nothing and exit 0.
      const users = parseList(input.users, "users").map(asRecord);
      let identities: Record<string, unknown> = {};
      if (input.identities !== undefined) {
        const top = parseJson(input.identities, "WorkOS identities");
        if (typeof top !== "object" || top === null || Array.isArray(top))
          throw new Error(
            "authtempo import: the WorkOS identities input is not an object (save one object of user id to identities)",
          );
        identities = top as Record<string, unknown>;
      }
      const memberships =
        input.memberships === undefined ? [] : parseList(input.memberships, "memberships");
      const organizations =
        input.organizations === undefined
          ? []
          : parseList(input.organizations, "organizations").map(asRecord);

      // An id on two users has no known owner: neither imports.
      const idCount = new Map<string, number>();
      for (const u of users) {
        const id = str(u.id);
        if (id !== null) idCount.set(id, (idCount.get(id) ?? 0) + 1);
      }

      // The memberships, read before the users: a membership that does not
      // import is listed on its user, and the users yield first.
      const userIds = new Set(idCount.keys());
      const orgIds = new Set(organizations.map((o) => str(o.id)).filter((id) => id !== null));
      const members = new Map<string, ImportOrganization["members"]>();
      const memberDrops = new Map<string, string[]>();
      const dropOn = (userId: string, item: string) => {
        const list = memberDrops.get(userId) ?? [];
        list.push(item);
        memberDrops.set(userId, list);
      };
      for (const m of memberships.map(asRecord)) {
        const userId = str(m.user_id);
        const orgId = str(m.organization_id);
        // No user id: nothing to list it on.
        if (userId === null) continue;
        // A user id that the users file lacks: WorkOS deleted the user between
        // the two fetches of the script, and the user list is the source of
        // truth. The membership is not read, so the importer sees no conflict.
        if (!userIds.has(userId)) continue;
        // No organization id: the same as an unknown one.
        if (orgId === null || !orgIds.has(orgId)) {
          dropOn(userId, "member:unknown_organization");
          continue;
        }
        const status = str(m.status);
        // Only an active membership is a member. The others are listed with their status.
        if (status !== "active") {
          dropOn(userId, `member:${status ?? "(none)"}`);
          continue;
        }
        let slug = str(asRecord(m.role).slug);
        if (slug === null) {
          dropOn(userId, "role:unreadable");
          slug = "member";
        }
        const list = members.get(orgId) ?? [];
        list.push({ userSourceId: userId, roles: [slug] });
        members.set(orgId, list);
      }

      for (const [n, u] of users.entries()) {
        const id = str(u.id);
        // No id: no import key. Listed, never imported.
        if (id === null) {
          yield noSourceIdUser(`users[${n}]`);
          continue;
        }
        const dropped: string[] = [];
        // An identities key that is no user id is not read: WorkOS deleted the
        // user between the two fetches, and the user list is the source of truth.
        // A membership of a user id that the users file lacks is not read for
        // the same reason.
        const social = readIdentities(identities[id], dropped);
        dropped.push(...(memberDrops.get(id) ?? []));
        const first = str(u.first_name);
        const last = str(u.last_name);
        const joined = [first, last].filter((x) => x !== null).join(" ");
        // `external_id`, `metadata`, `locale`, and `last_sign_in_at` are not
        // read: `metadata` is free text of the app, and the others have no column.
        const record: ImportUser = {
          kind: "user",
          sourceId: id,
          email: str(u.email),
          // Fail closed: only the JSON value true is a verified address.
          emailVerified: u.email_verified === true,
          name: str(u.name) ?? (joined.length > 0 ? joined : null),
          // The importer keeps an https: URL only.
          image: str(u.profile_picture_url),
          createdAt: parseTime(str(u.created_at)),
          identities: social,
          // WorkOS exports no hash (owner decision 1).
          password: null,
          passkeys: [],
          dropped,
        };
        if ((idCount.get(id) ?? 0) > 1) record.skip = "duplicate_row";
        yield record;
      }

      for (const [n, o] of organizations.entries()) {
        const id = str(o.id);
        const record: ImportOrganization = {
          kind: "organization",
          sourceId: id ?? `(none) organizations[${n}]`,
          // As the export states it: the importer skips a missing name.
          name: str(o.name),
          slug: null,
          createdAt: parseTime(str(o.created_at)),
          members: id === null ? [] : (members.get(id) ?? []),
        };
        if (id === null) record.skip = "no_source_id";
        yield record;
      }
    },
  };
}
