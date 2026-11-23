import type { ResolvedConfig } from "../../config.js";
import type { SetupRefusalStep } from "./steps.js";

/**
 * The events of the setup flow (plan 13a Task 12). Each call passes row ids and closed names only:
 * never a token, a cookie, an address, an IP, or a text of an IdP. The event table holds the field
 * kinds, so a field of another kind is dropped there as well.
 */

/** One `sso.setup_refused` for a refusal. The answer of the refusal is the answer of no credential. */
export function setupRefused(config: ResolvedConfig, step: SetupRefusalStep): void {
  config.observe.emit({ name: "sso.setup_refused", step });
}

/** One `sso.setup_opened` after the commit of an open. */
export function setupOpened(config: ResolvedConfig, linkId: string, organizationId: string): void {
  config.observe.emit({ name: "sso.setup_opened", linkId, organizationId });
}

/**
 * One `sso.test_run` after a run ends. A run of a manager has no link. A passed run has no step.
 * The step is one of the closed steps of the real flow.
 */
export function testRunEnded(
  config: ResolvedConfig,
  run: { connectionId: string; linkId: string | null },
  outcome: "passed" | "failed",
  step?: string,
): void {
  config.observe.emit({
    name: "sso.test_run",
    connectionId: run.connectionId,
    outcome,
    ...(run.linkId === null ? {} : { linkId: run.linkId }),
    ...(step === undefined ? {} : { step }),
  });
}
