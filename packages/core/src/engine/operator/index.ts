import type { ResolvedConfig } from "../../config.js";
import type { Result } from "../../result.js";
import type { OperatorAuditRow, SessionRow } from "../../schema.js";
import { enforceOff, type SsoDomainSummary } from "../sso/domains.js";
import {
  deleteUser,
  type OperatorDeleteUser,
  type OperatorUpdateUser,
  updateUser,
} from "./accounts.js";
import { listAudit } from "./audit.js";
import { type BanInput, banUser, type UnbanInput, unbanUser } from "./ban.js";
import { checkActor, type OperatorActor } from "./guards.js";
import {
  type ImpersonationStart,
  type ImpersonationStop,
  startImpersonation,
  stopImpersonation,
} from "./impersonation.js";
import {
  type CreateAdminInput,
  createAdmin,
  grantPlatformRole,
  type PlatformRoleInput,
  revokePlatformRole,
} from "./platform-role.js";
import { disableFactorWithProof, type FactorDisableInput } from "./second-factor.js";
import {
  type EndAllSessionsInput,
  type EndUserSessionsAnswer,
  type EndUserSessionsInput,
  endAllSessions,
  endUserSessions,
} from "./sessions.js";
import { getUser, listUsers, type OperatorUser, searchUsers } from "./users.js";

/**
 * `auth.api.operator` (plan 12f): the operator tools in process. Present in
 * every deployment; each call answers `not_found` while its tool is off.
 * The caller passes the actor: the app as `{ kind: "app", name }`, a secret
 * entry, or a platform operator from `requireOperatorUser`. Tasks 5 to 11
 * add their entries here only, each through `entry` when it takes an actor.
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
    /**
     * Bans a user and ends all access but the API tokens (plan 12f Task 6).
     * The sessions past the call budget go at the next sweeps (ruling 44).
     * Needs the scope `users`.
     */
    ban(input: BanInput): Promise<Result<{ auditId: string; familyEndFailed?: true }>>;
    /** Lifts a ban. It restores no session. Needs the scope `users`. */
    unban(input: UnbanInput): Promise<Result<{ auditId: string }>>;
    /**
     * Corrects the name or the image of a user (plan 12f2 Task 4). No
     * other field changes. Needs the scope `users`.
     */
    update(input: OperatorUpdateUser): Promise<Result<{ user: OperatorUser; auditId: string }>>;
    /**
     * Deletes an account and its solo organizations (plan 12f2 Task 4). The
     * sessions past the call budget go at the next sweeps. Needs the scope
     * `delete`.
     */
    delete(
      input: OperatorDeleteUser,
    ): Promise<Result<{ organizations: string[]; auditId: string }>>;
  };
  platformRole: {
    /** Grants the platform role to a verified user with no active ban (plan 12f Task 8). Needs the scope `users`. */
    grant(input: PlatformRoleInput): Promise<Result<{ auditId: string }>>;
    /**
     * Revokes the platform role and ends all access of the user but the API
     * tokens. The sessions past the call budget go at the next sweeps, or at
     * a retry (rulings 44 and 45). Needs the scope `users`.
     */
    revoke(input: PlatformRoleInput): Promise<Result<{ auditId: string; familyEndFailed?: true }>>;
  };
  secondFactor: {
    /**
     * Turns the second factor off after identity proofing, with the proof in
     * the audit row (plan 12f Task 9, ASVS 5.0.0 6.4.4). Needs the scope `users`.
     */
    disable(input: FactorDisableInput): Promise<Result<{ auditId: string }>>;
  };
  /**
   * Creates the first operator: the platform organization when absent, the
   * user when absent (not verified, no password), and the member row. A
   * secret or the app only. Needs the scope `users`.
   */
  createAdmin(
    input: CreateAdminInput,
  ): Promise<Result<{ userId: string; created: boolean; auditId: string }>>;
  sessions: {
    /**
     * Ends all access of one user but the API tokens (plan 12f Task 7), one
     * page per call; call again while `more` is true. Needs the scope `sessions`.
     */
    endUser(input: EndUserSessionsInput): Promise<Result<EndUserSessionsAnswer>>;
    /**
     * Ends up to `limit` sessions of all users, never the session of a user
     * actor; call again while `more` is true. Needs the scope `sessions`.
     */
    endAll(
      input: EndAllSessionsInput,
    ): Promise<Result<{ ended: number; more: boolean; auditId: string }>>;
  };
  /**
   * Starts an impersonation of a user by a platform operator (plan 12f
   * Task 11). It takes the operator's own session, not an actor: a secret
   * and the app never start one (spec 26 item 1). Needs
   * `operator.impersonation`. The answer holds the new session's token; the
   * route moves the operator's token into the actor cookie.
   */
  impersonate(
    input: ImpersonationStart,
  ): Promise<Result<{ token: string; session: SessionRow; auditId: string }>>;
  /** Ends an impersonation session. A session with no `actorId` answers `not_found`. */
  stopImpersonating(input: ImpersonationStop): Promise<Result<{ auditId: string }>>;
  sso: {
    /**
     * Turns `enforce` off on one domain (plan 12d deviation 5), with the
     * operator's reason in the audit row `sso_enforce_off`. Needs `sso`
     * (else `not_found`) and the scope `sso` of a secret actor.
     */
    enforceOff(input: {
      actor: OperatorActor;
      domainId: string;
      reason: string;
      ip: string | null;
      userAgent: string | null;
    }): Promise<Result<SsoDomainSummary & { auditId: string }>>;
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
    users: {
      list: entry((i) => listUsers(config, i)),
      search: entry((i) => searchUsers(config, i)),
      get: entry((i) => getUser(config, i)),
      ban: entry((i) => banUser(config, i)),
      unban: entry((i) => unbanUser(config, i)),
      update: entry((i) => updateUser(config, i)),
      delete: entry((i) => deleteUser(config, i)),
    },
    platformRole: {
      grant: entry((i) => grantPlatformRole(config, i)),
      revoke: entry((i) => revokePlatformRole(config, i)),
    },
    secondFactor: {
      disable: entry((i) => disableFactorWithProof(config, i)),
    },
    createAdmin: entry((i) => createAdmin(config, i)),
    sessions: {
      endUser: entry((i) => endUserSessions(config, i)),
      endAll: entry((i) => endAllSessions(config, i)),
    },
    // No entry(): these take a session, not an actor, and the guard of the
    // start reads the session (requireOperatorUser).
    impersonate: (i) => startImpersonation(config, i),
    stopImpersonating: (i) => stopImpersonation(config, i),
    sso: {
      enforceOff: entry(({ actor, ...i }) => enforceOff(config, actor, i)),
    },
  };
}
