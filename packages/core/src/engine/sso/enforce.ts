import type { ResolvedConfig } from "../../config.js";
import { ERRORS } from "../../errors.js";
import type { Result } from "../../result.js";
import type { StorageAdapter } from "../../storage/port.js";
import { ssoStartUrl } from "./discover.js";
import { claimingDomain } from "./domains.js";

/**
 * The enforcement of a domain (plan 12d Task 5 Behavior 10, spec 30 item
 * 12). The start URL of SSO when a verified domain with `enforce` claims
 * the address, else null. The URL is absolute, on the origin of `baseURL`,
 * as the discovery answers it: an app on another origin sends the browser
 * there as it is. `email` is a normalized address. With `sso` off
 * the answer is null and nothing is read. Else it is one indexed read of
 * `claimingDomain`. An enforced domain always routes to an enabled
 * connection: `updateDomain` and `updateConnection` keep that rule
 * (rulings 31 Q6 and 34 m1). So the domain row alone gives the answer.
 * Inside a transaction the caller passes `tx` as `storage`.
 */
export async function ssoRequiredFor(
  config: ResolvedConfig,
  email: string,
  storage: StorageAdapter = config.storage,
): Promise<{ start: string } | null> {
  if (!config.sso) return null;
  const domain = await claimingDomain(storage, email);
  if (!domain?.enforce || domain.connectionId === null) return null;
  return { start: ssoStartUrl(config, domain.connectionId, undefined) };
}

/** A failure of `Result`: the form that a `HookStop` carries out of a transaction. */
export type SsoRequired = Extract<Result<never>, { ok: false }>;

/** The answer of a first factor of an enforced address: 403 `sso_required` with the start URL in `detail`. */
export function ssoRequired(start: string): SsoRequired {
  return { ok: false, code: "sso_required", status: ERRORS.sso_required, detail: start };
}

/**
 * The door check of a first factor: the `sso_required` answer for an
 * address of an enforced domain, else null. Each sign-in calls it after its
 * own input parse and before any credential check.
 */
export async function enforcedAnswer(
  config: ResolvedConfig,
  email: string,
  storage: StorageAdapter = config.storage,
): Promise<SsoRequired | null> {
  const required = await ssoRequiredFor(config, email, storage);
  return required ? ssoRequired(required.start) : null;
}
