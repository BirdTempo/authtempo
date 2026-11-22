import type { ResolvedConfig } from "../../config.js";
import type { ErrorCode } from "../../errors.js";
import { fail, ok, type Result } from "../../result.js";
import { certificateFingerprint } from "../../saml/der.js";
import type { OperatorAuditRow, ScimScope, SsoConnectionRow } from "../../schema.js";
import { findManyIn } from "../../storage/batch.js";
import type { StorageAdapter } from "../../storage/port.js";
import { sendNotice } from "../notices.js";
import { writeAuditIn } from "../operator/audit.js";
import { isOwner, rankOf } from "../ranks.js";
import {
  type OidcStored,
  publicConnection,
  type SamlStored,
  type SsoConnectionSummary,
} from "./connections.js";
import { afterAudit, type SsoActMeta } from "./domains.js";
import { recheckSsoManager, type SsoActor, ssoDraft } from "./guard.js";
import { lockSetupRows } from "./setup-live.js";
import { passedRunIn } from "./test-run.js";

/**
 * The preview and the activation of a setup link (plan 13a Task 8, spec 6.5). This is the one
 * place where a draft goes live. Two promises of the product rest on this file and on the
 * manager guard, and on no supplier:
 *
 * 1. A stolen link cannot go live. The caller is an `SsoActor` that the manager guard gave. A
 *    setup session is no `SsoActor`, and no setup route is the activation.
 * 2. A test pass binds to one draft version. The act reads the passed run for the exact
 *    version of the draft and writes the draft in one transaction, with the version in the
 *    `where` of the write.
 */

/** What an activation makes live (spec 6.5 item 2). It holds no secret and no token. */
export interface SetupPreview {
  kind: "oidc" | "saml";
  issuerOrEntityId: string;
  signInHost: string;
  /** SHA-256 hex of each certificate of a SAML draft. An OIDC draft has none. */
  fingerprints: string[];
  /** The verified domains of the link, which the activation routes to the connection. */
  domains: string[];
  scim: { name: string; scopes: ScimScope[] } | null;
}

/** The host of a URL text, or the text when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function draftOf(storage: StorageAdapter, linkId: string, organizationId: string) {
  return storage.findOne("ssoConnection", [
    { field: "setupLinkId", op: "eq", value: linkId },
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "draft", op: "eq", value: true },
  ]);
}

/** The domains that the link added and that a verified claim holds. */
async function verifiedDomainsOf(storage: StorageAdapter, linkId: string, organizationId: string) {
  return storage.findMany(
    "ssoDomain",
    [
      { field: "setupLinkId", op: "eq", value: linkId },
      { field: "organizationId", op: "eq", value: organizationId },
      { field: "claimedDomain", op: "ne", value: null },
    ],
    { sort: { field: "id", dir: "asc" } },
  );
}

async function pendingTokenOf(storage: StorageAdapter, linkId: string, organizationId: string) {
  return storage.findOne("scimToken", [
    { field: "setupLinkId", op: "eq", value: linkId },
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "pending", op: "eq", value: true },
  ]);
}

/**
 * What the activation of a link makes live, or null when the link has no draft yet. The actor
 * must manage the organization of the link, else `forbidden_rank`. An unknown id answers
 * `not_found`. It writes nothing. The answer holds no client secret and no token.
 */
export async function previewSetup(
  config: ResolvedConfig,
  actor: SsoActor,
  linkId: string,
): Promise<Result<SetupPreview | null>> {
  if (!config.sso?.setup) return fail("not_found");
  const link = await config.storage.findOne("ssoSetupLink", [
    { field: "id", op: "eq", value: linkId },
  ]);
  if (!link) return fail("not_found");
  const still = await recheckSsoManager(config, actor, link.organizationId);
  if (!still.ok) return still;
  const draft = await draftOf(config.storage, link.id, link.organizationId);
  if (!draft) return ok(null);
  const domains = await verifiedDomainsOf(config.storage, link.id, link.organizationId);
  const token = await pendingTokenOf(config.storage, link.id, link.organizationId);
  const scim = token ? { name: token.name, scopes: [...token.scopes] } : null;
  const names = domains.map((d) => d.domain);
  if (draft.kind === "oidc") {
    const c = draft.config as unknown as OidcStored;
    return ok({
      kind: "oidc",
      issuerOrEntityId: c.issuer,
      signInHost: hostOf(c.endpoints?.authorizeUrl ?? c.issuer),
      fingerprints: [],
      domains: names,
      scim,
    });
  }
  const c = draft.config as unknown as SamlStored;
  const fingerprints: string[] = [];
  for (const pem of c.certificates) {
    const print = await certificateFingerprint(pem);
    if (print !== null) fingerprints.push(print);
  }
  return ok({
    kind: "saml",
    issuerOrEntityId: c.idpEntityId,
    signInHost: hostOf(c.ssoUrl),
    fingerprints,
    domains: names,
    scim,
  });
}

/** A refusal inside the transaction. The throw undoes the writes of the lock rows. */
class Refused extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

/**
 * Turns on the draft of a setup link (spec 6.5 items 3 and 4).
 *
 * The checks before the transaction: `sso.setup` is on, else `not_found`; the link exists,
 * else `not_found`; the actor still manages the organization of the link (`forbidden_rank`
 * for an owner of another organization, as `revokeSetupLink` does); then `recheck`, the 12l
 * re-check that the route runs after its body read.
 *
 * One transaction does the rest, in the lock order of core (the organization row, then the
 * link row, `holdSetupRows`). The link must be live: not revoked, not ended, not expired, else
 * 404 `setup_link_invalid`, so a second activation and a race both end there. Then the link
 * must have a draft and a passed run for the exact `version` of the draft, else 409
 * `setup_not_tested`. Then it writes: the connection `enabled` true and `draft` false (the
 * `where` holds the version, so a write of the owner that lands after the read fails the act
 * with `setup_not_tested`), the verified domains of the link get the `connectionId`, the
 * pending token is no longer pending, the setup sessions and the link end, and two audit
 * rows are written (`sso_setup_link_activate` and `sso_connection_update`). It never sets
 * `enforce`. A refusal throws inside the transaction, so no write stays. Every `updatedAt`
 * of a changed row takes the time of the act.
 *
 * After the commit: the audit hook of each row, then the notice `sso_activated` to each owner
 * of the organization.
 */
export async function activateSetup(
  config: ResolvedConfig,
  actor: SsoActor,
  linkId: string,
  recheck: () => Promise<Result<void>>,
  meta: SsoActMeta = {},
): Promise<Result<SsoConnectionSummary>> {
  if (!config.sso?.setup) return fail("not_found");
  const link = await config.storage.findOne("ssoSetupLink", [
    { field: "id", op: "eq", value: linkId },
  ]);
  if (!link) return fail("not_found");
  const still = await recheckSsoManager(config, actor, link.organizationId);
  if (!still.ok) return still;
  const again = await recheck();
  if (!again.ok) return again;
  const now = config.clock.now();
  const act = await config.storage
    .transaction(async (tx) => {
      // The one lock order of core (R22): the organization row, then the link row.
      const held = await lockSetupRows(tx, link.organizationId, { id: link.id, now });
      if (!held.ok) throw new Refused("setup_link_invalid");
      const draft = await draftOf(tx, link.id, link.organizationId);
      if (!draft) throw new Refused("setup_not_tested");
      if (!(await passedRunIn(tx, draft.id, draft.version))) throw new Refused("setup_not_tested");
      const turned = await tx.update(
        "ssoConnection",
        [
          { field: "id", op: "eq", value: draft.id },
          { field: "draft", op: "eq", value: true },
          { field: "version", op: "eq", value: draft.version },
        ],
        { enabled: true, draft: false, updatedAt: now },
      );
      // The owner path takes no lock of the link: its write can land after our read.
      if (turned === 0) throw new Refused("setup_not_tested");
      const domains = await verifiedDomainsOf(tx, link.id, link.organizationId);
      // One set-based write. The claim must still hold at the write: a lost claim routes nothing.
      await tx.update(
        "ssoDomain",
        [
          { field: "setupLinkId", op: "eq", value: link.id },
          { field: "organizationId", op: "eq", value: link.organizationId },
          { field: "claimedDomain", op: "ne", value: null },
        ],
        { connectionId: draft.id, updatedAt: now },
      );
      const token = await pendingTokenOf(tx, link.id, link.organizationId);
      if (token)
        await tx.update(
          "scimToken",
          [
            { field: "id", op: "eq", value: token.id },
            { field: "pending", op: "eq", value: true },
          ],
          { pending: false, updatedAt: now },
        );
      await tx.update(
        "ssoSetupSession",
        [
          { field: "linkId", op: "eq", value: link.id },
          { field: "endedAt", op: "eq", value: null },
        ],
        { endedAt: now, updatedAt: now },
      );
      await tx.update("ssoSetupLink", [{ field: "id", op: "eq", value: link.id }], {
        endedAt: now,
        updatedAt: now,
      });
      const drafts = [
        ssoDraft(actor, "sso_setup_link_activate", {
          targetUserId: null,
          data: {
            organizationId: link.organizationId,
            linkId: link.id,
            connectionId: draft.id,
            domainIds: domains.map((d) => d.id),
            tokenId: token?.id ?? null,
          },
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        }),
        ssoDraft(actor, "sso_connection_update", {
          targetUserId: null,
          data: {
            organizationId: link.organizationId,
            connectionId: draft.id,
            kind: draft.kind,
            changed: ["draft", "enabled"],
          },
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        }),
      ];
      const rows: OperatorAuditRow[] = [];
      for (const d of drafts) {
        if (!d.ok) throw new Refused(d.code);
        rows.push(await writeAuditIn(tx, d.value, now));
      }
      const live: SsoConnectionRow = { ...draft, enabled: true, draft: false, updatedAt: now };
      return { rows, live };
    })
    .then(
      (done) => ok(done),
      (e: unknown): Result<never> => {
        if (e instanceof Refused) return fail(e.code);
        throw e;
      },
    );
  if (!act.ok) return act;
  for (const row of act.value.rows) await afterAudit(config, row);
  config.observe.emit({
    name: "sso.activated",
    organizationId: link.organizationId,
    connectionId: act.value.live.id,
    linkId: link.id,
  });
  await noticeOwners(config, link.organizationId, meta);
  return ok(publicConnection(config, act.value.live));
}

/**
 * The notice `sso_activated` to each owner of the organization, after the commit, so no owner
 * can turn on an IdP in silence (spec 6.5 item 5). A mail port that throws is caught in
 * `sendNotice`, and the act stays.
 */
async function noticeOwners(
  config: ResolvedConfig,
  organizationId: string,
  meta: SsoActMeta,
): Promise<void> {
  const o = config.organizations;
  if (!o) return;
  const members = await config.storage.findMany("member", [
    { field: "organizationId", op: "eq", value: organizationId },
  ]);
  const owners = members.filter((m) => isOwner(o, rankOf(o.ranks, m.role)));
  const users = await findManyIn(
    config.storage,
    "user",
    "id",
    owners.map((m) => m.userId),
  );
  for (const user of users)
    await sendNotice(config, {
      event: "sso_activated",
      email: user.email,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
}
