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
  | "user_not_imported"
  | "user_unverified";

/** The skips that mean "a person must look": the CLI exits 1 on any of them. */
export const CONFLICT_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  "unmatched_row",
  "email_taken",
  "identity_taken",
  "slug_taken",
  "no_owner",
  "user_not_imported",
]);

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
  name: string;
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
  /** The app's `organizations.reservedSlugs`. Default core's list. */
  reservedSlugs?: readonly string[];
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
