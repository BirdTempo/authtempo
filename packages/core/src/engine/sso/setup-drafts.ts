import { domainRecordFor, PROVIDER_ID_RE } from "../../compat-seams.js";
import type { ResolvedConfig } from "../../config.js";
import { limit } from "../../limiter/limit.js";
import { fail, ok, type Result } from "../../result.js";
import type { SetupStep } from "../../schema.js";
import { createScimToken } from "../scim/tokens.js";
import {
  type ConnectionFields,
  createConnection,
  publicConnection,
  type SsoConnectionSummary,
  updateConnection,
} from "./connections.js";
import { addDomain, type SsoActMeta, type SsoDomainSummary, verifyDomain } from "./domains.js";
import type { SsoActor } from "./guard.js";
import type { SetupSession } from "./setup-session.js";

/**
 * The writes of a setup session (plan 13a Task 4, spec 6.1 item 8). The IT
 * admin of a setup link adds and verifies a domain of the organization of the
 * link, writes the one draft connection of the link, and makes the one
 * pending SCIM token of the link. Each function wraps the call of the same
 * name of the manager path, so each validator runs once and has no copy
 * here. The wraps add three rules of their own: the link must hold the step,
 * the link may make 60 writes an hour, and the organization is always the
 * organization of the link, never a value of the caller.
 *
 * Each refusal of the step is `unauthorized`, the answer of a request with
 * no credential. So a link with no `connection` step reveals nothing about
 * the routes that it cannot use.
 */

/** The draft writes of one link: 60 an hour (ruling R3 of plan 13a). A caller that holds a link makes few writes. */
export const SETUP_DRAFT_PER_LINK = { seconds: 3600, max: 60 };

/** The name of the pending SCIM token. An owner sees it in the list of tokens. */
const SETUP_TOKEN_NAME = "Setup link directory";

/**
 * The keys that the owner sets, and the keys that name a row. A setup session sets none
 * of them (spec 6.1 item 8). The route body is strict, and this is the second guard.
 */
const OWNER_KEYS = [
  "id",
  "organizationId",
  "enabled",
  "jit",
  "defaultRole",
  "mfa",
  "scimRoles",
] as const;

/** The IdP values of a draft: the fields of a connection less the fields of the owner. */
export type SetupConnectionInput = Omit<ConnectionFields, (typeof OWNER_KEYS)[number]> & {
  kind: "oidc" | "saml";
  label: string;
};

/**
 * The actor of a write: the app form that names the link. The rule of an app name is
 * `[a-z0-9_.-]` (`checkActor`), so the name is `setup.` and the link id in lower case. A link
 * id is a ULID, and the Crockford alphabet ignores case, so the name names one link.
 */
export function setupActorName(linkId: string): string {
  return `setup.${linkId.toLowerCase()}`;
}

function actorOf(auth: SetupSession): SsoActor {
  return { kind: "app", name: setupActorName(auth.link.id) };
}

/**
 * The gate of each write: the link holds the step, else `unauthorized`. Then one count on
 * `setup-draft:link`, else `rate_limited`. A refused body counts too.
 */
async function gate(
  config: ResolvedConfig,
  auth: SetupSession,
  step: SetupStep,
): Promise<Result<true>> {
  if (!auth.link.steps.includes(step)) return fail("unauthorized");
  if (!(await limit(config, "setup-draft:link", auth.link.id, SETUP_DRAFT_PER_LINK)))
    return fail("rate_limited");
  return ok(true);
}

/**
 * Adds a domain to the organization of the link, with the link id on the row.
 * The row routes to no connection. The rules of `addDomain` hold. A domain that the
 * manager or another link added answers `conflict`, and its challenge does not change.
 * The link is held live in the transaction of the write (`lockSetupRows`).
 */
export async function addSetupDomain(
  config: ResolvedConfig,
  auth: SetupSession,
  domain: string,
  meta: SsoActMeta = {},
): Promise<Result<SsoDomainSummary>> {
  const gated = await gate(config, auth, "domain");
  if (!gated.ok) return gated;
  return addDomain(config, actorOf(auth), {
    organizationId: auth.link.organizationId,
    domain,
    setupLinkId: auth.link.id,
    ...meta,
  });
}

/**
 * Verifies a domain that this link added. A row of another organization, a row of the manager
 * or of another link, and an id with no row answer `unauthorized`: the answer
 * of no credential, so the id tells nothing. Such a row never reaches the DNS check. The rules of `verifyDomain` hold,
 * and the claim routes no connection.
 */
export async function verifySetupDomain(
  config: ResolvedConfig,
  auth: SetupSession,
  id: string,
  meta: SsoActMeta = {},
): Promise<Result<SsoDomainSummary>> {
  const gated = await gate(config, auth, "domain");
  if (!gated.ok) return gated;
  const row = await config.storage.findOne("ssoDomain", [
    { field: "id", op: "eq", value: id },
    { field: "organizationId", op: "eq", value: auth.link.organizationId },
    { field: "setupLinkId", op: "eq", value: auth.link.id },
  ]);
  if (!row) return fail("unauthorized");
  return verifyDomain(config, actorOf(auth), { id: row.id, setupLinkId: auth.link.id, ...meta });
}

/** The draft connection of the link, or null. A live connection is never a draft of a link. */
async function draftOf(config: ResolvedConfig, auth: SetupSession) {
  return config.storage.findOne("ssoConnection", [
    { field: "setupLinkId", op: "eq", value: auth.link.id },
    { field: "draft", op: "eq", value: true },
  ]);
}

/**
 * Creates the one draft connection of the link, or changes it. A new row has `draft` true,
 * `enabled` false, `version` 1, and the link id. A change adds 1 to `version` through
 * `updateConnection` (ruling R9): this module adds no second 1. The kind must be one of the
 * link, else `invalid_body`. A key of the owner is `invalid_body`. When a compat package is
 * on, a label of the providerId form is `invalid_body` too, as at the manager route: it
 * would take the provider of another organization (review M3 of Task 5). Every other rule
 * is the rule of the manager create and update, with the same refusal.
 */
export async function saveDraftConnection(
  config: ResolvedConfig,
  auth: SetupSession,
  input: SetupConnectionInput,
  meta: SsoActMeta = {},
): Promise<Result<SsoConnectionSummary>> {
  const gated = await gate(config, auth, "connection");
  if (!gated.ok) return gated;
  const bad = (message: string): Result<never> => ({
    ok: false,
    code: "invalid_body",
    status: 400,
    message,
  });
  if (!auth.link.kinds.includes(input.kind)) return bad("kind is not one of the setup link");
  for (const key of OWNER_KEYS)
    if ((input as Record<string, unknown>)[key] !== undefined)
      return bad(`${key} is not a field of a setup draft`);
  if (
    domainRecordFor(config) !== null &&
    typeof input.label === "string" &&
    PROVIDER_ID_RE.test(input.label)
  )
    return bad("label must not be of the providerId form in an app with a compat package");
  const held = await draftOf(config, auth);
  const actor = actorOf(auth);
  if (held) return updateConnection(config, actor, { ...input, id: held.id }, meta, auth.link.id);
  return createConnection(
    config,
    actor,
    { ...input, organizationId: auth.link.organizationId },
    meta,
    auth.link.id,
  );
}

/**
 * The draft connection of the link as an answer, or null. It reads the draft of the link
 * only: a live connection of the organization is never in the answer. It holds no secret.
 */
export async function readSetupDraft(
  config: ResolvedConfig,
  auth: SetupSession,
): Promise<Result<SsoConnectionSummary | null>> {
  const row = await draftOf(config, auth);
  return ok(row ? publicConnection(config, row) : null);
}

/**
 * Makes the pending SCIM token of the link, and removes the earlier one of the link. The
 * answer holds the clear token, once. The token opens no directory until the activation.
 */
export async function createPendingScimToken(
  config: ResolvedConfig,
  auth: SetupSession,
  meta: SsoActMeta = {},
): Promise<Result<{ token: string; id: string; hint: string }>> {
  const gated = await gate(config, auth, "directory");
  if (!gated.ok) return gated;
  return createScimToken(
    config,
    actorOf(auth),
    { organizationId: auth.link.organizationId, name: SETUP_TOKEN_NAME },
    meta,
    auth.link.id,
  );
}
