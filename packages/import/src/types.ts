import type { LegacyFormat } from "@tempo-auth/legacy-hashes";

export type SourceName = "supabase" | "clerk" | "auth0" | "firebase" | "authjs" | "cognito";

/** A role core's default ranks name (spec 8.6). The importer maps every source role onto one. */
export type ImportRole = "owner" | "admin" | "member";

export type SkipReason =
  // The reader knows these from the export.
  | "anonymous"
  | "deleted"
  | "disabled"
  | "banned"
  /** Two export files of one provider disagree on this id (Clerk CSV and API, Auth0 users and hashes). */
  | "unmatched_row"
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
   * The importer keeps only an `https:` URL of at most 2048 characters. Any
   * other value is dropped and listed as `image:invalid`: a source such as
   * Supabase's user metadata lets the user write it, and core writes an image
   * only from a verified ID token.
   */
  image: string | null;
  /** Null when the export has no created date; the import time is used. */
  createdAt: Date | null;
  /** Social identities. A provider other than google and apple is dropped and listed. */
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
   * The importer adds `name:invalid` when the name breaks core's rule (1 to 200
   * characters, no control character); it then writes the user with no name.
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
  /** The formats the app's `createLegacyPasswordHash` verifies. Default all five. A hash in another format is refused. */
  formats?: readonly LegacyFormat[];
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
  /** For tests. Default the system time. */
  now?: () => Date;
}

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
   * A record whose id exists but whose rows are not all there: a run that
   * stopped inside a record on D1 (an isolate that dies does not roll back,
   * spec 6). `missing` names each absent row, for example `password` or
   * `identity:email`. The importer never repairs it and never counts it as
   * `exists`; a person must look, and the CLI exits 1 on any entry (Task 13).
   * After cut-over a user can remove a passkey, so a re-run then lists it too.
   */
  partial: { kind: "user" | "organization"; sourceId: string; missing: string[] }[];
}

/** `onEmailTaken: "fail"` met a taken address or identity. The report holds every record before it. */
export class ImportConflictError extends Error {
  constructor(
    readonly sourceId: string,
    readonly reason: SkipReason,
    readonly report: ImportReport,
  ) {
    super(`tempo-auth import: ${reason} for source record ${sourceId}; the run stopped`);
    this.name = "ImportConflictError";
  }
}
