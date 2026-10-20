import type { ResolvedConfig } from "../../config.js";
import type { Result } from "../../result.js";
import type { OperatorAuditRow } from "../../schema.js";
import { listAudit } from "./audit.js";
import { type BanInput, banUser, type UnbanInput, unbanUser } from "./ban.js";
import { checkActor, type OperatorActor } from "./guards.js";
import {
  type CreateAdminInput,
  createAdmin,
  grantPlatformRole,
  type PlatformRoleInput,
  revokePlatformRole,
} from "./platform-role.js";
import { getUser, listUsers, type OperatorUser, searchUsers } from "./users.js";

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
  users: {
    /** The users by `id` ascending, 1 to 100 per page. Needs the scope `users`. */
    list(input: {
      actor: OperatorActor;
      after?: string;
      limit?: number;
    }): Promise<Result<{ users: OperatorUser[]; next: string | null }>>;
    /** A search by one of `email`, `emailPrefix`, and `id`. Needs the scope `users`. */
    search(input: {
      actor: OperatorActor;
      email?: string;
      emailPrefix?: string;
      id?: string;
      after?: string;
      limit?: number;
    }): Promise<Result<{ users: OperatorUser[]; next: string | null }>>;
    /** One user by id. Needs the scope `users`. */
    get(input: { actor: OperatorActor; userId: string }): Promise<Result<OperatorUser>>;
    /** Bans a user and ends all access but the API tokens (plan 12f Task 6). Needs the scope `users`. */
    ban(input: BanInput): Promise<Result<{ auditId: string }>>;
    /** Lifts a ban. It restores no session. Needs the scope `users`. */
    unban(input: UnbanInput): Promise<Result<{ auditId: string }>>;
  };
  platformRole: {
    /** Grants the platform role to a verified user with no active ban (plan 12f Task 8). Needs the scope `users`. */
    grant(input: PlatformRoleInput): Promise<Result<{ auditId: string }>>;
    /** Revokes the platform role and ends all access of the user but the API tokens. Needs the scope `users`. */
    revoke(input: PlatformRoleInput): Promise<Result<{ auditId: string }>>;
  };
  /**
   * Creates the first operator: the platform organization when absent, the
   * user when absent (not verified, no password), and the member row. A
   * secret or the app only. Needs the scope `users`.
   */
  createAdmin(
    input: CreateAdminInput,
  ): Promise<Result<{ userId: string; created: boolean; auditId: string }>>;
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
    users: {
      list: entry((i) => listUsers(config, i)),
      search: entry((i) => searchUsers(config, i)),
      get: entry((i) => getUser(config, i)),
      ban: entry((i) => banUser(config, i)),
      unban: entry((i) => unbanUser(config, i)),
    },
    platformRole: {
      grant: entry((i) => grantPlatformRole(config, i)),
      revoke: entry((i) => revokePlatformRole(config, i)),
    },
    createAdmin: entry((i) => createAdmin(config, i)),
  };
}
