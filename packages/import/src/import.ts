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
import { LEGACY_FORMATS, type LegacyFormat, parseLegacyHash } from "@tempo-auth/legacy-hashes";
import { importId } from "./ids.js";
import {
  ImportConflictError,
  type ImportOptions,
  type ImportOrganization,
  type ImportReport,
  type ImportRole,
  type ImportUser,
  type SkipReason,
  type Source,
} from "./types.js";

/** Core's social providers (spec 8.3). Plan 9c adds others; until then their identities are dropped and listed. */
const SOCIAL = new Set(["google", "apple"]);
const RANK: Record<ImportRole, number> = { member: 1, admin: 2, owner: 3 };

interface Resolved {
  onEmailTaken: "skip" | "fail";
  dryRun: boolean;
  formats: ReadonlySet<LegacyFormat>;
  legacyVerify: boolean;
  roles: Readonly<Record<string, ImportRole>>;
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
  | { kind: "skip"; reason: SkipReason }
  | { kind: "write"; rows: T };

interface UserRows {
  id: string;
  email: string;
  name: string | null;
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
  };
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
 * Each record is one transaction. The key is the id `importId` derives from
 * the source id, so a second run of the same export finds every record and
 * writes nothing. A user that exists by that id is never written again, even
 * when its rows changed since: a claim may have removed a claimant's
 * credentials, and a re-run must not restore them.
 */
export async function importUsers(
  storage: StorageAdapter,
  source: Source,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const o: Resolved = {
    onEmailTaken: options.onEmailTaken ?? "skip",
    dryRun: options.dryRun ?? false,
    formats: new Set(options.formats ?? LEGACY_FORMATS),
    legacyVerify: options.legacyVerify ?? false,
    // Core's own names map to themselves; the reader's map and the caller's win over them.
    roles: {
      owner: "owner",
      admin: "admin",
      member: "member",
      ...source.roles,
      ...(options.roleMap ?? {}),
    },
    reserved: new Set(
      (options.reservedSlugs ?? DEFAULT_RESERVED_SLUGS).map((s) => normalizeSlug(s) ?? s),
    ),
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
  if (planned.users.has(id) || (await db.findOne("user", [{ field: "id", op: "eq", value: id }])))
    return { kind: "exists" };
  if (
    planned.emails.has(email) ||
    (await db.findOne("user", [{ field: "email", op: "eq", value: email }]))
  )
    return { kind: "skip", reason: "email_taken" };
  const dropped: string[] = [...(r.dropped ?? [])];
  // Core's sign-up refuses a name outside its rule, and a user with no name is
  // a state core reaches, so the importer keeps the user and drops the name.
  let name = r.name;
  if (name !== null && !validUserName(name)) {
    dropped.push("name:invalid");
    name = null;
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
    if (identities.some((x) => x.provider === i.provider && x.subject === i.subject)) continue;
    identities.push(i);
  }
  let passkeys = r.passkeys;
  if (!r.emailVerified) {
    // One credential at most: the password, else the first social identity.
    const keep = password !== null ? 0 : 1;
    for (const i of identities.splice(keep))
      dropped.push(`unverified_extra_credential:${i.provider}`);
    for (const _ of passkeys) dropped.push("passkey:unverified");
    passkeys = [];
  }
  const own = [...identities];
  if (r.emailVerified) own.push({ provider: "email", subject: email });
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
  for (const p of passkeys) {
    if (
      planned.credentials.has(p.credentialId) ||
      (await db.findOne("passkey", [{ field: "credentialId", op: "eq", value: p.credentialId }]))
    )
      dropped.push("passkey:taken");
    else kept.push(p);
  }
  return {
    kind: "write",
    rows: {
      id,
      email,
      name,
      verified: r.emailVerified,
      identities,
      password,
      passkeys: kept,
      refused,
      dropped,
    },
  };
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
    image: r.image,
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
      if (attempt === 0 && err instanceof StorageError && err.code === "unique_violation") continue;
      throw err;
    }
  }
  if (plan.kind === "exists") {
    report.exists.user++;
    return;
  }
  if (plan.kind === "skip") {
    report.skipped.push({ kind: "user", sourceId: r.sourceId, reason: plan.reason });
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
  const id = await importId("organization", source.name, r.sourceId);
  if (
    planned.orgs.has(id) ||
    (await db.findOne("organization", [{ field: "id", op: "eq", value: id }]))
  )
    return { kind: "exists" };
  // Core's organization create refuses a name outside its rule, so no import makes one.
  const name = r.name;
  if (name === null || !validOrganizationName(name))
    return { kind: "skip", reason: "invalid_name" };
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
      const mapped = o.roles[sourceRole];
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
      if (attempt === 0 && err instanceof StorageError && err.code === "unique_violation") continue;
      throw err;
    }
  }
  if (plan.kind === "exists") {
    report.exists.organization++;
    return;
  }
  if (plan.kind === "skip") {
    report.skipped.push({ kind: "organization", sourceId: r.sourceId, reason: plan.reason });
    return;
  }
  report.created.organization++;
  report.created.member += plan.rows.members.length;
  for (const s of plan.rows.skippedMembers) report.skipped.push({ kind: "member", ...s });
  for (const item of plan.rows.dropped) report.dropped.push({ sourceId: r.sourceId, item });
  planned.orgs.add(plan.rows.id);
  planned.slugs.add(plan.rows.slug);
}
