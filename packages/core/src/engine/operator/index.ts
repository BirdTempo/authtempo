import type { ResolvedConfig } from "../../config.js";
import type { Result } from "../../result.js";
import type { OperatorAuditRow } from "../../schema.js";
import { listAudit } from "./audit.js";
import type { OperatorActor } from "./guards.js";

/**
 * `auth.api.operator` (plan 12f): the operator tools in process. Present in
 * every deployment; each call answers `not_found` while its tool is off.
 * The caller passes the actor: the app (`appActor`), a secret entry, or a
 * platform operator from `requireOperatorUser`. Tasks 5 to 11 add their
 * entries here only.
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

export function operatorApi(config: ResolvedConfig): OperatorApi {
  return {
    audit: {
      list: (i) => listAudit(config, i),
    },
  };
}
