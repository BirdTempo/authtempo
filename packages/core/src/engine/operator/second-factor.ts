import type { ResolvedConfig } from "../../config.js";
import { PROOF_MAX_AGE_MS, PROOF_METHODS, REFERENCE_MAX } from "../../operator-secret.js";
import { hasRefusedChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import { sendNotice } from "../notices.js";
import { disableSecondFactorIn } from "../second-factor.js";
import { auditDraft, operatorAct } from "./audit.js";
import { isoDateTime, reasonOf, targetOf } from "./ban.js";
import type { OperatorActor } from "./guards.js";

// The proof rules live in the entry @authtempo/core/operator-secret, so the CLI reads the same rules (ruling 40).
export { PROOF_MAX_AGE_MS, PROOF_METHODS, REFERENCE_MAX } from "../../operator-secret.js";

export type ProofMethod = (typeof PROOF_METHODS)[number];

/** The proof of an identity check, as the operator gives it. */
export interface FactorProof {
  method: ProofMethod;
  /** The ticket or case id of the check, 1 to 200 characters with no character of `hasRefusedChar`. */
  reference: string;
  /** An ISO date and time with a zone, from 7 days before now to now. */
  checkedAt: string;
}

/** The input of the disable of the second factor with a proof. */
export interface FactorDisableInput {
  actor: OperatorActor;
  userId: string;
  reason: string;
  proof: FactorProof;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The proof as the audit row holds it, or `invalid_body`. The time is
 * written as `toISOString` writes it, so each row has one form.
 */
function proofOf(raw: unknown, now: Date): Result<FactorProof> {
  if (typeof raw !== "object" || raw === null) return fail("invalid_body");
  const { method, reference, checkedAt } = raw as Record<string, unknown>;
  if (!PROOF_METHODS.some((m) => m === method)) return fail("invalid_body");
  if (typeof reference !== "string" || reference.length === 0) return fail("invalid_body");
  if (reference.length > REFERENCE_MAX || hasRefusedChar(reference)) return fail("invalid_body");
  const at = isoDateTime(checkedAt);
  if (!at) return fail("invalid_body");
  if (at.getTime() > now.getTime()) return fail("invalid_body");
  if (now.getTime() - at.getTime() > PROOF_MAX_AGE_MS) return fail("invalid_body");
  return ok({ method: method as ProofMethod, reference, checkedAt: at.toISOString() });
}

/**
 * Turns the whole second factor of a user off after identity proofing (spec
 * 26 item 5, ASVS 5.0.0 6.4.4). The checks, in order: the user tools are on
 * (else `not_found`), a secret holds the scope `users`, the reason, the
 * proof, then the target (`targetOf`). A user actor does not act on their
 * own user or on a platform operator. One transaction runs the deletes of
 * `disableSecondFactorIn` and writes the audit row with the proof in
 * `data`. With the factor off it answers `totp_not_enabled`, and the undo
 * of the transaction leaves no change and no row.
 *
 * After the commit the user gets the notice `factor_disabled`, unless
 * `account.notices` is false. The notice has no IP and no user agent: those
 * are the operator's (plan 12f deviation 13). The act ends no session. Its storage calls are fixed: one read of the user
 * (three for a user actor), the hold of the user row (one read and one
 * update), four deletes, and the audit insert: 8, and 10 for a user actor.
 */
export async function disableFactorWithProof(
  config: ResolvedConfig,
  input: FactorDisableInput,
): Promise<Result<{ auditId: string }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  const proof = proofOf(input.proof, config.clock.now());
  if (!proof.ok) return proof;
  const target = await targetOf(config, input);
  if (!target.ok) return target;
  const drafted = auditDraft(input.actor, {
    action: "second_factor_disable",
    targetUserId: target.value.id,
    reason: reason.value,
    data: { ...proof.value },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx) => {
      if ((await disableSecondFactorIn(tx, target.value.id)) === 0) return fail("totp_not_enabled");
      return ok({});
    },
    {
      async committed() {
        await sendNotice(config, {
          event: "factor_disabled",
          email: target.value.email,
          ip: null,
          userAgent: null,
        });
      },
    },
  );
  if (!done.ok) return done;
  return ok({ auditId: done.value.auditId });
}
