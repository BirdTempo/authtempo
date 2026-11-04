import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import { StorageError, type Where } from "../storage/port.js";
import { handleProved } from "./address.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, runAfter, runBefore } from "./hooks.js";
import { sendNotice } from "./notices.js";
import { unchanged } from "./profile.js";
import { later, ROUNDS } from "./second-factor.js";
import type { ResolvedSession } from "./sessions.js";

/**
 * The username (plan 12i Task 2, spec 32 item 7). The stored form is NFKC
 * in lower case. It holds no `@` and no `+`, so the one sign-in route never
 * reads a username as an address or a phone. The typed case stays in
 * `displayUsername`. A username is public by design.
 */

/** The stored form of a username. */
export const USERNAME_RE = /^[a-z0-9_.]+$/;

/** The bounds of `username.minLength` and `username.maxLength`. */
export const USERNAME_LENGTH = { min: 3, max: 30 } as const;

// Per hour, per user. A person sets a name a few times; 5 bounds a script
// that cycles names on a stolen fresh session.
export const SET_PER_USER = { seconds: 3600, max: 5 };

// Per 15 minutes, per IP. A sign-up form asks once per typed name; 30 keeps
// a scan of the name space slow.
export const AVAILABLE_PER_IP = { seconds: 900, max: 30 };

/** A username in its two forms. */
export interface Username {
  username: string;
  displayUsername: string;
}

/**
 * The two forms of a typed name, or null when the name breaks a rule: the
 * characters, the length bounds, or the reserved set. The reserved check
 * reads the stored form, so `Admin` is reserved too.
 */
export function normalizeUsername(config: ResolvedConfig, raw: string): Username | null {
  const rules = config.username;
  if (!rules) return null;
  const displayUsername = raw.normalize("NFKC");
  if (displayUsername.length < rules.minLength || displayUsername.length > rules.maxLength)
    return null;
  const username = displayUsername.toLowerCase();
  if (!USERNAME_RE.test(username)) return null;
  if (rules.reserved.has(username)) return null;
  return { username, displayUsername };
}

/** The where of one stored username. */
export function byUsername(username: string): Where<"user">[] {
  return [{ field: "username", op: "eq", value: username }];
}

export interface UsernameSet {
  session: ResolvedSession;
  username: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Sets the username of the caller (spec 32 item 7). It needs a proved
 * handle and a fresh session, because the username is a way in (Task 3).
 * The write is a compare-and-set on the row that the round read, as the
 * profile update does. The unique key of `username` decides a race: the
 * loser answers `username_taken`. The old name is free at once. The notice
 * goes after the commit, to the address when the user has one.
 */
export async function setUsername(
  config: ResolvedConfig,
  input: UsernameSet,
): Promise<Result<Username>> {
  if (!config.username) return fail("not_found");
  const { user, session } = input.session;
  // A claimant must not set what the owner inherits (the rule of the profile update).
  // The session's flag holds too (plan 12p).
  if (!(await handleProved(config, config.storage, input.session))) return fail("email_unverified");
  const fresh = requireFresh(config, session);
  if (!fresh.ok) return fresh;
  const name = normalizeUsername(config, input.username);
  if (!name) return fail("username_invalid");
  if (!(await limit(config, "username:user", user.id, SET_PER_USER))) return fail("rate_limited");
  const now = config.clock.now();
  const hooks = config.hooks.user;
  const patch = { username: name.username, displayUsername: name.displayUsername };
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: user.id }];
  let written: Result<{ previous: UserRow; user: UserRow } | null>;
  try {
    written = await hookGuard(() =>
      config.storage.transaction(
        async (tx): Promise<Result<{ previous: UserRow; user: UserRow } | null>> => {
          let previous = await tx.findOne("user", byId);
          for (let round = 0; round < ROUNDS; round++) {
            if (!previous) return fail("unauthorized");
            // The same name in the same case: nothing to write and no notice.
            if (
              previous.username === patch.username &&
              previous.displayUsername === patch.displayUsername
            )
              return ok(null);
            await runBefore(config.observe, "user.beforeUpdate", hooks.beforeUpdate, {
              user: previous,
              patch,
              via: "username",
            });
            // `updatedAt` moves past the read, so a later compare-and-set sees this write.
            const updatedAt = later(now, previous.updatedAt);
            const n = await tx.update("user", unchanged(previous), { ...patch, updatedAt });
            if (n === 1) return ok({ previous, user: { ...previous, ...patch, updatedAt } });
            previous = await tx.findOne("user", byId);
          }
          config.observe.emit({ name: "username.set_gave_up", userId: user.id });
          return fail("conflict");
        },
      ),
    );
  } catch (err) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (err instanceof StorageError && err.code === "unique_violation" && err.model === "user")
      return fail("username_taken");
    throw err;
  }
  if (!written.ok) return written;
  if (written.value === null) return ok(name);
  await runAfter(
    config.observe,
    "user.afterUpdate",
    hooks.afterUpdate,
    { user: written.value.user, previous: written.value.previous, via: "username" },
    user.id,
  );
  await sendNotice(config, {
    event: "username_changed",
    email: user.email,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok(name);
}

/**
 * Answers whether a name is free (spec 32 item 7). A username is public by
 * design, so the answer tells what a sign-up would tell. The limit comes
 * first, so a call with a bad name counts too.
 */
export async function usernameAvailable(
  config: ResolvedConfig,
  input: { username: string; ip: string | null },
): Promise<Result<{ available: boolean }>> {
  if (!config.username) return fail("not_found");
  if (!(await limit(config, "username-available:ip", ipKey(input.ip), AVAILABLE_PER_IP)))
    return fail("rate_limited");
  const name = normalizeUsername(config, input.username);
  if (!name) return fail("username_invalid");
  const holder = await config.storage.findOne("user", byUsername(name.username));
  return ok({ available: holder === null });
}
