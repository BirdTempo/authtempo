import type { LegacyFormat } from "@authtempo/legacy-hashes";

export type SourceName =
  | "supabase"
  | "clerk"
  | "auth0"
  | "firebase"
  | "authjs"
  | "cognito"
  | "workos";

/** A role core's default ranks name (spec 8.6). The importer maps every source role onto one. */
export type ImportRole = "owner" | "admin" | "member";

export type SkipReason =
  // The reader knows these from the export.
  | "anonymous"
  | "deleted"
  | "disabled"
  | "banned"
  /** Supabase `is_sso_user` true: a SAML user, which authtempo has no mapping for. */
  | "sso_user"
  /** Two export files of one provider disagree on this id (Clerk CSV and API, Auth0 users and hashes). */
  | "unmatched_row"
  /** One export file holds the same user id twice; no copy of it is imported. */
  | "duplicate_row"
  /** A Cognito user whose UserStatus is not CONFIRMED or EXTERNAL_PROVIDER; the reason names the status. */
  | "status_unconfirmed"
  | "status_force_change_password"
  | "status_reset_required"
  | "status_compromised"
  | "status_archived"
  | "status_unknown"
  /**
   * The record has no provider id (a Cognito sub, a Clerk or Auth0 user or
   * organization id), so it has no import key. Users and organizations.
   */
  | "no_source_id"
  // The importer finds these.
  | "no_email"
  /** An organization name outside core's rule (1 to 120 characters, no control character). */
  | "invalid_name"
  | "email_taken"
  | "identity_taken"
  | "invalid_slug"
  | "reserved_slug"
  | "slug_taken"
  | "no_owner"
  /**
   * One record holds a passkey `credentialId` twice, or a concurrent write took
   * a passkey on both attempts of a record. Core keeps one row per credential.
   */
  | "duplicate_passkey"
  | "user_not_imported"
  | "user_unverified";

/** The skips that mean "a person must look": the CLI exits 1 on any of them. */
export const CONFLICT_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  "unmatched_row",
  "duplicate_row",
  "status_compromised",
  "status_unknown",
  "no_source_id",
  "email_taken",
  "identity_taken",
  "slug_taken",
  "no_owner",
  "duplicate_passkey",
  "user_not_imported",
]);

/**
 * A skip that the importer's rules refuse, as opposed to one the export
 * states (`deleted`) or a conflict. The report counts these in `refusals`, and
 * the CLI exits 1 when the count is above zero (Task 13).
 */
export function isRefusal(reason: SkipReason): boolean {
  return reason.startsWith("invalid_") || reason.startsWith("reserved_");
}

export interface ImportPasskey {
  /** base64url, as core stores it. */
  credentialId: string;
  /** base64url COSE key, as core stores it. */
  publicKey: string;
  counter: number;
  /** Comma-joined, as core stores it. */
  transports: string | null;
  deviceType: string;
  backedUp: boolean;
  name: string | null;
}

/** One user, as a reader maps it from the provider's export. */
export interface ImportUser {
  kind: "user";
  /** The provider's own user id. It is the import key (see `importId`). */
  sourceId: string;
  /** Raw. The importer normalizes it as core does. */
  email: string | null;
  /** As the source states. Never true unless the source says the address is verified. */
  emailVerified: boolean;
  name: string | null;
  /**
   * The importer keeps only an image that passes core's `validImageUrl`. Any
   * other value is dropped and listed as `image:invalid`: a source such as
   * Supabase's user metadata lets the user write it, and core writes an image
   * only from a verified ID token.
   */
  image: string | null;
  /** Null when the export has no created date; the import time is used. */
  createdAt: Date | null;
  /** Social identities. A provider other than google, apple, github, and linkedin is dropped and listed, and so is a subject outside the provider's form (plan 9b2). */
  identities: { provider: string; subject: string }[];
  /**
   * A tagged legacy hash (`$2b$...`), `LEGACY_VERIFY_HASH` (Cognito), a
   * format the reader knows it cannot import, or no password.
   */
  password: { hash: string } | { refused: string } | null;
  /**
   * Only the Auth.js reader sets passkeys, and only when the operator states
   * that the relying party id is unchanged (a passkey binds to it). The
   * importer drops a passkey from any other source (`passkey:not_authjs`) and
   * from an unverified user (`passkey:unverified`).
   */
  passkeys: ImportPasskey[];
  /** Set by the reader for a user the export marks as not active. */
  skip?: SkipReason;
  /**
   * What the reader left out, for the report: for example `passkey:no_public_key`.
   * The importer adds `name:invalid` when the name breaks core's rule
   * (`validUserName`); it then writes the user with no name.
   */
  dropped?: string[];
}

export interface ImportOrganization {
  kind: "organization";
  sourceId: string;
  /**
   * As the export states it, never defaulted. Null when the export has no
   * name: the importer then skips the organization with `invalid_name`.
   */
  name: string | null;
  /** Null: the importer makes a slug from the name. */
  slug: string | null;
  createdAt: Date | null;
  /** In the source's order. The first admin becomes owner when no member maps to owner. */
  members: { userSourceId: string; roles: string[] }[];
  /** Set by the reader: only `no_source_id`, for an organization with no id. */
  skip?: SkipReason;
}

export type ImportRecord = ImportUser | ImportOrganization;

/** A reader's answer. Users come before organizations, so a member's user is already written. */
export interface Source {
  name: SourceName;
  /** The reader's default role map. `ImportOptions.roleMap` wins over it. */
  roles: Readonly<Record<string, ImportRole>>;
  records(): AsyncIterable<ImportRecord>;
}

export interface ImportOptions {
  /** "skip" (default) lists the record and goes on. "fail" stops the run with ImportConflictError. Never a merge. */
  onEmailTaken?: "skip" | "fail";
  /** Reads only. The report is the one a real run on the same database would give. */
  dryRun?: boolean;
  /**
   * The formats the app's `createLegacyPasswordHash` verifies: the seam's own
   * `formats` list. Required, with no default (spec 17.1): a hash imports only
   * in a format the app's seam verifies, and only the operator knows that
   * list. A hash in another format is refused and listed. An empty list
   * refuses every hash.
   */
  formats: readonly LegacyFormat[];
  /** True when the app sets `password.legacyVerify` (Cognito). Default false: the marker is refused. */
  legacyVerify?: boolean;
  /** Source role to core role. Wins over the reader's map. */
  roleMap?: Readonly<Record<string, ImportRole>>;
  /**
   * The app's `organizations.reservedSlugs`. The importer reserves these in
   * addition to core's `DEFAULT_RESERVED_SLUGS`, so a list that leaves out a
   * default never frees it. An entry that is not a slug is an error.
   */
  reservedSlugs?: readonly string[];
  /**
   * The app's `organizations.platformOrganization`. Core reserves that slug,
   * because the app seeds the platform organization and the platform role
   * trusts its members. Without it here, an imported organization could take
   * the slug before the app seeds it, and its owner would hold the platform
   * organization. Not a slug is an error.
   */
  platformSlug?: string;
  /**
   * Default false. True: a record that exists by its import id but lacks a
   * row it maps to (a `partial` entry) gets exactly the rows that `missing`
   * names, through the same key, in one transaction, and the report lists
   * them under `repaired`. Nothing else changes. A repair is refused, and the
   * entry stays `partial` with `repairRefused`, when a core flow can have
   * removed the rows on purpose (see `RepairRefusal`). Check each user in the
   * app first (plan 9b2).
   */
  repair?: boolean;
  /** For tests. Default the system time. */
  now?: () => Date;
}

/**
 * Why `repair: true` left a `partial` record as it is (plan 9b2):
 * - `verified_since_import`: the user's `emailVerified` differs from the
 *   record's, in either direction: the user is verified and the record is
 *   not, or the record is verified and the user is not. A claim verifies an
 *   unverified user and deletes the claimant's credentials (core
 *   `claimEmail`); a repair would give them back. A record that states a
 *   user verified who is not verified in the app would write an `email`
 *   identity that core makes only after a proof.
 * - `email_changed`: the user's address differs from the record's, and the
 *   repair would write an `email` identity for the old address.
 * - `credential_exists`: the record is unverified and the user holds a
 *   credential now. Core reaches no unverified user with two (spec 17.1).
 * - `identity_taken`: another user holds an identity the record maps to.
 * - `claimed`: the user is verified and holds its `email` identity, and the
 *   repair would write a password, a passkey, or a social identity. A claim
 *   always writes that identity, and the importer cannot tell a claim from a
 *   newer export, so a verified user's missing credential is an operator
 *   action. The same reason also comes from the repair's two last updates:
 *   a conditional update of the user row by the `email` and `emailVerified`
 *   that the guards read, then the activation of its pending password row.
 *   Zero rows from either means a claim or an address change landed after
 *   the guards; the repair deletes the rows it wrote and keeps the record
 *   here.
 * - `no_owner`: an organization with no member, whose members map to no owner.
 */
export type RepairRefusal =
  | "verified_since_import"
  | "email_changed"
  | "credential_exists"
  | "identity_taken"
  | "claimed"
  | "no_owner";

export interface ImportReport {
  source: SourceName;
  dryRun: boolean;
  created: Record<"user" | "identity" | "password" | "passkey" | "organization" | "member", number>;
  exists: { user: number; organization: number };
  skipped: { kind: "user" | "organization" | "member"; sourceId: string; reason: SkipReason }[];
  refusedHashes: { sourceId: string; format: string }[];
  /** What the importer left out of a record it wrote, for example `identity:github` or `role:billing->member`. */
  dropped: { sourceId: string; item: string }[];
  /** The number of `skipped` entries whose reason `isRefusal` names. */
  refusals: number;
  /**
   * A record whose id exists but whose rows are not all the rows the record
   * maps to. `missing` names each absent row kind, for example `password`,
   * `identity:email`, `passkey`, or `member`. Three causes give the same entry,
   * and the importer cannot tell them apart:
   * - A run that stopped inside the record on D1 (an isolate that dies does
   *   not roll back, spec 6).
   * - A claim since the first run: it deletes the claimant's password, social
   *   identities, and passkeys.
   * - Another app change since the first run (a removed password or passkey),
   *   or a newer export or other options (for example a row the source now
   *   states as verified, so the record maps to an `email` identity).
   * Without `repair` the importer never writes an entry's rows and never
   * counts it as `exists`. The operator checks that user in the app before a
   * repair. With `repair`, an entry stays here only with `repairRefused`. The
   * CLI exits 1 on any entry (Task 13).
   */
  partial: {
    kind: "user" | "organization";
    sourceId: string;
    missing: string[];
    repairRefused?: RepairRefusal;
  }[];
  /** The records whose missing rows `repair: true` wrote, with one row kind per row written (plan 9b2). */
  repaired: { kind: "user" | "organization"; sourceId: string; rows: string[] }[];
}

/** `onEmailTaken: "fail"` met a taken address or identity. The report holds every record before it. */
export class ImportConflictError extends Error {
  constructor(
    readonly sourceId: string,
    readonly reason: SkipReason,
    readonly report: ImportReport,
  ) {
    super(`authtempo import: ${reason} for source record ${sourceId}; the run stopped`);
    this.name = "ImportConflictError";
  }
}
