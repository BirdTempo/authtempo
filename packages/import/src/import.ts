import {
  DEFAULT_RESERVED_SLUGS,
  LEGACY_VERIFY_HASH,
  newId,
  normalizeEmail,
  normalizeSlug,
  type StorageAdapter,
  StorageError,
  validOrganizationName,
  validUserName,
} from "@tempo-auth/core";
import { type LegacyFormat, parseLegacyHash } from "@tempo-auth/legacy-hashes";
import { importId } from "./ids.js";
import {
  ImportConflictError,
  type ImportOptions,
  type ImportOrganization,
  type ImportReport,
  type ImportRole,
  type ImportUser,
  isRefusal,
  type SkipReason,
  type Source,
} from "./types.js";

/**
 * Core's social providers (spec 8.3 as amended by plan 9c), with the subject
 * form of each, as core's preset answers it. A provider outside this map is
 * dropped and listed as `identity:<provider>`. A subject outside its form is
 * dropped and listed as `identity:<provider>:subject_form`: an identity that
 * the preset can never answer would only hold the key against a real user.
 * - github: the numeric user id as decimal text. Core's preset answers
 *   `String(id)` for a positive safe integer (`social/github.ts`).
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
  ["github", (s) => /^[1-9][0-9]{0,15}$/.test(s) && Number.isSafeInteger(Number(s))],
  ["linkedin", null],
]);
const RANK: Record<ImportRole, number> = { member: 1, admin: 2, owner: 3 };
/** The longest image URL the importer keeps (M-4 of the Task 5 review). */
const IMAGE_MAX = 2048;
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

type Plan<T> =
  | { kind: "exists" }
  | { kind: "partial"; missing: string[] }
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
    partial: [],
  };
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
      throw new Error(`tempo-auth import: a reserved or platform slug is not a slug: ${s}`);
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
          `tempo-auth import: role ${from} maps to ${to}, not owner, admin, or member`,
        );
      out.set(from, to);
    }
  }
  return out;
}

/** An `https:` URL of at most IMAGE_MAX characters, or null. */
function validImage(image: string): boolean {
  if (image.length > IMAGE_MAX) return false;
  try {
    return new URL(image).protocol === "https:";
  } catch {
    return false;
  }
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
 * - An image only as an `https:` URL of at most 2048 characters.
 * - A slug outside core's reserved set, the app's `reservedSlugs`, and the
 *   app's platform organization slug.
 * Each record is one transaction. The key is the id `importId` derives from
 * the source id, so a second run of the same export finds every record and
 * writes nothing. A user that exists by that id is never written again, even
 * when its rows changed since: a claim may have removed a claimant's
 * credentials, and a re-run must not restore them. A record whose id exists
 * without all its rows is reported in `partial`, never repaired.
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
    if (record.kind === "user") await importUser(storage, source, record, o, report, planned);
    else await importOrganization(storage, source, record, o, report, planned);
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
): Promise<Plan<UserRows>> {
  if (r.skip) return { kind: "skip", reason: r.skip };
  const email = r.email === null ? null : normalizeEmail(r.email);
  if (email === null) return { kind: "skip", reason: "no_email" };
  const id = await importId("user", source.name, r.sourceId);
  if (planned.users.has(id)) return { kind: "exists" };
  const rows = userRows(source, r, id, email, o);
  if (rows === null) return { kind: "skip", reason: "duplicate_passkey" };
  const found = await db.findOne("user", [{ field: "id", op: "eq", value: id }]);
  if (found) return existingUser(db, rows);
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
  if (image !== null && !validImage(image)) {
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
 * A user that exists by its import id. It is never written again. When it
 * lacks a row its record maps to, the report lists it as `partial` with each
 * missing row kind. The importer cannot tell why a row is missing (see
 * `ImportReport.partial`), so it has no rule that turns a missing row into
 * `exists`: the operator checks the user in the app.
 */
async function existingUser(db: StorageAdapter, rows: UserRows): Promise<Plan<UserRows>> {
  const missing: string[] = [];
  const own = rows.verified
    ? [{ provider: "email", subject: rows.email }, ...rows.identities]
    : rows.identities;
  for (const i of own) {
    const row = await db.findOne("identity", [
      { field: "userId", op: "eq", value: rows.id },
      { field: "provider", op: "eq", value: i.provider },
      { field: "subject", op: "eq", value: i.subject },
    ]);
    if (!row) missing.push(`identity:${i.provider}`);
  }
  if (
    rows.password !== null &&
    !(await db.findOne("password", [{ field: "userId", op: "eq", value: rows.id }]))
  )
    missing.push("password");
  for (const p of rows.passkeys) {
    const row = await db.findOne("passkey", [
      { field: "credentialId", op: "eq", value: p.credentialId },
    ]);
    // A credential another user holds was dropped as `passkey:taken` on the first run.
    if (!row) missing.push("passkey");
  }
  return missing.length > 0 ? { kind: "partial", missing } : { kind: "exists" };
}

async function writeUser(
  tx: StorageAdapter,
  r: ImportUser,
  rows: UserRows,
  now: Date,
): Promise<void> {
  // The user row first: a password or identity row can carry a foreign key to it (plan 9).
  await tx.create("user", {
    id: rows.id,
    email: rows.email,
    emailVerified: rows.verified,
    name: rows.name,
    image: rows.image,
    createdAt: r.createdAt ?? now,
    updatedAt: now,
  });
  const identities = rows.verified
    ? [{ provider: "email", subject: rows.email }, ...rows.identities]
    : rows.identities;
  for (const i of identities) {
    await tx.create("identity", {
      id: newId(now),
      userId: rows.id,
      provider: i.provider,
      subject: i.subject,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (rows.password !== null) {
    await tx.create("password", {
      id: newId(now),
      userId: rows.id,
      hash: rows.password,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const p of rows.passkeys) {
    await tx.create("passkey", {
      id: newId(now),
      userId: rows.id,
      ...p,
      createdAt: now,
      updatedAt: now,
    });
  }
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
  let plan: Plan<UserRows> | null = null;
  for (let attempt = 0; plan === null; attempt++) {
    try {
      plan = o.dryRun
        ? await planUser(storage, source, r, o, planned)
        : await storage.transaction(async (tx) => {
            const p = await planUser(tx, source, r, o, planned);
            if (p.kind === "write") await writeUser(tx, r, p.rows, now);
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
    report.partial.push({ kind: "user", sourceId: r.sourceId, missing: plan.missing });
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
 */
function afterViolation<T>(err: unknown, attempt: number): Plan<T> | null {
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

async function planOrganization(
  db: StorageAdapter,
  source: Source,
  r: ImportOrganization,
  o: Resolved,
  planned: Planned,
): Promise<Plan<OrgRows>> {
  // A reader skip (no_source_id): with no id there is no import key.
  if (r.skip) return { kind: "skip", reason: r.skip };
  const id = await importId("organization", source.name, r.sourceId);
  if (planned.orgs.has(id)) return { kind: "exists" };
  if (await db.findOne("organization", [{ field: "id", op: "eq", value: id }])) {
    // Core reaches no organization with no member (the last-owner rule), so
    // one with none is a run that stopped between the organization row and
    // its members.
    const member = await db.findOne("member", [{ field: "organizationId", op: "eq", value: id }]);
    return member ? { kind: "exists" } : { kind: "partial", missing: ["member"] };
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
    if (!first) return { kind: "skip", reason: "no_owner" };
    first.role = "owner";
    dropped.push(`promoted_owner:${first.userId}`);
  }
  return { kind: "write", rows: { id, name, slug, members, dropped, skippedMembers } };
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
  let plan: Plan<OrgRows> | null = null;
  for (let attempt = 0; plan === null; attempt++) {
    try {
      plan = o.dryRun
        ? await planOrganization(storage, source, r, o, planned)
        : await storage.transaction(async (tx) => {
            const p = await planOrganization(tx, source, r, o, planned);
            if (p.kind !== "write") return p;
            await tx.create("organization", {
              id: p.rows.id,
              slug: p.rows.slug,
              name: p.rows.name,
              metadata: null,
              createdAt: r.createdAt ?? now,
              updatedAt: now,
            });
            for (const m of p.rows.members) {
              await tx.create("member", {
                id: newId(now),
                organizationId: p.rows.id,
                userId: m.userId,
                role: m.role,
                createdAt: now,
                updatedAt: now,
              });
            }
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
    report.partial.push({ kind: "organization", sourceId: r.sourceId, missing: plan.missing });
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
