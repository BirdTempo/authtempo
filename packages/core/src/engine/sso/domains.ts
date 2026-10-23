import { domainRecordFor } from "../../compat-seams.js";
import type { ResolvedConfig } from "../../config.js";
import { ERRORS } from "../../errors.js";
import { randomBase64Url } from "../../primitives/crypto.js";
import { isIpLiteral } from "../../primitives/host.js";
import { newId } from "../../primitives/ids.js";
import { hasControlChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import type { OperatorAuditRow, SsoDomainRow } from "../../schema.js";
import { PROVIDER_TIMEOUT_MS } from "../../social/provider.js";
import type { Meter } from "../../storage/meter.js";
import { type StorageAdapter, StorageError } from "../../storage/port.js";
import { runAfter } from "../hooks.js";
import { auditDraft, operatorAct, writeAuditIn } from "../operator/audit.js";
import { type OperatorActor, requireScope } from "../operator/guards.js";
import { lockOrganization } from "../teams.js";
import type { DnsTxtPort } from "./dns.js";
import { type SsoActor, ssoDraft } from "./guard.js";

/**
 * The email domains that an organization proves by DNS (plan 12d, spec 30
 * items 2 to 4). The file holds the domain form, the proof, the recheck, the
 * routing flags, and the operator's override of `enforce`.
 */

/** The label of the TXT record that proves a domain. */
export const DOMAIN_RECORD_LABEL = "_authtempo-challenge";
/** The start of the value of the TXT record. */
export const DOMAIN_VALUE_PREFIX = "authtempo-domain=";
/** A pending row lives 7 days (spec 30 item 2). */
export const PENDING_DOMAIN_MS = 7 * 24 * 60 * 60 * 1000;
/** A verified domain is checked again 30 days after its last check (spec 30 item 4). */
export const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** The most rows of one recheck. A sweep reads fewer when its share of calls holds fewer. */
export const RECHECK_BATCH = 20;
/** A domain is lost after this count of failed rechecks in a row... */
export const LOSS_FAILURES = 3;
/** ...that span at least this time, so one bad day of a resolver loses no domain. */
export const LOSS_SPAN_MS = 72 * 60 * 60 * 1000;
/** A failed recheck tries again one day later. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** The verifies of one organization: 10 per hour. A verify asks every resolver. */
export const DOMAIN_VERIFY_PER_ORGANIZATION = { seconds: 3600, max: 10 };
/** The app actor of the sweep in the audit row of a lost domain. */
const SWEEP_ACTOR = { kind: "app", name: "authtempo-sweep" } as const;

/** One verified or pending domain, as the routes and `api.sso.domains` answer it. */
export interface SsoDomainSummary {
  id: string;
  organizationId: string;
  domain: string;
  /** The record to publish while the row is pending, else null. */
  record: { name: string; type: "TXT"; value: string } | null;
  verified: boolean;
  verifiedAt: string | null;
  checkedAt: string | null;
  connectionId: string | null;
  enforce: boolean;
  includeSubdomains: boolean;
  expiresAt: string | null;
}

/** The name and the value of the TXT record of one row. */
function recordOf(row: Pick<SsoDomainRow, "domain" | "challenge">): {
  name: string;
  value: string;
} {
  return {
    name: `${DOMAIN_RECORD_LABEL}.${row.domain}`,
    value: `${DOMAIN_VALUE_PREFIX}${row.challenge}`,
  };
}

/** The answer form of a row. It never holds the challenge outside the record to publish. */
function summary(row: SsoDomainRow): SsoDomainSummary {
  const verified = row.claimedDomain !== null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    domain: row.domain,
    record: verified ? null : { ...recordOf(row), type: "TXT" },
    verified,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    connectionId: row.connectionId,
    enforce: row.enforce,
    includeSubdomains: row.includeSubdomains,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** The meta of an act through a route: the caller's IP and user agent. An app call passes neither. */
export interface SsoActMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** The after hook of one audit row, after the commit (deviation 3 of plan 12d). The connections call it too. */
export async function afterAudit(config: ResolvedConfig, row: OperatorAuditRow): Promise<void> {
  await runAfter("operator.afterAction", config.hooks.operator.afterAction, { audit: row }, row.id);
}

/** The longest DNS name in text form, with no trailing dot (RFC 1035 section 2.3.4). */
const DOMAIN_MAX = 253;
/** The characters that no host name holds, refused before the URL parser sees them. */
const DOMAIN_REFUSED_RE = /[*/:@\s]/;
/** One label of a lowercase host name: letters, digits, and inner hyphens, 1 to 63 characters (RFC 1123 section 2.1). */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Only ASCII: such a label must come out of the URL parser as it went in. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class is the whole ASCII range.
const ASCII_RE = /^[\u0000-\u007f]*$/;

/**
 * The lowercase A-label form of an email domain, or null (spec 30 item 2).
 * The URL parser maps a Unicode label to its IDNA A-label (`xn--`). It also
 * maps a full-width letter or a soft hyphen to ASCII. A label with such a
 * character must come out as an A-label, or it is refused. So a full-width
 * `xn--` label passes: the answer is the canonical form of the same name.
 * An ideographic dot adds a label, so it is refused too.
 * Refused: a trailing dot, `*`, `/`, `:`, `@`, and white space. Also
 * refused: a control character, an IP literal, a single label, and a label
 * that is not a host name label.
 */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > DOMAIN_MAX) return null;
  const value = raw.toLowerCase();
  // A trailing dot names the same host. One stored form keeps one claim per domain.
  if (value.endsWith(".")) return null;
  if (DOMAIN_REFUSED_RE.test(value) || hasControlChar(value)) return null;
  let host: string;
  try {
    // A host after `//` on an https base: the parser reads it as the host of an https URL.
    // The base is a reserved name, so the site's vendor scan reads no tenant host as a vendor.
    host = new URL(`//${value}`, "https://domain.invalid").hostname;
  } catch {
    return null;
  }
  const given = value.split(".");
  const mapped = host.split(".");
  if (mapped.length !== given.length) return null;
  for (let i = 0; i < given.length; i++) {
    const label = given[i] ?? "";
    const out = mapped[i] ?? "";
    // An ASCII label comes out as it went in. A Unicode label comes out as an A-label.
    if (ASCII_RE.test(label) ? out !== label : !out.startsWith("xn--")) return null;
  }
  if (isIpLiteral(host)) return null;
  // A single label is an intranet name, or a top-level domain that no organization proves.
  if (mapped.length < 2) return null;
  // An A-label is longer than its Unicode label, so the mapped host has its own length check.
  if (host.length > DOMAIN_MAX) return null;
  if (!mapped.every((l) => LABEL_RE.test(l))) return null;
  return host;
}

/**
 * True when every port gives one of `values` at `name`, each port in order
 * and each within `PROVIDER_TIMEOUT_MS`. A string of the list must equal a
 * value exactly: no trim, no case fold. A port joins the parts of one TXT
 * string itself (`DnsTxtPort`). A null, a throw, a timeout, or a list with
 * no value is a failure. The first failure ends the check with one log
 * line. The line names the port and the domain, never the challenge. `meter`
 * counts each port call as one call of the invocation (a DoH fetch is a
 * subrequest).
 */
async function everyPortGives(
  ports: readonly DnsTxtPort[],
  domain: string,
  expect: { name: string; values: readonly string[] },
  meter?: Meter,
): Promise<boolean> {
  for (const port of ports) {
    meter?.add(1);
    if (!(await portGives(port, expect))) {
      console.error("authtempo: sso domain unverified", port.name, domain);
      return false;
    }
  }
  return true;
}

/** One port within the deadline. The timer is setTimeout, so a test moves it with fake timers. */
async function portGives(
  port: DnsTxtPort,
  expect: { name: string; values: readonly string[] },
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROVIDER_TIMEOUT_MS);
  });
  try {
    const list: unknown = await Promise.race([port.txt(expect.name), deadline]);
    return (
      Array.isArray(list) && list.some((v) => typeof v === "string" && expect.values.includes(v))
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The SSO config, or `not_found` while SSO is off. */
function ssoOn(config: ResolvedConfig): Result<NonNullable<ResolvedConfig["sso"]>> {
  return config.sso ? ok(config.sso) : fail("not_found");
}

/**
 * The organization of a domain row, or null when no row has the id. A
 * route reads it to run the manager guard for that organization.
 */
export async function domainOrganization(
  config: ResolvedConfig,
  id: string,
): Promise<string | null> {
  if (!config.sso) return null;
  const row = await config.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: id }]);
  return row?.organizationId ?? null;
}

/**
 * Starts the proof of a domain (spec 30 item 2). The domain takes the form
 * of `normalizeDomain`, and its proof name fits the DNS limit of 253
 * characters, else `invalid_body`. One transaction holds the organization
 * row, then counts its rows, pending and verified, against
 * `limits.domainsPerOrganization` (`domain_limit`). A pending row of the
 * same domain gets a new challenge and a new expiry: a retry. A verified
 * row answers as it is and writes nothing. A new row and a retry write one
 * `sso_domain_add` audit row. A parallel add of the same domain answers
 * `conflict`. A retry that updates no row answers the row as it is now: a
 * parallel verify claimed it, or a parallel delete removed it (`conflict`).
 */
export async function addDomain(
  config: ResolvedConfig,
  actor: SsoActor,
  input: { organizationId: string; domain: string } & SsoActMeta,
): Promise<Result<SsoDomainSummary>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const domain = normalizeDomain(input.domain);
  if (domain === null) return fail("invalid_body");
  // The proof name must be a DNS name too, or the domain can never verify.
  if (`${DOMAIN_RECORD_LABEL}.${domain}`.length > DOMAIN_MAX) return fail("invalid_body");
  const now = config.clock.now();
  const challenge = randomBase64Url(32);
  const expiresAt = new Date(now.getTime() + PENDING_DOMAIN_MS);
  type Added = { row: SsoDomainRow; audit: OperatorAuditRow | null };
  let added: Result<Added>;
  try {
    added = await config.storage.transaction(async (tx): Promise<Result<Added>> => {
      const organization = await tx.findOne("organization", [
        { field: "id", op: "eq", value: input.organizationId },
      ]);
      // The lock holds the count below against a parallel add (the 12k limit form).
      if (!organization || !(await lockOrganization(tx, organization))) return fail("not_found");
      const held = await tx.findOne("ssoDomain", [
        { field: "organizationId", op: "eq", value: organization.id },
        { field: "domain", op: "eq", value: domain },
      ]);
      if (held?.claimedDomain != null) return ok({ row: held, audit: null });
      let row: SsoDomainRow;
      if (held) {
        row = { ...held, challenge, expiresAt, updatedAt: now };
        const n = await tx.update(
          "ssoDomain",
          [
            { field: "id", op: "eq", value: held.id },
            { field: "claimedDomain", op: "eq", value: null },
          ],
          { challenge, expiresAt, updatedAt: now },
        );
        // The row changed after the read: no new challenge and no audit row.
        if (n === 0) {
          const current = await tx.findOne("ssoDomain", [
            { field: "id", op: "eq", value: held.id },
          ]);
          return current ? ok({ row: current, audit: null }) : fail("conflict");
        }
      } else {
        const limit = sso.value.limits.domainsPerOrganization;
        const rows = await tx.findMany(
          "ssoDomain",
          [{ field: "organizationId", op: "eq", value: organization.id }],
          { limit },
        );
        if (rows.length >= limit) return fail("domain_limit");
        row = {
          id: newId(now),
          createdAt: now,
          updatedAt: now,
          organizationId: organization.id,
          domain,
          challenge,
          claimedDomain: null,
          connectionId: null,
          enforce: false,
          includeSubdomains: false,
          verifiedAt: null,
          checkedAt: null,
          failures: 0,
          firstFailureAt: null,
          expiresAt,
        };
        await tx.create("ssoDomain", row);
      }
      const draft = ssoDraft(actor, "sso_domain_add", {
        targetUserId: null,
        data: { organizationId: organization.id, domainId: row.id, domain },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      if (!draft.ok) return draft;
      return ok({ row, audit: await writeAuditIn(tx, draft.value, now) });
    });
  } catch (e) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (e instanceof StorageError && e.code === "unique_violation") return fail("conflict");
    throw e;
  }
  if (!added.ok) return added;
  if (added.value.audit) await afterAudit(config, added.value.audit);
  return ok(summary(added.value.row));
}

/** `verifyDomainWith` with core's own record of the row (spec 30 item 2). */
export async function verifyDomain(
  config: ResolvedConfig,
  actor: SsoActor,
  input: { id: string } & SsoActMeta,
): Promise<Result<SsoDomainSummary>> {
  return verifyDomainWith(config, actor, input, "own");
}

/**
 * Proves a pending domain (spec 30 item 2, deviation 12 of plan 12d). The
 * limiter `sso-domain-verify:org:<organizationId>` counts first, before any
 * resolver. A pending row past `expiresAt` answers `token_expired`. A
 * verified row answers as it is. Then every resolver of `sso.dns` must give
 * one of `expect.values` at `expect.name` (`everyPortGives`), else
 * `domain_unverified`. `record` "own" is the row's own record. "compat" is
 * the record of the compat package of this config (`withDomainRecord`, plan
 * 12d Task 14). It comes from the row's current challenge and the label of
 * its connection. So a row with a new challenge never proves itself by an
 * old record. A config with no such record answers `domain_unverified`. On success
 * one transaction claims the domain with a conditional update where
 * `claimedDomain` is null, and writes the `sso_domain_verify` audit row.
 * The unique key on `claimedDomain` gives a domain to one organization: the
 * second organization answers `domain_taken`. A parallel verify of the same
 * row updates nothing and writes no second row.
 */
export async function verifyDomainWith(
  config: ResolvedConfig,
  actor: SsoActor,
  input: { id: string } & SsoActMeta,
  record: "own" | "compat",
): Promise<Result<SsoDomainSummary>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const row = await config.storage.findOne("ssoDomain", [
    { field: "id", op: "eq", value: input.id },
  ]);
  if (!row) return fail("not_found");
  if (
    !(await config.limiter.allow(
      `sso-domain-verify:org:${row.organizationId}`,
      DOMAIN_VERIFY_PER_ORGANIZATION,
    ))
  )
    return fail("rate_limited");
  if (row.claimedDomain !== null) return ok(summary(row));
  const now = config.clock.now();
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())
    return fail("token_expired");
  const expect = record === "own" ? ownExpect(row) : await compatExpect(config, row);
  if (expect === null || !(await everyPortGives(sso.value.dns, row.domain, expect)))
    return fail("domain_unverified");
  const draft = ssoDraft(actor, "sso_domain_verify", {
    targetUserId: null,
    data: { organizationId: row.organizationId, domainId: row.id, domain: row.domain },
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  if (!draft.ok) return draft;
  const at = config.clock.now();
  const claim = {
    claimedDomain: row.domain,
    verifiedAt: at,
    checkedAt: at,
    failures: 0,
    firstFailureAt: null,
    expiresAt: null,
    updatedAt: at,
  };
  let audit: OperatorAuditRow | null;
  try {
    audit = await config.storage.transaction(async (tx) => {
      const n = await tx.update(
        "ssoDomain",
        [
          { field: "id", op: "eq", value: row.id },
          { field: "claimedDomain", op: "eq", value: null },
        ],
        claim,
      );
      // A parallel verify of this row claimed it first: nothing to write.
      if (n === 0) return null;
      return writeAuditIn(tx, draft.value, at);
    });
  } catch (e) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (e instanceof StorageError && e.code === "unique_violation") return fail("domain_taken");
    throw e;
  }
  if (audit === null) {
    const current = await config.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: row.id },
    ]);
    return current ? ok(summary(current)) : fail("not_found");
  }
  await afterAudit(config, audit);
  return ok(summary({ ...row, ...claim }));
}

/**
 * Changes the routing flags of a domain (spec 30 item 2). `connectionId`
 * names a connection of the same organization, else `not_found`, or null
 * for no route. `enforce: true` needs a verified domain
 * routed to an enabled connection of the same organization, else
 * `invalid_body`. A flag that refuses every first factor with no way in
 * through SSO would lock the staff out. One `sso_domain_update` audit row
 * names the changed keys.
 */
export async function updateDomain(
  config: ResolvedConfig,
  actor: SsoActor,
  input: {
    id: string;
    connectionId?: string | null;
    enforce?: boolean;
    includeSubdomains?: boolean;
  } & SsoActMeta,
): Promise<Result<SsoDomainSummary>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const changes: Partial<Pick<SsoDomainRow, "connectionId" | "enforce" | "includeSubdomains">> = {};
  if (input.connectionId !== undefined) changes.connectionId = input.connectionId;
  if (input.enforce !== undefined) changes.enforce = input.enforce;
  if (input.includeSubdomains !== undefined) changes.includeSubdomains = input.includeSubdomains;
  const now = config.clock.now();
  type Updated = { row: SsoDomainRow; audit: OperatorAuditRow };
  const updated = await config.storage.transaction(async (tx): Promise<Result<Updated>> => {
    const held = await tx.findOne("ssoDomain", [{ field: "id", op: "eq", value: input.id }]);
    if (!held) return fail("not_found");
    const row: SsoDomainRow = { ...held, ...changes, updatedAt: now };
    // The connection must be of the domain's own organization. Else one organization would
    // sign in the staff of another. The lock of its row comes before the domain row, so
    // a parallel delete or disable of the connection waits, or this update reads its result.
    if (row.connectionId !== null && !(await lockConnection(tx, row))) return fail("not_found");
    if (row.enforce && !(await enforceable(tx, row))) return ENFORCE_REFUSED;
    const n = await tx.update(
      "ssoDomain",
      [
        { field: "id", op: "eq", value: held.id },
        { field: "updatedAt", op: "eq", value: held.updatedAt },
      ],
      { ...changes, updatedAt: now },
    );
    if (n === 0) return fail("conflict");
    const draft = ssoDraft(actor, "sso_domain_update", {
      targetUserId: null,
      data: {
        organizationId: row.organizationId,
        domainId: row.id,
        domain: row.domain,
        changed: Object.keys(changes).sort(),
      },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    if (!draft.ok) return draft;
    return ok({ row, audit: await writeAuditIn(tx, draft.value, now) });
  });
  if (!updated.ok) return updated;
  await afterAudit(config, updated.value.audit);
  return ok(summary(updated.value.row));
}

/** The refusal of `enforce` on a domain that SSO cannot serve, with its reason for the owner. */
const ENFORCE_REFUSED: Result<never> = {
  ok: false,
  code: "invalid_body",
  status: ERRORS.invalid_body,
  message: "enforce needs a verified domain routed to an enabled connection",
};

/**
 * Locks the connection row that `row` routes to, in the caller's
 * transaction, and answers false when no such connection of the domain's
 * organization exists. The update writes `organizationId` with its own
 * value, so no field changes: the form of `lockOrganization` (ruling 34 of
 * plan 12d). On Postgres a parallel `deleteConnection` or `updateConnection`
 * waits at this lock, and so does this update at theirs. The organization
 * delete (`deleteOrganizationsRows`) deletes the connection rows before the
 * domain rows (ruling 35). The order is the connection row, then the domain
 * rows, in all four. Without the lock, an enforced domain could route to a
 * deleted or disabled connection.
 */
async function lockConnection(tx: StorageAdapter, row: SsoDomainRow): Promise<boolean> {
  if (row.connectionId === null) return false;
  const n = await tx.update(
    "ssoConnection",
    [
      { field: "id", op: "eq", value: row.connectionId },
      { field: "organizationId", op: "eq", value: row.organizationId },
    ],
    { organizationId: row.organizationId },
  );
  return n === 1;
}

/** True when the row is verified and routed to an enabled connection of its organization. */
async function enforceable(tx: StorageAdapter, row: SsoDomainRow): Promise<boolean> {
  if (row.claimedDomain === null || row.connectionId === null) return false;
  const connection = await tx.findOne("ssoConnection", [
    { field: "id", op: "eq", value: row.connectionId },
    { field: "organizationId", op: "eq", value: row.organizationId },
  ]);
  return connection?.enabled === true;
}

/** Deletes a domain and its claim (spec 30 item 2), with one `sso_domain_delete` audit row. */
export async function deleteDomain(
  config: ResolvedConfig,
  actor: SsoActor,
  input: { id: string } & SsoActMeta,
): Promise<Result<{ ok: true }>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const now = config.clock.now();
  const deleted = await config.storage.transaction(
    async (tx): Promise<Result<OperatorAuditRow>> => {
      const row = await tx.findOne("ssoDomain", [{ field: "id", op: "eq", value: input.id }]);
      if (!row) return fail("not_found");
      const n = await tx.delete("ssoDomain", [{ field: "id", op: "eq", value: row.id }]);
      if (n === 0) return fail("not_found");
      const draft = ssoDraft(actor, "sso_domain_delete", {
        targetUserId: null,
        data: { organizationId: row.organizationId, domainId: row.id, domain: row.domain },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      if (!draft.ok) return draft;
      return ok(await writeAuditIn(tx, draft.value, now));
    },
  );
  if (!deleted.ok) return deleted;
  await afterAudit(config, deleted.value);
  return ok({ ok: true });
}

/** The domains of an organization, oldest first. An organization that does not exist answers `not_found`. */
export async function listDomains(
  config: ResolvedConfig,
  _actor: SsoActor,
  input: { organizationId: string },
): Promise<Result<SsoDomainSummary[]>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: input.organizationId },
  ]);
  if (!organization) return fail("not_found");
  const rows = await config.storage.findMany(
    "ssoDomain",
    [{ field: "organizationId", op: "eq", value: organization.id }],
    { sort: { field: "id", dir: "asc" } },
  );
  return ok(rows.map(summary));
}

/**
 * The operator's override of `enforce` (deviation 5 of plan 12d). It needs
 * the scope `sso` of a secret actor, then runs through `operatorAct` with
 * the action `sso_enforce_off` and the operator's reason. A secret actor
 * and a platform operator user both pass. The row keeps its claim and its
 * route; only `enforce` turns off.
 */
export async function enforceOff(
  config: ResolvedConfig,
  actor: OperatorActor,
  input: { domainId: string; reason: string; ip: string | null; userAgent: string | null },
): Promise<Result<SsoDomainSummary & { auditId: string }>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const scoped = requireScope(actor, "sso");
  if (!scoped.ok) return scoped;
  const row = await config.storage.findOne("ssoDomain", [
    { field: "id", op: "eq", value: input.domainId },
  ]);
  if (!row) return fail("not_found");
  const draft = auditDraft(actor, {
    action: "sso_enforce_off",
    targetUserId: null,
    reason: input.reason,
    data: { organizationId: row.organizationId, domainId: row.id, domain: row.domain },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!draft.ok) return draft;
  return operatorAct(config, draft.value, async (tx) => {
    const now = config.clock.now();
    const n = await tx.update(
      "ssoDomain",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "organizationId", op: "eq", value: row.organizationId },
      ],
      { enforce: false, updatedAt: now },
    );
    if (n === 0) return fail("not_found");
    const after = await tx.findOne("ssoDomain", [{ field: "id", op: "eq", value: row.id }]);
    return after ? ok(summary(after)) : fail("not_found");
  });
}

/**
 * The worst calls of one recheck row: the update of its counters, or the
 * loss transaction with its audit row. On D1 an update in a transaction is
 * two statements: the read for the undo and the write.
 */
const RECHECK_ROW_WRITES = 3;

/**
 * Checks verified domains again (spec 30 item 4). It reads up to
 * `RECHECK_BATCH` rows with `verifiedAt` set and `checkedAt` at or before
 * `now - RECHECK_AFTER_MS`. A row with a retry due comes first, then the
 * oldest check, so a backlog of first rechecks holds no failing domain.
 * Each row asks every resolver for its own record, as the verify does, and
 * then for the compat package's record when the config has one. A
 * pass moves `checkedAt` to now and clears the failures. A failure adds one
 * to `failures`, sets `firstFailureAt` when it was null, and sets
 * `checkedAt` so that the next try comes one day later. At `LOSS_FAILURES`
 * failures that span `LOSS_SPAN_MS`, the domain is lost (`loseDomain`). The
 * answer is the count of rows checked.
 *
 * With `budget`, the step stays inside `budget.limit` calls of
 * `budget.meter` (the sweep's call budget, ruling 37 of plan 12f). Each
 * resolver call counts as one call: a DoH fetch is a subrequest. The read
 * takes the rows that fit at the least cost of a row, a check and one
 * update. A row starts only when its worst cost still fits, so a sweep
 * of passes checks more rows than a sweep of losses.
 */
export async function recheckDomains(
  config: ResolvedConfig,
  now: Date,
  budget?: { meter: Meter; limit: number },
): Promise<number> {
  const sso = config.sso;
  if (!sso) return 0;
  // A compat record is a second try: one read of the connection and each resolver again.
  const compat = domainRecordFor(config) !== null;
  const perRow = (compat ? 2 * sso.dns.length + 1 : sso.dns.length) + RECHECK_ROW_WRITES;
  const meter = budget?.meter;
  // The read and the worst cost of the first row must fit.
  if (budget && budget.meter.used + 1 + perRow > budget.limit) return 0;
  const least = sso.dns.length + 1;
  const room = budget ? Math.floor((budget.limit - budget.meter.used - 1) / least) : RECHECK_BATCH;
  const batch = Math.min(RECHECK_BATCH, room);
  const rows = await config.storage.findMany(
    "ssoDomain",
    [
      { field: "verifiedAt", op: "ne", value: null },
      { field: "checkedAt", op: "lte", value: new Date(now.getTime() - RECHECK_AFTER_MS) },
    ],
    {
      // A row with failures has a retry due; a first recheck has 0 failures.
      sort: [
        { field: "failures", dir: "desc" },
        { field: "checkedAt", dir: "asc" },
        { field: "id", dir: "asc" },
      ],
      limit: batch,
    },
  );
  meter?.step(1);
  let checked = 0;
  for (const row of rows) {
    if (budget && budget.meter.used + perRow > budget.limit) break;
    checked++;
    const passed = await rowProven(config, sso.dns, row, meter);
    const held = [
      { field: "id", op: "eq", value: row.id },
      { field: "claimedDomain", op: "eq", value: row.claimedDomain },
    ] as const;
    if (passed) {
      await config.storage.update("ssoDomain", [...held], {
        checkedAt: now,
        failures: 0,
        firstFailureAt: null,
        updatedAt: now,
      });
      meter?.step(1);
      continue;
    }
    const failures = row.failures + 1;
    const firstFailureAt = row.firstFailureAt ?? now;
    if (failures >= LOSS_FAILURES && now.getTime() - firstFailureAt.getTime() >= LOSS_SPAN_MS) {
      await loseDomain(config, row, now);
      meter?.step(RECHECK_ROW_WRITES);
      continue;
    }
    await config.storage.update("ssoDomain", [...held], {
      failures,
      firstFailureAt,
      checkedAt: new Date(now.getTime() - RECHECK_AFTER_MS + RETRY_AFTER_MS),
      updatedAt: now,
    });
    meter?.step(1);
  }
  return checked;
}

/** The row's own record: its name and value. */
function ownExpect(row: Pick<SsoDomainRow, "domain" | "challenge">): {
  name: string;
  values: readonly string[];
} {
  const own = recordOf(row);
  return { name: own.name, values: [own.value] };
}

/**
 * True when `name` is one DNS label under `domain`. A name deeper down sits
 * in a zone that the owner of a subdomain may hold, so it proves nothing
 * about the domain (review of plan 12d Task 14, M1).
 */
function childOf(name: string, domain: string): boolean {
  const suffix = `.${domain.toLowerCase()}`;
  const lower = name.toLowerCase();
  if (!lower.endsWith(suffix)) return false;
  const head = lower.slice(0, -suffix.length);
  return head !== "" && !head.includes(".");
}

/**
 * The record of the compat package for the row, or null when the config
 * has none, the function gives none, or its name is not one label under
 * the domain. A row with a connection reads the connection's label once,
 * here, and the record comes from that read: the verify and the recheck
 * each call this once. The compat package of Better Auth holds its
 * providerId in the label (ruling 61 P5).
 */
async function compatExpect(
  config: ResolvedConfig,
  row: SsoDomainRow,
  meter?: Meter,
): Promise<{ name: string; values: readonly string[] } | null> {
  const record = domainRecordFor(config);
  if (record === null) return null;
  let label: string | null = null;
  if (row.connectionId !== null) {
    const connection = await config.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: row.connectionId },
    ]);
    meter?.step(1);
    label = connection?.label ?? null;
  }
  const expect = record(row, label);
  return expect !== null && childOf(expect.name, row.domain) ? expect : null;
}

/**
 * The recheck of one row (ruling 61 F4): its own record, else the record
 * of the compat package when the config has one. So a domain that the
 * compat package proved keeps its claim. A domain that core's own route
 * proved keeps it too.
 */
async function rowProven(
  config: ResolvedConfig,
  ports: readonly DnsTxtPort[],
  row: SsoDomainRow,
  meter?: Meter,
): Promise<boolean> {
  if (await everyPortGives(ports, row.domain, ownExpect(row), meter)) return true;
  const compat = await compatExpect(config, row, meter);
  return compat !== null && (await everyPortGives(ports, row.domain, compat, meter));
}

/**
 * The loss of one domain. One transaction clears `verifiedAt`,
 * `claimedDomain`, and `enforce`, and writes the `sso_domain_lost` audit
 * row with the app actor `authtempo-sweep`. Then one log line names the
 * domain id. The row becomes a pending row with a new challenge, and it
 * lives `PENDING_DOMAIN_MS` as every pending row does (spec 30 item 2). So
 * the old record proves nothing again, and the sweep deletes a row that no
 * one proves again. The organization proves it again with the new record.
 */
async function loseDomain(config: ResolvedConfig, row: SsoDomainRow, now: Date): Promise<void> {
  const draft = ssoDraft(SWEEP_ACTOR, "sso_domain_lost", {
    targetUserId: null,
    data: { organizationId: row.organizationId, domainId: row.id, domain: row.domain },
    ip: null,
    userAgent: null,
  });
  if (!draft.ok) return;
  const audit = await config.storage.transaction(async (tx) => {
    const n = await tx.update(
      "ssoDomain",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "claimedDomain", op: "eq", value: row.claimedDomain },
      ],
      {
        claimedDomain: null,
        verifiedAt: null,
        enforce: false,
        checkedAt: now,
        failures: 0,
        firstFailureAt: null,
        challenge: randomBase64Url(32),
        expiresAt: new Date(now.getTime() + PENDING_DOMAIN_MS),
        updatedAt: now,
      },
    );
    // A delete or a change of the row since the read: nothing is lost here.
    if (n === 0) return null;
    return writeAuditIn(tx, draft.value, now);
  });
  if (audit === null) return;
  console.error("authtempo: sso domain lost", row.id);
  await afterAudit(config, audit);
}

/**
 * The verified domain row that claims the address: the exact domain, then
 * each parent with `includeSubdomains`, the most specific first. Null when
 * no verified domain claims it. One `in` read takes every candidate.
 */
export async function claimingDomain(
  storage: StorageAdapter,
  email: string,
): Promise<SsoDomainRow | null> {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = normalizeDomain(email.slice(at + 1));
  if (domain === null) return null;
  const labels = domain.split(".");
  // The domain and each parent of two labels or more, the most specific first.
  const names = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
  const rows = await storage.findMany("ssoDomain", [
    { field: "claimedDomain", op: "in", value: names },
  ]);
  for (const name of names) {
    const row = rows.find((r) => r.claimedDomain === name);
    if (row && (name === domain || row.includeSubdomains)) return row;
  }
  return null;
}

/** True when a verified domain of the organization claims the address (design 4.4). */
export async function inOrganizationDomains(
  storage: StorageAdapter,
  organizationId: string,
  email: string,
): Promise<boolean> {
  return (await claimingDomain(storage, email))?.organizationId === organizationId;
}
