import {
  claimNotStarted,
  DEFAULT_RESERVED_SLUGS,
  isGithubSubject,
  LEGACY_VERIFY_HASH,
  newId,
  normalizeEmail,
  normalizeSlug,
  PENDING_HASH_PREFIX,
  type StorageAdapter,
  StorageError,
  validImageUrl,
  validOrganizationName,
  validUserName,
} from "@authtempo/core";
// SUBJECT_MAX is the longest subject that core's social sign-in answers. A
// longer subject is dropped and listed as `identity:<provider>:subject_length`.
import { SUBJECT_MAX } from "@authtempo/core/sql";
import { type LegacyFormat, parseLegacyHash } from "@authtempo/legacy-hashes";
import { importId } from "./ids.js";
import {
  ImportConflictError,
  type ImportOptions,
  type ImportOrganization,
  type ImportReport,
  type ImportRole,
  type ImportUser,
  isRefusal,
  type RepairRefusal,
  type SkipReason,
  type Source,
} from "./types.js";

/**
 * Core's social providers (spec 8.3 as amended by plan 9c), with the subject
 * form of each, as core's preset answers it. A provider outside this map is
 * dropped and listed as `identity:<provider>`. A subject outside its form is
 * dropped and listed as `identity:<provider>:subject_form`: an identity that
 * the preset can never answer would only hold the key against a real user.
 * - github: the numeric user id as decimal text, by core's own rule
 *   (`isGithubSubject`, which core's preset also applies).
 * - linkedin: LinkedIn's OIDC `sub`. It is pairwise per client id (the
 *   discovery document's `subject_types_supported`, read 2026-10-12), so it
 *   matches only while the app keeps the same LinkedIn client id. A reader
 *   gives an id of the older LinkedIn API the name `linkedin_legacy`, which
 *   this map drops.
 */
const SOCIAL: ReadonlyMap<string, ((subject: string) => boolean) | null> = new Map<
  string,
  ((subject: string) => boolean) | null
>([
  ["google", null],
  ["apple", null],
  ["github", isGithubSubject],
  ["linkedin", null],
]);
const RANK: Record<ImportRole, number> = { member: 1, admin: 2, owner: 3 };
/**
 * The skip for a record whose write meets a unique_violation on both
 * attempts, by the model the error names. The second plan reads every key
 * again, so only a write that raced the import twice gets here.
 */
const RACE_REASON: ReadonlyMap<string, SkipReason> = new Map<string, SkipReason>([
  ["user", "email_taken"],
  ["identity", "identity_taken"],
  ["passkey", "duplicate_passkey"],
  ["organization", "slug_taken"],
]);

interface Resolved {
  onEmailTaken: "skip" | "fail";
  dryRun: boolean;
  formats: ReadonlySet<LegacyFormat>;
  legacyVerify: boolean;
  /** A Map, not an object: a source role named `constructor` or `__proto__` must miss. */
  roles: ReadonlyMap<string, ImportRole>;
  reserved: ReadonlySet<string>;
  repair: boolean;
  now: () => Date;
}

/**
 * What a dry run has planned so far. A real run writes each record before it
 * reads the next, so its reads see the earlier records; a dry run writes
 * nothing, so it keeps them here, and its report equals a real run's.
 */
interface Planned {
  users: Map<string, { verified: boolean }>;
  emails: Set<string>;
  identities: Set<string>;
  credentials: Set<string>;
  orgs: Set<string>;
  slugs: Set<string>;
}

type Plan<T, R> =
  | { kind: "exists" }
  | { kind: "partial"; missing: string[]; repairRefused?: RepairRefusal }
  | { kind: "repair"; missing: string[]; rows: R }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "write"; rows: T };

interface UserRows {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  verified: boolean;
  identities: { provider: string; subject: string }[];
  password: string | null;
  passkeys: ImportUser["passkeys"];
  refused: string | null;
  dropped: string[];
}

interface OrgRows {
  id: string;
  name: string;
  slug: string;
  members: { userId: string; role: ImportRole }[];
  dropped: string[];
  skippedMembers: { sourceId: string; reason: SkipReason }[];
}

/** A user's credential rows: all of them for a new user, the missing ones for a repair. */
interface CredentialRows {
  userId: string;
  identities: { provider: string; subject: string }[];
  password: string | null;
  passkeys: ImportUser["passkeys"];
}

/**
 * The rows a user repair writes, and the user row as the guards read it. The
 * repair checks that row again after its writes, with a conditional update
 * on `seen` (I-3 of the plan 9b2 final review).
 */
interface RepairRows extends CredentialRows {
  /** The address as the guard read it. A core user can have no address (plan 12i); an import never writes one. */
  seen: { email: string | null; emailVerified: boolean };
}

/** The ids of the rows `writeCredentials` wrote, so a write or a repair can delete exactly its own rows. */
interface Written {
  identities: string[];
  password: { id: string; hash: string } | null;
  passkeys: string[];
}

/** The member rows of an organization: all of them for a new one, all of them for a repair. */
type OrgMembers = Pick<OrgRows, "id" | "members" | "dropped" | "skippedMembers">;

function emptyReport(source: Source, dryRun: boolean): ImportReport {
  return {
    source: source.name,
    dryRun,
    created: { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 },
    exists: { user: 0, organization: 0 },
    skipped: [],
    refusedHashes: [],
    dropped: [],
    refusals: 0,
    hashFormats: {},
    partial: [],
    repaired: [],
  };
}

/** The key of a user record in `hashFormats`: the format of its hash, the reader's refused tag, or `none`. */
function hashKey(r: ImportUser): string {
  if (r.password === null) return "none";
  return "refused" in r.password ? r.password.refused : formatName(r.password.hash);
}

/**
 * Adds one to `counts[key]` as an own key. A reader's refused tag can come
 * from the export (the Clerk hasher name). A plain assignment of `__proto__`
 * would set the prototype and count nothing.
 */
function addOne(counts: Record<string, number>, key: string): void {
  const n = (Object.hasOwn(counts, key) ? (counts[key] ?? 0) : 0) + 1;
  Object.defineProperty(counts, key, {
    value: n,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function skip(
  report: ImportReport,
  kind: "user" | "organization" | "member",
  sourceId: string,
  reason: SkipReason,
): void {
  report.skipped.push({ kind, sourceId, reason });
  if (isRefusal(reason)) report.refusals++;
}

/** Each slug normalized as core does. A value that is not a slug is an error, as core's config makes it. */
function reservedSet(options: ImportOptions): Set<string> {
  const out = new Set<string>();
  const all = [
    ...DEFAULT_RESERVED_SLUGS,
    ...(options.reservedSlugs ?? []),
    ...(options.platformSlug !== undefined ? [options.platformSlug] : []),
  ];
  for (const s of all) {
    const n = normalizeSlug(s);
    if (n === null)
      throw new Error(`authtempo import: a reserved or platform slug is not a slug: ${s}`);
    out.add(n);
  }
  return out;
}

/** Core's own names map to themselves; the reader's map, then the caller's, win over them. */
function roleMap(source: Source, options: ImportOptions): Map<string, ImportRole> {
  const out = new Map<string, ImportRole>([
    ["owner", "owner"],
    ["admin", "admin"],
    ["member", "member"],
  ]);
  for (const map of [source.roles, options.roleMap ?? {}]) {
    for (const [from, to] of Object.entries(map)) {
      // The CLI reads the map from text, so a value outside core's three names is an error.
      if (!Object.hasOwn(RANK, to))
        throw new Error(
          `authtempo import: role ${from} maps to ${to}, not owner, admin, or member`,
        );
      out.set(from, to);
    }
  }
  return out;
}

/** The format name a report gives a hash it refuses: the tag, or "unknown". */
export function formatName(hash: string): string {
  if (hash === LEGACY_VERIFY_HASH) return "legacy-verify";
  const parsed = parseLegacyHash(hash);
  if (parsed) return parsed.format;
  const tag = /^\$([a-z0-9-]{1,32})\$/.exec(hash)?.[1];
  return tag ? `${tag} (malformed or out of bounds)` : "unknown";
}

/**
 * Moves users, identities, password hashes, passkeys, organizations, and
 * members from a provider's export into core's tables through the storage
 * port (spec 17). It writes only the rows a sign-up, a social sign-in, a
 * claim, or an organization create would write, so it seeds no state core
 * cannot reach:
 * - The `email` identity only for a verified user (core makes it once the
 *   address is proved).
 * - An unverified user keeps at most one credential: the password, else the
 *   first social identity. Core reaches no unverified user with two (a second
 *   method answers `email_taken_unverified`). The rest is dropped and listed.
 * - A passkey and a membership only for a verified user (registration and
 *   addMember refuse an unverified one).
 * - A hash only in a format the app's seam verifies; any other is refused and
 *   listed, and the user is imported with no password (a reset or a magic
 *   link signs them in).
 * - An organization only with an owner.
 * - A name only inside core's rule: an organization with an invalid name is
 *   skipped (`invalid_name`), and an invalid user name is dropped and listed.
 * - An image only when it passes core's `validImageUrl`.
 * - A slug outside core's reserved set, the app's `reservedSlugs`, and the
 *   app's platform organization slug.
 * Each record is one transaction. The key is the id `importId` derives from
 * the source id, so a second run of the same export finds every record and
 * writes nothing. Without `repair`, a user that exists by that id is never
 * written again, even when its rows changed since: a claim may have removed a
 * claimant's credentials, and a re-run must not restore them. A record whose
 * id exists without all its rows is reported in `partial`; with `repair` it
 * gets exactly the missing rows, unless a guard refuses (`RepairRefusal`).
 */
export async function importUsers(
  storage: StorageAdapter,
  source: Source,
  options: ImportOptions,
): Promise<ImportReport> {
  const o: Resolved = {
    onEmailTaken: options.onEmailTaken ?? "skip",
    dryRun: options.dryRun ?? false,
    // No default (spec 17.1): the list is the app seam's, and only the caller knows it.
    formats: new Set(options.formats),
    legacyVerify: options.legacyVerify ?? false,
    roles: roleMap(source, options),
    reserved: reservedSet(options),
    repair: options.repair ?? false,
    now: options.now ?? (() => new Date()),
  };
  const report = emptyReport(source, o.dryRun);
  const planned: Planned = {
    users: new Map(),
    emails: new Set(),
    identities: new Set(),
    credentials: new Set(),
    orgs: new Set(),
    slugs: new Set(),
  };
  for await (const record of source.records()) {
    if (record.kind === "user") {
      // Before any skip rule: the line counts every user record of the export.
      addOne(report.hashFormats, hashKey(record));
      await importUser(storage, source, record, o, report, planned);
    } else await importOrganization(storage, source, record, o, report, planned);
  }
  return report;
}

const key = (provider: string, subject: string) => `${provider}\u001f${subject}`;

async function planUser(
  db: StorageAdapter,
  source: Source,
  r: ImportUser,
  o: Resolved,
  planned: Planned,
): Promise<Plan<UserRows, RepairRows>> {
  if (r.skip) return { kind: "skip", reason: r.skip };
  const email = r.email === null ? null : normalizeEmail(r.email);
  if (email === null) return { kind: "skip", reason: "no_email" };
  const id = await importId("user", source.name, r.sourceId);
  if (planned.users.has(id)) return { kind: "exists" };
  const rows = userRows(source, r, id, email, o);
  if (rows === null) return { kind: "skip", reason: "duplicate_passkey" };
  const found = await db.findOne("user", [{ field: "id", op: "eq", value: id }]);
  if (found) return existingUser(db, rows, o, planned);
  if (
    planned.emails.has(email) ||
    (await db.findOne("user", [{ field: "email", op: "eq", value: email }]))
  )
    return { kind: "skip", reason: "email_taken" };
  const own = [...rows.identities];
  if (rows.verified) own.push({ provider: "email", subject: email });
  for (const i of own) {
    if (
      planned.identities.has(key(i.provider, i.subject)) ||
      (await db.findOne("identity", [
        { field: "provider", op: "eq", value: i.provider },
        { field: "subject", op: "eq", value: i.subject },
      ]))
    )
      return { kind: "skip", reason: "identity_taken" };
  }
  const kept: ImportUser["passkeys"] = [];
  for (const p of rows.passkeys) {
    if (
      planned.credentials.has(p.credentialId) ||
      (await db.findOne("passkey", [{ field: "credentialId", op: "eq", value: p.credentialId }]))
    )
      rows.dropped.push("passkey:taken");
    else kept.push(p);
  }
  return { kind: "write", rows: { ...rows, passkeys: kept } };
}

/**
 * The rows the record maps to, before any read: the same answer for a new
 * user and for one that exists by its id. Null when the record holds one
 * passkey `credentialId` twice; core keeps one row per credential.
 */
function userRows(
  source: Source,
  r: ImportUser,
  id: string,
  email: string,
  o: Resolved,
): UserRows | null {
  const dropped: string[] = [...(r.dropped ?? [])];
  // Core's sign-up refuses a name outside its rule, and a user with no name is
  // a state core reaches, so the importer keeps the user and drops the name.
  let name = r.name;
  if (name !== null && !validUserName(name)) {
    dropped.push("name:invalid");
    name = null;
  }
  let image = r.image;
  // Core's one image rule (plan 12a): the social fill, the hook patch, and the importer read it.
  if (image !== null && !validImageUrl(image)) {
    dropped.push("image:invalid");
    image = null;
  }
  let password: string | null = null;
  let refused: string | null = null;
  if (r.password && "refused" in r.password) refused = r.password.refused;
  else if (r.password) {
    const h = r.password.hash;
    const parsed = h === LEGACY_VERIFY_HASH ? null : parseLegacyHash(h);
    if (h === LEGACY_VERIFY_HASH ? o.legacyVerify : parsed !== null && o.formats.has(parsed.format))
      password = h;
    else refused = formatName(h);
  }
  const identities: { provider: string; subject: string }[] = [];
  for (const i of r.identities) {
    if (!SOCIAL.has(i.provider)) {
      dropped.push(`identity:${i.provider}`);
      continue;
    }
    const form = SOCIAL.get(i.provider);
    if (form && !form(i.subject)) {
      dropped.push(`identity:${i.provider}:subject_form`);
      continue;
    }
    if (i.subject.length > SUBJECT_MAX) {
      dropped.push(`identity:${i.provider}:subject_length`);
      continue;
    }
    if (identities.some((x) => x.provider === i.provider && x.subject === i.subject)) continue;
    identities.push(i);
  }
  let passkeys = r.passkeys;
  if (source.name !== "authjs") {
    // Only the Auth.js reader confirms the relying party id a passkey binds to.
    for (const _ of passkeys) dropped.push("passkey:not_authjs");
    passkeys = [];
  }
  if (!r.emailVerified) {
    // One credential at most: the password, else the first social identity.
    const keep = password !== null ? 0 : 1;
    for (const i of identities.splice(keep))
      dropped.push(`unverified_extra_credential:${i.provider}`);
    for (const _ of passkeys) dropped.push("passkey:unverified");
    passkeys = [];
  }
  // After both drops: a record is skipped only for a passkey it would write.
  if (new Set(passkeys.map((p) => p.credentialId)).size !== passkeys.length) return null;
  return {
    id,
    email,
    name,
    image,
    verified: r.emailVerified,
    identities,
    password,
    passkeys,
    refused,
    dropped,
  };
}

/**
 * A user that exists by its import id. Without `repair` it is never written
 * again. When it lacks a row its record maps to, the report lists it as
 * `partial` with each missing row kind. The importer cannot tell why a row
 * is missing (see `ImportReport.partial`), so with `repair` it writes the
 * missing rows only when no guard of `repairRefusal` objects.
 */
async function existingUser(
  db: StorageAdapter,
  rows: UserRows,
  o: Resolved,
  planned: Planned,
): Promise<Plan<UserRows, RepairRows>> {
  const missing: string[] = [];
  const fill: CredentialRows = { userId: rows.id, identities: [], password: null, passkeys: [] };
  const own = rows.verified
    ? [{ provider: "email", subject: rows.email }, ...rows.identities]
    : rows.identities;
  for (const i of own) {
    const row = await db.findOne("identity", [
      { field: "userId", op: "eq", value: rows.id },
      { field: "provider", op: "eq", value: i.provider },
      { field: "subject", op: "eq", value: i.subject },
    ]);
    if (!row) {
      missing.push(`identity:${i.provider}`);
      fill.identities.push(i);
    }
  }
  if (
    rows.password !== null &&
    !(await db.findOne("password", [{ field: "userId", op: "eq", value: rows.id }]))
  ) {
    missing.push("password");
    fill.password = rows.password;
  }
  for (const p of rows.passkeys) {
    const row = await db.findOne("passkey", [
      { field: "credentialId", op: "eq", value: p.credentialId },
    ]);
    // A credential another user holds was dropped as `passkey:taken` on the first run.
    // A dry run keeps the credentials of the earlier records in `planned`, as a
    // real run reads them from the rows it wrote.
    if (!row && !planned.credentials.has(p.credentialId)) {
      missing.push("passkey");
      fill.passkeys.push(p);
    }
  }
  if (missing.length === 0) return { kind: "exists" };
  if (!o.repair) return { kind: "partial", missing };
  const guard = await repairRefusal(db, rows, fill, planned);
  return "refused" in guard
    ? { kind: "partial", missing, repairRefused: guard.refused }
    : { kind: "repair", missing, rows: { ...fill, seen: guard.seen } };
}

/**
 * Why a repair must not write `fill`, or the user row as the guards read it
 * (the repair checks that row again after its writes). The cases are
 * `RepairRefusal`'s.
 */
async function repairRefusal(
  db: StorageAdapter,
  rows: UserRows,
  fill: CredentialRows,
  planned: Planned,
): Promise<{ refused: RepairRefusal } | { seen: RepairRows["seen"] }> {
  const found = await db.findOne("user", [{ field: "id", op: "eq", value: rows.id }]);
  if (!found || found.emailVerified !== rows.verified) return { refused: "verified_since_import" };
  // Both addresses are normalized: the record's by userRows, the row's by core.
  if (found.email !== rows.email && fill.identities.some((i) => i.provider === "email"))
    return { refused: "email_changed" };
  if (!rows.verified) {
    const held =
      (await db.findOne("password", [{ field: "userId", op: "eq", value: rows.id }])) ??
      (await db.findOne("identity", [
        { field: "userId", op: "eq", value: rows.id },
        { field: "provider", op: "ne", value: "email" },
      ])) ??
      (await db.findOne("passkey", [{ field: "userId", op: "eq", value: rows.id }]));
    if (held) return { refused: "credential_exists" };
  }
  for (const i of fill.identities) {
    // A dry run keeps the identities of the earlier records in `planned`, as a
    // real run reads them from the rows it wrote.
    const held =
      planned.identities.has(key(i.provider, i.subject)) ||
      (await db.findOne("identity", [
        { field: "provider", op: "eq", value: i.provider },
        { field: "subject", op: "eq", value: i.subject },
      ]));
    if (held) return { refused: "identity_taken" };
  }
  // The importer stores no state from the first run, so it cannot tell a claim
  // from a newer export. A claim always writes the `email` identity, so a
  // verified user that holds it gets no credential back from a repair.
  if (
    found.emailVerified &&
    !fill.identities.some((i) => i.provider === "email") &&
    (fill.password !== null || fill.passkeys.length > 0 || fill.identities.length > 0)
  )
    return { refused: "claimed" };
  return { seen: { email: found.email, emailVerified: found.emailVerified } };
}

/** The identity, password, and passkey rows of one user, as a sign-up, a social sign-in, or a claim writes them. */
async function writeCredentials(
  tx: StorageAdapter,
  c: CredentialRows,
  now: Date,
  /**
   * A repair, and the write of an unverified user, write the password row
   * pending (`PENDING_HASH_PREFIX`) and activate it last.
   */
  pending = false,
): Promise<Written> {
  const written: Written = { identities: [], password: null, passkeys: [] };
  for (const i of c.identities) {
    const id = newId(now);
    written.identities.push(id);
    await tx.create("identity", {
      id,
      userId: c.userId,
      provider: i.provider,
      subject: i.subject,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (c.password !== null) {
    const id = newId(now);
    const hash = pending ? `${PENDING_HASH_PREFIX}${c.password}` : c.password;
    written.password = { id, hash };
    await tx.create("password", {
      id,
      userId: c.userId,
      hash,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const p of c.passkeys) {
    const id = newId(now);
    written.passkeys.push(id);
    await tx.create("passkey", {
      id,
      userId: c.userId,
      ...p,
      // The extension flags of plan 12i: no export holds them.
      discoverable: null,
      prf: false,
      largeBlob: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  return written;
}

/**
 * The last statement of a write or a repair: the activation of the pending
 * password row, by its id and the pending string. True when it updated the
 * row, or when the write holds no password. Zero rows means a claim deleted
 * the pending row, or a reset wrote the owner's hash into it.
 */
async function activated(
  tx: StorageAdapter,
  written: Written,
  hash: string | null,
  now: Date,
): Promise<boolean> {
  if (written.password === null) return true;
  return (
    (await tx.update(
      "password",
      [
        { field: "id", op: "eq", value: written.password.id },
        { field: "hash", op: "eq", value: written.password.hash },
      ],
      { hash: hash as string, updatedAt: now },
    )) > 0
  );
}

/**
 * Deletes the rows that `writeCredentials` wrote, by id. The password row
 * goes also by the string it wrote: an owner's reset can keep a row id and
 * write the owner's hash. The caller then commits, with no throw. On D1 a
 * throw runs the adapter's undo log, which deletes a created row by its id
 * only. That undo does not check what a claim or a reset wrote into the row
 * since.
 */
async function deleteWritten(tx: StorageAdapter, written: Written): Promise<void> {
  for (const id of written.identities)
    await tx.delete("identity", [{ field: "id", op: "eq", value: id }]);
  if (written.password !== null)
    await tx.delete("password", [
      { field: "id", op: "eq", value: written.password.id },
      { field: "hash", op: "eq", value: written.password.hash },
    ]);
  for (const id of written.passkeys)
    await tx.delete("passkey", [{ field: "id", op: "eq", value: id }]);
}

/**
 * Writes the missing rows of a user. Then a conditional update of the user
 * row, by its id and by the `email` and `emailVerified` that the guards
 * read. It comes from I-3 of the plan 9b2 final review. For an unverified
 * user, then core's claim check (`claimNotStarted`). Last, the activation
 * of the password row. This is the pattern of core's sign-up
 * (`engine/password.ts`, `insertSignUp`).
 * - The password row goes in pending (`PENDING_HASH_PREFIX`), and a sign-in
 *   refuses a pending row. On D1 the writes are visible at once. So a row
 *   with the real hash could sign a claimant in before the checks (fix round
 *   2). A passkey and a social identity go in active. A passkey needs the
 *   authenticator, and a social identity needs the provider's login. The
 *   window is a few D1 round trips (spec 17.1).
 * - A claim (core `claimEmail`) runs in the order of ruling 16 of plan 12p.
 *   Its first statement is the hold, or the lease on D1. Then it deletes the
 *   claimant's credentials, flips `emailVerified`, and deletes the sessions.
 * - On D1 a claim can delete before these writes and flip after the update
 *   of the user row. So that update alone misses it, and the claim check
 *   reads its lease. The update still catches an address change.
 * - Zero rows from the update, false from the check, or zero rows from the
 *   activation means that a claim or an address change landed. The repair
 *   then deletes its own rows by id (`deleteWritten`) and commits. The
 *   record stays `partial` with `claimed`. It never throws to undo, as
 *   core's sign-up never does.
 * - On Postgres the update holds the row lock until the commit, so a
 *   claim's hold waits, and its delete then sees these rows. On D1 a claim
 *   whose lease comes after the check deletes these rows before its flip.
 */
async function repairUser(
  tx: StorageAdapter,
  p: Extract<Plan<UserRows, RepairRows>, { kind: "repair" }>,
  now: Date,
): Promise<Plan<UserRows, RepairRows>> {
  const written = await writeCredentials(tx, p.rows, now, true);
  const { seen } = p.rows;
  const kept = await tx.update(
    "user",
    [
      { field: "id", op: "eq", value: p.rows.userId },
      { field: "email", op: "eq", value: seen.email },
      { field: "emailVerified", op: "eq", value: seen.emailVerified },
    ],
    { updatedAt: now },
  );
  // A verified user has no claim. An unverified one gets the check before the activation.
  const unclaimed =
    kept > 0 &&
    (seen.emailVerified ||
      (await claimNotStarted(tx, { id: p.rows.userId, email: seen.email }, now)));
  if (unclaimed && (await activated(tx, written, p.rows.password, now))) return p;
  await deleteWritten(tx, written);
  return { kind: "partial", missing: p.missing, repairRefused: "claimed" };
}

/**
 * Writes a new user, then its rows. A verified user has no claim, so its
 * rows go in active with no check. For an unverified user the password row
 * goes in pending. After its password or identity write, core's claim check
 * runs (`claimNotStarted`), then the activation, as in `repairUser`.
 * - On D1 a claim can read the new user before this transaction ends. It
 *   can delete before these writes and flip after them, so the claimant's
 *   row would stay on the owner's account (probe I1 of review-12p-fix34).
 * - False from the check, or zero rows from the activation, deletes the
 *   rows of this write by id, and the record is `partial` with `claimed`.
 *   The user row stays: after a claim it is the owner's.
 */
async function writeUser(
  tx: StorageAdapter,
  r: ImportUser,
  p: Extract<Plan<UserRows, RepairRows>, { kind: "write" }>,
  now: Date,
): Promise<Plan<UserRows, RepairRows>> {
  const rows = p.rows;
  // The user row first: a password or identity row can carry a foreign key to it (plan 9).
  await tx.create("user", {
    id: rows.id,
    email: rows.email,
    emailVerified: rows.verified,
    name: rows.name,
    image: rows.image,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: r.createdAt ?? now,
    updatedAt: now,
  });
  const written = await writeCredentials(
    tx,
    {
      userId: rows.id,
      identities: rows.verified
        ? [{ provider: "email", subject: rows.email }, ...rows.identities]
        : rows.identities,
      password: rows.password,
      passkeys: rows.passkeys,
    },
    now,
    !rows.verified,
  );
  // An unverified user keeps no passkey (`userRows`), so its rows are a password or an identity.
  if (rows.verified || (written.password === null && written.identities.length === 0)) return p;
  if (
    (await claimNotStarted(tx, { id: rows.id, email: rows.email }, now)) &&
    (await activated(tx, written, rows.password, now))
  )
    return p;
  await deleteWritten(tx, written);
  const missing = rows.identities.map((i) => `identity:${i.provider}`);
  if (rows.password !== null) missing.push("password");
  return { kind: "partial", missing, repairRefused: "claimed" };
}

function count(report: ImportReport, rows: UserRows): void {
  report.created.user++;
  report.created.identity += rows.identities.length + (rows.verified ? 1 : 0);
  if (rows.password !== null) report.created.password++;
  report.created.passkey += rows.passkeys.length;
}

/**
 * Plans inside the transaction and writes there, so the reads and the writes
 * see one state. A unique_violation (an app sign-up raced the import) is
 * caught outside the transaction, never inside (plan 3 rule: Postgres has
 * aborted it), and the record is planned once more, so the report names the
 * winner's row.
 */
async function importUser(
  storage: StorageAdapter,
  source: Source,
  r: ImportUser,
  o: Resolved,
  report: ImportReport,
  planned: Planned,
): Promise<void> {
  const now = o.now();
  let plan: Plan<UserRows, RepairRows> | null = null;
  for (let attempt = 0; plan === null; attempt++) {
    try {
      plan = o.dryRun
        ? await planUser(storage, source, r, o, planned)
        : await storage.transaction(async (tx) => {
            const p = await planUser(tx, source, r, o, planned);
            if (p.kind === "write") return writeUser(tx, r, p, now);
            if (p.kind === "repair") return repairUser(tx, p, now);
            return p;
          });
    } catch (err) {
      plan = afterViolation(err, attempt);
      if (plan === null) continue;
    }
  }
  if (plan.kind === "exists") {
    report.exists.user++;
    return;
  }
  if (plan.kind === "partial") {
    report.partial.push({
      kind: "user",
      sourceId: r.sourceId,
      missing: plan.missing,
      ...(plan.repairRefused !== undefined ? { repairRefused: plan.repairRefused } : {}),
    });
    return;
  }
  if (plan.kind === "repair") {
    report.repaired.push({ kind: "user", sourceId: r.sourceId, rows: plan.missing });
    // A dry run plans the next records against these rows, as a real run reads them.
    for (const i of plan.rows.identities) planned.identities.add(key(i.provider, i.subject));
    for (const p of plan.rows.passkeys) planned.credentials.add(p.credentialId);
    // A second record with this id is `exists`, in a dry run as in a real run.
    planned.users.set(plan.rows.userId, { verified: r.emailVerified });
    return;
  }
  if (plan.kind === "skip") {
    skip(report, "user", r.sourceId, plan.reason);
    // What the reader left out, also for a skipped user: for example the raw
    // Cognito status of a status_unknown user, which the operator must see.
    for (const item of r.dropped ?? []) report.dropped.push({ sourceId: r.sourceId, item });
    if (
      o.onEmailTaken === "fail" &&
      (plan.reason === "email_taken" || plan.reason === "identity_taken")
    )
      throw new ImportConflictError(r.sourceId, plan.reason, report);
    return;
  }
  const rows = plan.rows;
  count(report, rows);
  if (rows.refused !== null)
    report.refusedHashes.push({ sourceId: r.sourceId, format: rows.refused });
  for (const item of rows.dropped) report.dropped.push({ sourceId: r.sourceId, item });
  planned.users.set(rows.id, { verified: rows.verified });
  planned.emails.add(rows.email);
  for (const i of rows.identities) planned.identities.add(key(i.provider, i.subject));
  if (rows.verified) planned.identities.add(key("email", rows.email));
  for (const p of rows.passkeys) planned.credentials.add(p.credentialId);
}

/**
 * The catch outside the transaction. A first unique_violation (an app write
 * raced the import) answers null: plan the record once more, and the second
 * plan sees the winner's row. A second one skips the record by the model the
 * error names, so the run goes on and the report stays whole. Any other error
 * stops the run.
 * An organization repair that meets a unique_violation on a member row needs
 * no other code: the second plan finds the member that the other write made,
 * so the organization is `exists`. Only a second violation throws (`member` is
 * not in RACE_REASON), as for a new organization.
 */
function afterViolation<T, R>(err: unknown, attempt: number): Plan<T, R> | null {
  if (!(err instanceof StorageError) || err.code !== "unique_violation") throw err;
  if (attempt === 0) return null;
  const reason = RACE_REASON.get(err.model);
  if (reason === undefined) throw err;
  return { kind: "skip", reason };
}

/** A slug from a name: NFKC, lower case, every run of other characters a hyphen, at most 64 characters. */
export function slugFrom(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}

/**
 * The member rows of an organization record, with the role map and the
 * owner rule. Null when no member maps to an owner and no admin can become
 * one (the record is skipped, or a repair refused, as `no_owner`).
 */
async function planMembers(
  db: StorageAdapter,
  source: Source,
  r: ImportOrganization,
  o: Resolved,
  planned: Planned,
): Promise<Omit<OrgMembers, "id"> | null> {
  const members: OrgRows["members"] = [];
  const dropped: string[] = [];
  const skippedMembers: OrgRows["skippedMembers"] = [];
  for (const m of r.members) {
    const userId = await importId("user", source.name, m.userSourceId);
    const known =
      planned.users.get(userId) ??
      (await db
        .findOne("user", [{ field: "id", op: "eq", value: userId }])
        .then((u) => (u ? { verified: u.emailVerified } : undefined)));
    if (!known) {
      skippedMembers.push({ sourceId: m.userSourceId, reason: "user_not_imported" });
      continue;
    }
    if (!known.verified) {
      skippedMembers.push({ sourceId: m.userSourceId, reason: "user_unverified" });
      continue;
    }
    if (members.some((x) => x.userId === userId)) continue;
    let role: ImportRole | null = null;
    for (const sourceRole of m.roles) {
      const mapped = o.roles.get(sourceRole);
      if (!mapped) dropped.push(`role:${sourceRole}->member`);
      const rank = mapped ?? "member";
      if (role === null || RANK[rank] > RANK[role]) role = rank;
    }
    if (role === null) {
      dropped.push("role:none->member");
      role = "member";
    }
    members.push({ userId, role });
  }
  if (!members.some((m) => m.role === "owner")) {
    const first = members.find((m) => m.role === "admin");
    if (!first) return null;
    first.role = "owner";
    dropped.push(`promoted_owner:${first.userId}`);
  }
  return { members, dropped, skippedMembers };
}

async function planOrganization(
  db: StorageAdapter,
  source: Source,
  r: ImportOrganization,
  o: Resolved,
  planned: Planned,
): Promise<Plan<OrgRows, OrgMembers>> {
  // A reader skip (no_source_id): with no id there is no import key.
  if (r.skip) return { kind: "skip", reason: r.skip };
  const id = await importId("organization", source.name, r.sourceId);
  if (planned.orgs.has(id)) return { kind: "exists" };
  if (await db.findOne("organization", [{ field: "id", op: "eq", value: id }])) {
    // Core reaches no organization with no member (the last-owner rule), so
    // one with none is a run that stopped between the organization row and
    // its members.
    const member = await db.findOne("member", [{ field: "organizationId", op: "eq", value: id }]);
    if (member) return { kind: "exists" };
    if (!o.repair) return { kind: "partial", missing: ["member"] };
    const m = await planMembers(db, source, r, o, planned);
    return m === null
      ? { kind: "partial", missing: ["member"], repairRefused: "no_owner" }
      : { kind: "repair", missing: ["member"], rows: { id, ...m } };
  }
  // Core's organization create refuses a name outside its rule, so no import makes one.
  const name = r.name;
  if (name === null || !validOrganizationName(name))
    return { kind: "skip", reason: "invalid_name" };
  // The source's slug when the export has one, else one from the name. A
  // name with no ASCII letter or digit gives none: the skip is a refusal, so
  // the CLI exits 1 and a person sets the slug.
  const slug = normalizeSlug(r.slug ?? slugFrom(name));
  if (slug === null) return { kind: "skip", reason: "invalid_slug" };
  if (o.reserved.has(slug)) return { kind: "skip", reason: "reserved_slug" };
  if (
    planned.slugs.has(slug) ||
    (await db.findOne("organization", [{ field: "slug", op: "eq", value: slug }]))
  )
    return { kind: "skip", reason: "slug_taken" };
  const m = await planMembers(db, source, r, o, planned);
  if (m === null) return { kind: "skip", reason: "no_owner" };
  return { kind: "write", rows: { id, name, slug, ...m } };
}

async function writeMembers(
  tx: StorageAdapter,
  organizationId: string,
  members: OrgRows["members"],
  now: Date,
): Promise<void> {
  for (const m of members) {
    await tx.create("member", {
      id: newId(now),
      organizationId,
      userId: m.userId,
      role: m.role,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function importOrganization(
  storage: StorageAdapter,
  source: Source,
  r: ImportOrganization,
  o: Resolved,
  report: ImportReport,
  planned: Planned,
): Promise<void> {
  const now = o.now();
  let plan: Plan<OrgRows, OrgMembers> | null = null;
  for (let attempt = 0; plan === null; attempt++) {
    try {
      plan = o.dryRun
        ? await planOrganization(storage, source, r, o, planned)
        : await storage.transaction(async (tx) => {
            const p = await planOrganization(tx, source, r, o, planned);
            if (p.kind === "repair") await writeMembers(tx, p.rows.id, p.rows.members, now);
            if (p.kind !== "write") return p;
            await tx.create("organization", {
              id: p.rows.id,
              slug: p.rows.slug,
              name: p.rows.name,
              metadata: null,
              createdAt: r.createdAt ?? now,
              updatedAt: now,
            });
            await writeMembers(tx, p.rows.id, p.rows.members, now);
            return p;
          });
    } catch (err) {
      plan = afterViolation(err, attempt);
      if (plan === null) continue;
    }
  }
  if (plan.kind === "exists") {
    report.exists.organization++;
    return;
  }
  if (plan.kind === "partial") {
    report.partial.push({
      kind: "organization",
      sourceId: r.sourceId,
      missing: plan.missing,
      ...(plan.repairRefused !== undefined ? { repairRefused: plan.repairRefused } : {}),
    });
    return;
  }
  if (plan.kind === "repair") {
    report.repaired.push({
      kind: "organization",
      sourceId: r.sourceId,
      rows: plan.rows.members.map(() => "member"),
    });
    for (const s of plan.rows.skippedMembers) skip(report, "member", s.sourceId, s.reason);
    for (const item of plan.rows.dropped) report.dropped.push({ sourceId: r.sourceId, item });
    planned.orgs.add(plan.rows.id);
    return;
  }
  if (plan.kind === "skip") {
    skip(report, "organization", r.sourceId, plan.reason);
    return;
  }
  report.created.organization++;
  report.created.member += plan.rows.members.length;
  for (const s of plan.rows.skippedMembers) skip(report, "member", s.sourceId, s.reason);
  for (const item of plan.rows.dropped) report.dropped.push({ sourceId: r.sourceId, item });
  planned.orgs.add(plan.rows.id);
  planned.slugs.add(plan.rows.slug);
}
