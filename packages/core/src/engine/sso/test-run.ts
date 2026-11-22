import type { ResolvedConfig } from "../../config.js";
import { limit } from "../../limiter/limit.js";
import { newId } from "../../primitives/ids.js";
import { fail, ok, type Result } from "../../result.js";
import type { SsoConnectionRow, SsoTestRunRow } from "../../schema.js";
import { writeAuditIn } from "../operator/audit.js";
import { afterAudit } from "./domains.js";
import { type SsoActor, ssoDraft } from "./guard.js";
import { startSso } from "./oidc.js";
import { setupActorName } from "./setup-drafts.js";
import { setupRefused } from "./setup-events.js";
import { lockSetupRows } from "./setup-live.js";
import type { SetupSession } from "./setup-session.js";
import { stepHelp } from "./step-help.js";
import { resultHash } from "./test-run-store.js";

/**
 * The test run of a draft connection (plan 13a Task 7, spec 6.4). The start is the real start of
 * the connection with one step added: it checks who may test the row and writes one pending run
 * row. The state of the sign-in names the run. The callback runs the checks of the real flow in
 * the same functions, and it stops before `resolveSsoUser` (see `oidc.ts` and `saml-sp.ts`).
 */

/** The request facts of a test start. */
export interface TestStartInput {
  ip: string | null;
  userAgent: string | null;
  next?: string | undefined;
}

/**
 * Starts a test run. `who` is a setup session or an SSO actor that the route already
 * checked with the manager guard. A setup session may test the one draft of its own link only.
 * Each refusal is `unauthorized`, or `sso_not_configured` for SSO that is off. The route
 * answers both as the answer of no credential. The answer is the IdP redirect and the binding
 * value, as the real start.
 */
export async function startTestRun(
  config: ResolvedConfig,
  who: SetupSession | SsoActor,
  connectionId: string,
  input: TestStartInput,
): Promise<Result<{ location: string; bindToken: string }>> {
  return startSso(config, {
    connectionId,
    next: input.next,
    ip: input.ip,
    test: { prepare: (row) => prepare(config, who, row, input) },
  });
}

/**
 * The test starts of one connection: 20 an hour (review round 1, ruling R20d). Each start writes
 * a run row and an audit row, and runs have no age sweep, so core owns this cap. A person tests
 * a few times; the draft writes have 60 an hour for a link (ruling R3), and a test needs a few
 * of those writes first. The key is the connection, so it holds for a manager and for a link.
 * Only a caller that passed the checks of `prepare` counts, so a stranger burns none of it.
 */
export const SETUP_TEST_PER_CONNECTION = { seconds: 3600, max: 20 };

/** The step of a run that a newer run of the same connection ends: the first step of the flow. */
const SUPERSEDED_STEP = { oidc: "state", saml: "request" } as const;

/** Authorizes the caller for the row, then writes the pending run and its audit row in one transaction. */
async function prepare(
  config: ResolvedConfig,
  who: SetupSession | SsoActor,
  row: SsoConnectionRow,
  meta: TestStartInput,
): Promise<Result<{ runId: string }>> {
  let actor: SsoActor;
  let linkId: string | null = null;
  if ("link" in who) {
    if (!config.sso?.setup) return fail("sso_not_configured");
    // A setup session tests the draft of its own link, in its own organization, and nothing else.
    if (
      !who.link.steps.includes("connection") ||
      !row.draft ||
      row.setupLinkId !== who.link.id ||
      row.organizationId !== who.link.organizationId
    ) {
      setupRefused(config, "test_caller");
      return fail("unauthorized");
    }
    actor = { kind: "app", name: setupActorName(who.link.id) };
    linkId = who.link.id;
  } else actor = who;
  if (!(await limit(config, "setup-test:connection", row.id, SETUP_TEST_PER_CONNECTION))) {
    setupRefused(config, "test_limit");
    return fail("rate_limited");
  }
  const now = config.clock.now();
  const runId = newId(now);
  const audit = ssoDraft(actor, "sso_test_run", {
    targetUserId: null,
    data: {
      organizationId: row.organizationId,
      connectionId: row.id,
      runId,
      draftVersion: row.version,
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (!audit.ok) return audit;
  const written = await config.storage.transaction(async (tx) => {
    // The organization row, then the link row, then the run rows (ruling R22 of plan 13a). A
    // revoke or a delete in parallel then ends the write. A start of the manager holds no link,
    // so it takes no such lock.
    if (linkId !== null) {
      const locked = await lockSetupRows(tx, row.organizationId, { id: linkId, now });
      if (!locked.ok) return locked;
    }
    // One pending run per connection: a new start ends the older one.
    await tx.update(
      "ssoTestRun",
      [
        { field: "connectionId", op: "eq", value: row.id },
        { field: "outcome", op: "eq", value: "pending" },
      ],
      { outcome: "failed", step: SUPERSEDED_STEP[row.kind], updatedAt: now },
    );
    await tx.create("ssoTestRun", {
      id: runId,
      organizationId: row.organizationId,
      connectionId: row.id,
      linkId,
      outcome: "pending",
      step: null,
      attributeNames: [],
      domainClaimed: false,
      draftVersion: row.version,
      createdAt: now,
      updatedAt: now,
    });
    return ok(await writeAuditIn(tx, audit.value, now));
  });
  if (!written.ok) return written;
  await afterAudit(config, written.value);
  return ok({ runId });
}

/**
 * The newest passed run of a connection at exactly this draft version, or null. A later write
 * of the draft adds 1 to its version, so an older pass is stale and gives null (hand-off f).
 */
export async function lastPassedRun(
  config: ResolvedConfig,
  connectionId: string,
  version: number,
): Promise<SsoTestRunRow | null> {
  const [run] = await config.storage.findMany(
    "ssoTestRun",
    [
      { field: "connectionId", op: "eq", value: connectionId },
      { field: "outcome", op: "eq", value: "passed" },
      { field: "draftVersion", op: "eq", value: version },
    ],
    {
      sort: [
        { field: "createdAt", dir: "desc" },
        { field: "id", dir: "desc" },
      ],
      limit: 1,
    },
  );
  return run ?? null;
}

/** What the result page of a run shows. */
export interface TestRunResult {
  run: SsoTestRunRow;
  /** The address of the profile, or null when the result row is gone (15 minutes) or the run did not pass. */
  address: string | null;
  name: string | null;
  /** The help line of the failed step, or an empty text. */
  help: string;
}

/**
 * The result of one run for the setup session that ran it. A run of another link, of another
 * organization, or with no row answers `not_found`, so a run id tells nothing to another session.
 * The address and the name come from the short result row, never from the run row.
 */
export async function testRunResult(
  config: ResolvedConfig,
  auth: SetupSession,
  runId: string,
): Promise<Result<TestRunResult>> {
  const run = await config.storage.findOne("ssoTestRun", [
    { field: "id", op: "eq", value: runId },
    { field: "linkId", op: "eq", value: auth.link.id },
    { field: "organizationId", op: "eq", value: auth.link.organizationId },
  ]);
  if (!run) return fail("not_found");
  let address: string | null = null;
  let name: string | null = null;
  if (run.outcome === "passed") {
    const held = await config.storage.findOne("verification", [
      { field: "purpose", op: "eq", value: "sso-test-result" },
      { field: "valueHash", op: "eq", value: await resultHash(run.id) },
      { field: "expiresAt", op: "gt", value: config.clock.now() },
    ]);
    const data = held?.data as { address?: unknown; name?: unknown } | null | undefined;
    if (typeof data?.address === "string") address = data.address;
    if (typeof data?.name === "string") name = data.name;
  }
  const help = run.outcome === "failed" && run.step !== null ? stepHelp(run.step) : "";
  return ok({ run, address, name, help });
}
