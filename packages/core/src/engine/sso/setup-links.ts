import type { ResolvedConfig } from "../../config.js";
import { ERRORS } from "../../errors.js";
import { SETUP_LINK_PREFIX } from "../../primitives/credentials.js";
import { randomToken, sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import { hasControlChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import {
  type MemberRow,
  type OperatorAuditRow,
  SETUP_STEPS,
  SETUP_TTL_HOURS_MAX,
  type SetupStep,
  type SsoSetupLinkRow,
} from "../../schema.js";
import { findManyIn } from "../../storage/batch.js";
import type { Where } from "../../storage/port.js";
import { runAfter } from "../hooks.js";
import { sendNotice } from "../notices.js";
import { writeAuditIn } from "../operator/audit.js";
import { isOwner, rankOf } from "../ranks.js";
import { tokenHint } from "../tokens.js";
import { afterAudit, type SsoActMeta } from "./domains.js";
import { recheckSsoManager, type SsoActor, ssoDraft } from "./guard.js";
import { lockSetupRows } from "./setup-live.js";
import type { SetupSession } from "./setup-session.js";

/**
 * The setup links of an organization (plan 13a, spec 6.1). A manager mints
 * a link and gives it to an IT admin, who makes draft rows through it. A
 * link token is a credential. Core stores its SHA-256 hex only, shows the
 * clear token once, and never puts the token or the hash in a log line or
 * an audit row.
 */

/**
 * The live links of one organization: two, so a manager can mint the next
 * link before the revoke of the old one, and a flood is not possible (spec
 * 6.1 item 4). A revoked, ended, or expired link does not count.
 */
export const SETUP_LINKS_LIVE_MAX = 2;
/** The most rows of one list, newest first. A list never holds the token or its hash. */
export const SETUP_LINKS_LIST_MAX = 100;
/** The note names the IT contact: 1 to 80 characters (spec 6.1 item 2). */
const NOTE_MAX = 80;
const HOUR_MS = 3_600_000;
const KINDS = ["oidc", "saml"] as const;

/** One setup link as a manager reads it. It names each field, so the hash never reaches an answer. */
export interface SetupLinkSummary {
  id: string;
  organizationId: string;
  hint: string;
  steps: SetupStep[];
  kinds: ("oidc" | "saml")[];
  note: string;
  createdBy: string;
  expiresAt: string;
  revokedAt: string | null;
  endedAt: string | null;
  openedAt: string | null;
  readyAt: string | null;
  createdAt: string;
}

function summary(row: SsoSetupLinkRow): SetupLinkSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    hint: row.hint,
    steps: [...row.steps],
    kinds: [...row.kinds],
    note: row.note,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    openedAt: row.openedAt?.toISOString() ?? null,
    readyAt: row.readyAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `invalid_body` with a message that names the field. */
function refuse(message: string): Result<never> {
  return { ok: false, code: "invalid_body", status: ERRORS.invalid_body, message };
}

/** The setup config, or `not_found` while SSO or `sso.setup` is off. */
function setupOn(config: ResolvedConfig): Result<{ ttlHours: number }> {
  const setup = config.sso?.setup;
  return setup ? ok(setup) : fail("not_found");
}

/** A non-empty list of distinct values of `allowed`, else null. */
function distinctOf<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v) => (allowed as readonly unknown[]).includes(v))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...(value as T[])];
}

/** The name of the actor in `createdBy`: the user id, or the app name. */
function makerOf(actor: SsoActor): string {
  return actor.kind === "app" ? actor.name : actor.user.id;
}

/**
 * Mints a setup link (spec 6.1 items 2 to 4). The checks, in this order:
 * `sso.setup` is on, else `not_found`. The steps and the kinds are
 * non-empty lists of distinct values, and each kind is on in `sso`. The
 * `ttlHours` is an integer from 1 to 168, absent for the default of
 * `sso.setup.ttlHours`. The note has 1 to 80 characters and no control
 * character. Each refusal of these answers `invalid_body`. The actor must
 * still manage the organization (`recheckSsoManager`). One transaction
 * locks the organization row, counts its live links against
 * `SETUP_LINKS_LIVE_MAX` (`setup_link_limit`), writes the row, and writes
 * the `sso_setup_link_create` audit row. The answer holds the clear token,
 * the one time it leaves core.
 */
export async function createSetupLink(
  config: ResolvedConfig,
  actor: SsoActor,
  input: {
    organizationId: string;
    steps: SetupStep[];
    kinds: ("oidc" | "saml")[];
    ttlHours?: number | undefined;
    note: string;
  },
  meta: SsoActMeta = {},
): Promise<Result<{ id: string; token: string; expiresAt: Date }>> {
  const setup = setupOn(config);
  if (!setup.ok) return setup;
  const steps = distinctOf(input.steps, SETUP_STEPS);
  if (steps === null)
    return refuse(`steps must be a non-empty list of distinct steps of ${SETUP_STEPS.join(", ")}`);
  const sso = config.sso;
  const on = KINDS.filter((k) =>
    k === "oidc" ? sso?.oidc === true : (sso?.saml ?? null) !== null,
  );
  const kinds = distinctOf(input.kinds, on);
  if (kinds === null)
    return refuse(
      `kinds must be a non-empty list of distinct kinds that sso has on: ${on.join(", ")}`,
    );
  const hours: unknown = input.ttlHours ?? setup.value.ttlHours;
  if (
    typeof hours !== "number" ||
    !Number.isSafeInteger(hours) ||
    hours < 1 ||
    hours > SETUP_TTL_HOURS_MAX
  )
    return refuse(`ttlHours must be an integer from 1 to ${SETUP_TTL_HOURS_MAX}`);
  const note: unknown = input.note;
  if (typeof note !== "string" || note.length < 1 || note.length > NOTE_MAX || hasControlChar(note))
    return refuse(`note must be 1 to ${NOTE_MAX} characters with no control character`);
  const still = await recheckSsoManager(config, actor, input.organizationId);
  if (!still.ok) return still;
  const now = config.clock.now();
  const token = randomToken(SETUP_LINK_PREFIX);
  const row: SsoSetupLinkRow = {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    organizationId: input.organizationId,
    tokenHash: await sha256Hex(token),
    hint: tokenHint(SETUP_LINK_PREFIX, token),
    steps,
    kinds,
    note,
    createdBy: makerOf(actor),
    expiresAt: new Date(now.getTime() + hours * HOUR_MS),
    revokedAt: null,
    endedAt: null,
    openedAt: null,
    readyAt: null,
    // Plan 13b: Task 9 sets the expiry fields.
    expiryStage: null,
    expiryNoticeAt: null,
  };
  const created = await config.storage.transaction(
    async (tx): Promise<Result<OperatorAuditRow>> => {
      // The lock holds the count below against a parallel mint (the 12k limit form). The new link
      // row comes after the organization row (ruling R22 of plan 13a).
      const locked = await lockSetupRows(tx, input.organizationId, null);
      if (!locked.ok) return locked;
      const organization = locked.value;
      const live = await tx.findMany(
        "ssoSetupLink",
        [
          { field: "organizationId", op: "eq", value: organization.id },
          { field: "revokedAt", op: "eq", value: null },
          { field: "endedAt", op: "eq", value: null },
          { field: "expiresAt", op: "gt", value: now },
        ],
        { limit: SETUP_LINKS_LIVE_MAX },
      );
      if (live.length >= SETUP_LINKS_LIVE_MAX) return fail("setup_link_limit");
      await tx.create("ssoSetupLink", row);
      const draft = ssoDraft(actor, "sso_setup_link_create", {
        targetUserId: null,
        data: {
          organizationId: row.organizationId,
          linkId: row.id,
          steps,
          kinds,
          expiresAt: row.expiresAt.toISOString(),
        },
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      if (!draft.ok) return draft;
      return ok(await writeAuditIn(tx, draft.value, now));
    },
  );
  if (!created.ok) return created;
  await afterAudit(config, created.value);
  return ok({ id: row.id, token, expiresAt: row.expiresAt });
}

/**
 * Revokes a setup link (spec 6.1 item 7). The actor must still manage the
 * organization of the link. One transaction locks the organization row,
 * sets `revokedAt` on the link where it is not revoked and not ended
 * (`lockSetupRows`), sets `endedAt` on each live setup
 * session of the link, deletes the pending SCIM token of the link, and writes the `sso_setup_link_revoke` audit row.
 * So the next request of such a session fails, and no draft write lands
 * after the revoke. A link that is revoked or ended already answers ok and
 * writes nothing. An unknown id answers `not_found`.
 */
export async function revokeSetupLink(
  config: ResolvedConfig,
  actor: SsoActor,
  id: string,
  meta: SsoActMeta = {},
): Promise<Result<void>> {
  const setup = setupOn(config);
  if (!setup.ok) return setup;
  const link = await config.storage.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: id }]);
  if (!link) return fail("not_found");
  const still = await recheckSsoManager(config, actor, link.organizationId);
  if (!still.ok) return still;
  const draft = ssoDraft(actor, "sso_setup_link_revoke", {
    targetUserId: null,
    data: { organizationId: link.organizationId, linkId: link.id },
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  if (!draft.ok) return draft;
  const now = config.clock.now();
  const revoked = await config.storage.transaction(async (tx): Promise<OperatorAuditRow | null> => {
    // The organization row, then the link row, then the session rows (ruling R22 of plan 13a).
    // An expired link is revoked too. A parallel revoke, an activation, or a hand back ended the
    // link first, or a parallel delete removed the organization: nothing to write.
    const held = await lockSetupRows(tx, link.organizationId, {
      id: link.id,
      now,
      set: { revokedAt: now },
      whenExpired: "accept",
    });
    if (!held.ok) return null;
    await tx.update(
      "ssoSetupSession",
      [
        { field: "linkId", op: "eq", value: link.id },
        { field: "endedAt", op: "eq", value: null },
      ],
      { endedAt: now, updatedAt: now },
    );
    // The pending SCIM token of the link opens no directory, but it holds one of the live slots
    // of the organization (`SCIM_TOKENS_LIVE_MAX`) until some flow removes it. After the revoke
    // no setup session of the link can make or read it, so it goes here (security review M2).
    await tx.delete("scimToken", [
      { field: "setupLinkId", op: "eq", value: link.id },
      { field: "pending", op: "eq", value: true },
    ]);
    return writeAuditIn(tx, draft.value, now);
  });
  if (revoked) await afterAudit(config, revoked);
  return ok(undefined);
}

/**
 * The owner scan of a hand back (ruling R23 of plan 13a): every owner gets the notice, so the scan
 * reads all pages of the members of the organization. `pageSize` is one read. `maxPages` is a
 * safety bound (1000 pages, 100000 members at the default), not a rule: a scan that hits it
 * writes one warning line, and the owners after it get no mail. It is an object so a test sets a
 * small page.
 */
export const SETUP_OWNER_SCAN = { pageSize: 100, maxPages: 1000 };

/**
 * The addresses of the owners of an organization: the members whose role holds the owner rank
 * (`isOwner`, the rule of the manager guard), in the order of the member id. A user with no
 * address gives null, and `sendNotice` skips it. `complete` is false when the safety bound ended
 * the scan.
 */
async function ownerAddresses(
  config: ResolvedConfig,
  organizationId: string,
): Promise<{ addresses: (string | null)[]; complete: boolean }> {
  const o = config.organizations;
  if (!o) return { addresses: [], complete: true };
  const { pageSize, maxPages } = SETUP_OWNER_SCAN;
  const ids: string[] = [];
  let after: string | null = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const where: Where<"member">[] = [{ field: "organizationId", op: "eq", value: organizationId }];
    if (after !== null) where.push({ field: "id", op: "gt", value: after });
    const members: MemberRow[] = await config.storage.findMany("member", where, {
      sort: { field: "id", dir: "asc" },
      limit: pageSize,
    });
    for (const m of members) if (isOwner(o, rankOf(o.ranks, m.role))) ids.push(m.userId);
    if (members.length < pageSize) {
      complete = true;
      break;
    }
    after = members[members.length - 1]?.id ?? null;
  }
  const users = await findManyIn(config.storage, "user", "id", ids);
  const byId = new Map(users.map((u) => [u.id, u.email]));
  return { addresses: ids.map((id) => byId.get(id) ?? null), complete };
}

/**
 * The notices of a hand back. It never throws: a failure of the scan writes one line with the
 * event name and the error name (`notice.mail_failed`, no address), and the caller still runs the
 * hook. A hit of the safety bound writes the same line with `RangeError`.
 */
async function noticeOwners(config: ResolvedConfig, link: SsoSetupLinkRow): Promise<void> {
  try {
    const { addresses, complete } = await ownerAddresses(config, link.organizationId);
    if (!complete)
      config.observe.emit({
        name: "notice.mail_failed",
        event: "sso_setup_ready",
        errorName: new RangeError("owner scan bound"),
      });
    for (const email of addresses)
      await sendNotice(config, {
        event: "sso_setup_ready",
        email,
        ip: null,
        userAgent: null,
        setup: { linkId: link.id, note: link.note },
      });
  } catch (e) {
    config.observe.emit({ name: "notice.mail_failed", event: "sso_setup_ready", errorName: e });
  }
}

/**
 * The hand back of a setup link (spec 6.2 item 5): the IT admin says that the drafts wait. The
 * session must hold a live link, else `unauthorized`. One transaction takes the organization row
 * and the link row (`lockSetupRows`), then sets `readyAt` on the link where it is still null. The
 * link stays open: a DNS change can take days. After the commit, each owner of the organization
 * gets one `sso_setup_ready` notice (the link id and the note, no token and no hash), and
 * `hooks.sso.setupReady` runs. A failed owner scan, a failed notice, or a hook that throws writes
 * one log line and cannot undo the commit; the hook runs after the scan whatever it does. The
 * mails go one by one before the hook, and a hook has no time limit, so a slow port or hook
 * delays the answer, not the commit. The delivery is at most once: a crash between the commit and
 * the mail loses both, and a second hand back is a no-op. A second hand back changes nothing and
 * sends nothing. The contract has no audit action for it, so it writes no audit row: the link row
 * keeps `readyAt`.
 */
export async function handBack(config: ResolvedConfig, auth: SetupSession): Promise<Result<void>> {
  const setup = setupOn(config);
  if (!setup.ok) return setup;
  const { link } = auth;
  const now = config.clock.now();
  const first = await config.storage.transaction(async (tx): Promise<Result<boolean>> => {
    // The lock update holds the link live. The update below tests `readyAt`, so a second hand back writes nothing.
    const held = await lockSetupRows(tx, link.organizationId, { id: link.id, now });
    if (!held.ok) return held;
    const n = await tx.update(
      "ssoSetupLink",
      [
        { field: "id", op: "eq", value: link.id },
        { field: "organizationId", op: "eq", value: link.organizationId },
        { field: "readyAt", op: "eq", value: null },
      ],
      { readyAt: now, updatedAt: now },
    );
    return ok(n > 0);
  });
  if (!first.ok) return first;
  if (!first.value) return ok(undefined);
  await noticeOwners(config, link);
  await runAfter(
    config.observe,
    "sso.setupReady",
    config.hooks.sso.setupReady,
    { organizationId: link.organizationId, linkId: link.id },
    link.id,
  );
  return ok(undefined);
}

/**
 * The links of an organization, at most `SETUP_LINKS_LIST_MAX`, newest
 * first. The actor must still manage the organization.
 */
export async function listSetupLinks(
  config: ResolvedConfig,
  actor: SsoActor,
  organizationId: string,
): Promise<Result<SetupLinkSummary[]>> {
  const setup = setupOn(config);
  if (!setup.ok) return setup;
  const still = await recheckSsoManager(config, actor, organizationId);
  if (!still.ok) return still;
  const rows = await config.storage.findMany(
    "ssoSetupLink",
    [{ field: "organizationId", op: "eq", value: organizationId }],
    { sort: { field: "id", dir: "desc" }, limit: SETUP_LINKS_LIST_MAX },
  );
  return ok(rows.map(summary));
}

/**
 * One link by its id. The actor must still manage the organization of the
 * link. An unknown id answers `not_found`. The preview is `previewSetup`.
 */
export async function getSetupLink(
  config: ResolvedConfig,
  actor: SsoActor,
  id: string,
): Promise<Result<SetupLinkSummary>> {
  const setup = setupOn(config);
  if (!setup.ok) return setup;
  const link = await config.storage.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: id }]);
  if (!link) return fail("not_found");
  const still = await recheckSsoManager(config, actor, link.organizationId);
  if (!still.ok) return still;
  return ok(summary(link));
}
