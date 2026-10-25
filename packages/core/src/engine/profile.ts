import type { ResolvedConfig } from "../config.js";
import { limit } from "../limiter/limit.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import type { Where } from "../storage/port.js";
import { handleProved } from "./address.js";
import { hookGuard, runAfter, runBefore, type UserPatch } from "./hooks.js";
import { later, ROUNDS } from "./second-factor.js";
import { type PublicUser, publicUser, type ResolvedSession } from "./sessions.js";
import { validImageUrl, validUserName } from "./users.js";

// Per 15 minutes, per user (plan 12a). A settings page saves a few times;
// 30 bounds a script that loops on a stolen session.
export const UPDATE_PER_USER = { seconds: 900, max: 30 };

/** The profile fields core owns: `name` and `image`. The address has its own flow; any other field is the app's (review b27). */
export interface ProfileUpdate {
  session: ResolvedSession;
  name?: string | null | undefined;
  image?: string | null | undefined;
}

/**
 * The row as `previous` holds it, so `previous` is the row that the update
 * replaced. The social fill writes `name` or `image` with `updatedAt: now`,
 * which equals the old value in the same millisecond, so those fields are
 * matched too. The address and its flag are matched as well (plan 12a Task
 * 8): `later` of a stale read can repeat the `updatedAt` of a newer write.
 * The profile update and the change of address both write through this one
 * compare-and-set, so each sees every write of the other.
 */
export function unchanged(previous: UserRow): Where<"user">[] {
  return [
    { field: "id", op: "eq", value: previous.id },
    { field: "email", op: "eq", value: previous.email },
    { field: "emailVerified", op: "eq", value: previous.emailVerified },
    { field: "name", op: "eq", value: previous.name },
    { field: "image", op: "eq", value: previous.image },
    { field: "updatedAt", op: "eq", value: previous.updatedAt },
  ];
}

/**
 * Writes the given profile fields of the caller (plan 12a, spec 8.15). No
 * fresh rule: the name and the image do not affect authentication. A
 * verified email is needed, or for a user with no address a verified
 * handle (ruling 15 of plan 12i). A claim keeps the user row and its name (spec 8.2
 * item 5), so a claimant must not set what the owner inherits.
 *
 * The write is a compare-and-set on the row that the round read. D1 has no
 * isolation, so a parallel write can land between the read and the write.
 * A lost round reads the row again and runs `user.beforeUpdate` again with
 * it. After `ROUNDS` lost rounds the answer is `conflict`.
 */
export async function updateProfile(
  config: ResolvedConfig,
  input: ProfileUpdate,
): Promise<Result<{ user: PublicUser }>> {
  const { user } = input.session;
  // A user with no address needs a verified handle (ruling 15 of plan 12i).
  if (!(await handleProved(config, config.storage, user))) return fail("email_unverified");
  const patch: Pick<UserPatch, "name" | "image"> = {};
  if (input.name !== undefined) {
    if (input.name !== null && !validUserName(input.name)) return fail("invalid_body");
    patch.name = input.name;
  }
  if (input.image !== undefined) {
    if (input.image !== null && !validImageUrl(input.image)) return fail("invalid_body");
    patch.image = input.image;
  }
  if (Object.keys(patch).length === 0) return fail("invalid_body");
  if (!(await limit(config, "user-update:user", user.id, UPDATE_PER_USER)))
    return fail("rate_limited");
  const now = config.clock.now();
  const hooks = config.hooks.user;
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: user.id }];
  const written = await hookGuard(() =>
    config.storage.transaction(
      async (tx): Promise<Result<{ previous: UserRow; user: UserRow }>> => {
        let previous = await tx.findOne("user", byId);
        for (let round = 0; round < ROUNDS; round++) {
          if (!previous) return fail("unauthorized");
          // The hook runs before the write, so a stop leaves the row as it
          // was on every adapter, D1 too.
          await runBefore(config.observe, "user.beforeUpdate", hooks.beforeUpdate, {
            user: previous,
            patch,
            via: "profile",
          });
          // Only the given fields, so a parallel write of the other field
          // stays (the rule of `writeFill` in social.ts). `updatedAt` moves
          // past the read, so a later compare-and-set sees this write.
          const updatedAt = later(now, previous.updatedAt);
          const n = await tx.update("user", unchanged(previous), { ...patch, updatedAt });
          if (n === 1) return ok({ previous, user: { ...previous, ...patch, updatedAt } });
          previous = await tx.findOne("user", byId);
        }
        config.observe.emit({ name: "profile.update_gave_up", userId: user.id });
        return fail("conflict");
      },
    ),
  );
  if (!written.ok) return written;
  await runAfter(
    config.observe,
    "user.afterUpdate",
    hooks.afterUpdate,
    { user: written.value.user, previous: written.value.previous, via: "profile" },
    user.id,
  );
  return ok({ user: publicUser(written.value.user) });
}
