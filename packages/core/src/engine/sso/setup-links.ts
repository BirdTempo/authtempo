import type { ResolvedConfig } from "../../config.js";
import { ERRORS } from "../../errors.js";
import { SETUP_LINK_PREFIX } from "../../primitives/credentials.js";
import { randomToken, sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import { hasControlChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import {
  type OperatorAuditRow,
  SETUP_STEPS,
  SETUP_TTL_HOURS_MAX,
  type SetupStep,
  type SsoSetupLinkRow,
} from "../../schema.js";
import { writeAuditIn } from "../operator/audit.js";
import { tokenHint } from "../tokens.js";
import { afterAudit, type SsoActMeta } from "./domains.js";
import { recheckSsoManager, type SsoActor, ssoDraft } from "./guard.js";
import { lockSetupRows } from "./setup-live.js";

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
 * session of the link, and writes the `sso_setup_link_revoke` audit row.
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
    return writeAuditIn(tx, draft.value, now);
  });
  if (revoked) await afterAudit(config, revoked);
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
 * link. An unknown id answers `not_found`. Task 8 adds the preview.
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
