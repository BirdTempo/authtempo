import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { OrganizationRow, UserRow } from "../schema.js";
import type { Where } from "../storage/port.js";
import { USER_CHILD_MODELS } from "../storage/sql.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import { sendNotice } from "./notices.js";
import {
  deleteOrganizationRows,
  organizationsOfDelete,
  ownersOf,
  publicOrganization,
} from "./organizations.js";
import { unchanged } from "./profile.js";
import { later, ROUNDS } from "./second-factor.js";
import {
  endedList,
  endSessions,
  type ResolvedSession,
  sessionIsLive,
  sessionsEnded,
} from "./sessions.js";

// Per hour, per user (plan 12a). A delete succeeds once. 5 lets a person
// retry after a `conflict` or after a fix of `sole_owner`, and bounds a loop.
export const DELETE_PER_USER = { seconds: 3600, max: 5 };

export interface AccountDelete {
  session: ResolvedSession;
  ip: string | null;
  userAgent: string | null;
}

interface Deleted {
  user: UserRow;
  going: OrganizationRow[];
}

/**
 * Deletes the account (plan 12a, spec 8.15). The fresh rule applies, and no
 * mail confirms the delete: the fresh session is the proof.
 *
 * One transaction. First the lock of the user row through `unchanged()`
 * (profile.ts), in a loop of `ROUNDS`. A parallel change of address, a
 * profile update, or a removal of a way in then commits first or waits.
 * A sign-in of a verified user holds the same row (`prepareSession`). So its
 * session commits before the delete reads the sessions, or it sees the user
 * gone. Then the session of the proof is read again, the organization rule
 * runs, and the before hooks run. The owner lock of each organization that
 * keeps another owner comes next.
 *
 * The deletes come in this order. First the user row, the solo
 * organizations, the member rows of the user, and the invitations the user
 * sent. Then the sessions, and every other row of `USER_CHILD_MODELS`. The
 * user row goes before the sessions: D1 has no lock, and a sign-in reads the
 * user row after its session insert. The sessions go before the
 * identities: a link in flight updates its session as its last statement,
 * so it undoes or commits first.
 *
 * After the commit: the verification rows of the user id and the address.
 * A reset holds its link row before the user row, so a delete inside the
 * transaction could deadlock with it on Postgres. Invitations to the
 * address stay: they belong to the organizations.
 */
export async function deleteAccount(
  config: ResolvedConfig,
  input: AccountDelete,
): Promise<Result<{ ok: true }>> {
  if (!config.account.delete) return fail("not_found");
  const fresh = requireFresh(config, input.session.session);
  if (!fresh.ok) return fresh;
  const userId = input.session.user.id;
  if (!(await config.limiter.allow(`user-delete:user:${userId}`, DELETE_PER_USER)))
    return fail("rate_limited");
  const now = config.clock.now();
  const ended = endedList(config);
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  const proof: Where<"session">[] = [{ field: "id", op: "eq", value: input.session.session.id }];
  const done = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<Deleted>> => {
      if (ended) ended.length = 0;
      let seen = await tx.findOne("user", byId);
      let user: UserRow | null = null;
      for (let round = 0; round < ROUNDS && !user; round++) {
        if (!seen) return fail("not_found");
        const updatedAt = later(now, seen.updatedAt);
        if ((await tx.update("user", unchanged(seen), { updatedAt })) === 1)
          user = { ...seen, updatedAt };
        // A parallel write landed first. No write of this call has run.
        else seen = await tx.findOne("user", byId);
      }
      if (!user) {
        console.error("authtempo: account delete gave up", userId);
        return fail("conflict");
      }
      // The proof must still be live: a session that ended proves nothing.
      // The lock wrote, so each refusal from here throws to undo it.
      const session = await tx.findOne("session", proof);
      if (!session || !sessionIsLive(config, session, now)) stopWith("unauthorized");
      const plan = await organizationsOfDelete(config, tx, user.id);
      if (!plan.ok) stopWith(plan.code);
      const { going, owned } = plan.value;
      for (const organization of going)
        await runBefore("organization.beforeDelete", config.hooks.organization.beforeDelete, {
          organization: publicOrganization(organization),
          user,
        });
      await runBefore("user.beforeDelete", config.hooks.user.beforeDelete, {
        user,
        organizations: going.map((x) => x.id),
      });
      // The lock of `ownerWrite`: a parallel owner removal holds it first,
      // or waits and then matches no row.
      for (const organization of owned) {
        const held = await tx.update(
          "organization",
          [
            { field: "id", op: "eq", value: organization.id },
            { field: "updatedAt", op: "eq", value: organization.updatedAt },
          ],
          { updatedAt: later(now, organization.updatedAt) },
        );
        if (held === 0) stopWith("conflict");
      }
      await tx.delete("user", byId);
      for (const organization of going) await deleteOrganizationRows(tx, organization.id, user.id);
      await tx.delete("member", [{ field: "userId", op: "eq", value: user.id }]);
      // D1 has no lock: the recount catches an owner removal that passed the lock.
      for (const organization of owned)
        if ((await ownersOf(config, tx, organization.id)) < 1) stopWith("conflict");
      await tx.delete("invitation", [{ field: "inviterId", op: "eq", value: user.id }]);
      await endSessions(tx, [{ field: "userId", op: "eq", value: user.id }], ended ?? null);
      for (const model of USER_CHILD_MODELS) {
        if (model === "session" || model === "member") continue;
        // Each model of the list has a `userId` field: USER_CHILD_MODELS reads
        // the schema. The port's types cannot see that over a union of models.
        await tx.delete(model, [{ field: "userId", op: "eq", value: user.id }] as never);
      }
      return ok({ user, going });
    }),
  );
  if (!done.ok) return done;
  const { user, going } = done.value;
  await config.storage.delete("verification", [
    { field: "identifier", op: "in", value: [user.id, user.email] },
  ]);
  await sessionsEnded(config, ended, "account_deleted");
  for (const organization of going)
    await runAfter(
      "organization.afterDelete",
      config.hooks.organization.afterDelete,
      { organization: publicOrganization(organization), user },
      organization.id,
    );
  await runAfter("user.afterDelete", config.hooks.user.afterDelete, { user }, user.id);
  // To the address of the row that the delete held, after the commit (plan 12a Task 6).
  await sendNotice(config, {
    event: "account_deleted",
    email: user.email,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ ok: true });
}
