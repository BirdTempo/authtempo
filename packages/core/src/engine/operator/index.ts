import type { ResolvedConfig } from "../../config.js";
import type { Result } from "../../result.js";
import type { OperatorAuditRow } from "../../schema.js";
import { listAudit } from "./audit.js";
import { checkActor, type OperatorActor } from "./guards.js";

/**
 * `auth.api.operator` (plan 12f): the operator tools in process. Present in
 * every deployment; each call answers `not_found` while its tool is off.
 * The caller passes the actor: the app as `{ kind: "app", name }`, a secret
 * entry, or a platform operator from `requireOperatorUser`. Tasks 5 to 11
 * add their entries here only, each through `entry`.
 */
export interface OperatorApi {
  audit: {
    /** The audit rows by `id` ascending, 1 to 100 per page. Needs the scope `audit`. */
    list(input: {
      actor: OperatorActor;
      targetUserId?: string;
      after?: string;
      limit?: number;
    }): Promise<Result<{ rows: OperatorAuditRow[]; next: string | null }>>;
  };
}

/**
 * One entry of the API. It checks the actor first (spec 26 item 1), also
 * while the tool is off, so every entry holds the app name rule.
 */
function entry<I extends { actor: OperatorActor }, R>(
  run: (input: I) => Promise<Result<R>>,
): (input: I) => Promise<Result<R>> {
  return async (input) => {
    const named = checkActor(input.actor);
    if (!named.ok) return named;
    return run(input);
  };
}

export function operatorApi(config: ResolvedConfig): OperatorApi {
  return {
    audit: {
      list: entry((i) => listAudit(config, i)),
    },
  };
}
