import type { ResolvedConfig } from "../config.js";
import type { Observer } from "../observe/observer.js";
import type { Clock } from "../primitives/clock.js";
import type { Result } from "../result.js";
import type { SessionRow, UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";
import {
  type IdentitySummary,
  type PatchShapeRefusal,
  patchFields,
  runAfter,
  runBefore,
  stopWith,
  type UserCreateVia,
  type UserPatchRefusal,
  type UserVerifyVia,
} from "./hooks.js";
import { type ImpersonationStops, impersonationStops } from "./operator/audit.js";
import { sessionsEnded } from "./sessions.js";
import { signUpRule, validImageUrl, validUserName } from "./users.js";

/**
 * The user and identity hooks of a flow that creates a user or links a
 * social identity at a sign-in (plan 12a, spec 8.9). The flow makes one
 * object before its retry loop. The transaction calls `begin` at each
 * attempt. It calls `user` on the row that it minted and `identity` on the
 * identity that it links. Both run before its first write and before the
 * session hook. The flow calls `after` after its commit, with the user it
 * answers. `afterCreate` fires only when that user is the row that this
 * attempt minted. `afterLink` fires only when this attempt linked for that
 * user. So a retry after a unique-key race that finds the winner's rows
 * fires neither.
 */
export interface CreateSteps {
  begin(): void;
  user(tx: StorageAdapter, user: UserRow): Promise<UserRow>;
  identity(user: UserRow, identity: IdentitySummary): Promise<void>;
  after(user: UserRow): Promise<void>;
}

/** One line that says what was wrong, never a value: a value can be an address. */
function refusePatch(observe: Observer, what: PatchShapeRefusal | UserPatchRefusal): never {
  observe.emit({ name: "user.patch_refused", what });
  return stopWith("hook_failed");
}

/**
 * The minted user after the answer of `user.beforeCreate`. Only `name` and
 * `image` change, under the profile rules. Any other key or value stops the
 * flow with `hook_failed`.
 */
export function patchedNewUser(observe: Observer, user: UserRow, patch: unknown): UserRow {
  const refuse = (what: PatchShapeRefusal | UserPatchRefusal) => refusePatch(observe, what);
  const fields = patchFields(patch, refuse);
  if (!fields) return user;
  for (const key of Object.keys(fields))
    if (key !== "name" && key !== "image") return refuse("a field other than name and image");
  const out: UserRow = { ...user };
  const { name, image } = fields;
  if (name !== undefined) {
    if (name !== null && (typeof name !== "string" || !validUserName(name)))
      return refuse("a name that breaks the name rule");
    out.name = name;
  }
  if (image !== undefined) {
    if (image !== null && (typeof image !== "string" || !validImageUrl(image)))
      return refuse("an image that breaks the image rule");
    out.image = image;
  }
  return out;
}

/**
 * The steps of one flow. `signUpRule` is true for the magic link, the email
 * code, and social. Then `user` runs the sign-up rule before the hook. So no
 * hook sees a create that the rule refuses. The password sign-up and the
 * reset run the rule in their own transaction, before they mint the row.
 */
export function createSteps(
  config: ResolvedConfig,
  via: UserCreateVia,
  // `stateData`: the app payload of a social sign-in, for `identity.afterLink` (plan 12i Task 19).
  options: { signUpRule: boolean; stateData?: Record<string, unknown> },
): CreateSteps {
  const hooks = config.hooks;
  let minted: string | null = null;
  let linked: { userId: string; identity: IdentitySummary } | null = null;
  return {
    begin() {
      minted = null;
      linked = null;
    },
    async user(tx, user) {
      if (options.signUpRule) await signUpRule(config, tx, user);
      const answer = await runBefore(config.observe, "user.beforeCreate", hooks.user.beforeCreate, {
        user,
        via,
      });
      const patched = patchedNewUser(config.observe, user, answer);
      minted = patched.id;
      return patched;
    },
    async identity(user, identity) {
      await runBefore(config.observe, "identity.beforeLink", hooks.identity.beforeLink, {
        user,
        identity,
        via: "sign_in",
      });
      linked = { userId: user.id, identity };
    },
    async after(user) {
      if (minted === user.id) {
        // The event of the act, beside its after hook (plan 12h Task 5).
        config.observe.emit({
          name: "sign_up",
          method: via,
          outcome: "success",
          userId: user.id,
          email: user.email,
        });
        await runAfter(
          config.observe,
          "user.afterCreate",
          hooks.user.afterCreate,
          { user, via },
          user.id,
        );
      }
      if (linked && linked.userId === user.id)
        await runAfter(
          config.observe,
          "identity.afterLink",
          hooks.identity.afterLink,
          {
            user,
            identity: linked.identity,
            via: "sign_in",
            ...(options.stateData ? { stateData: options.stateData } : {}),
          },
          user.id,
        );
    },
  };
}

/**
 * The verify hooks of a flow that can prove the address of an existing
 * unverified user (plan 12a, Task 18). The flow makes one object before its
 * retry loop. The transaction calls `begin` at each attempt. The flow calls
 * `before` with the stored, unverified row before its first write, and
 * before `identity.beforeLink` and the session hook. `claimEmail` calls
 * `claimed`. The flow calls `after` after its commit, with the user it
 * answers, before `identity.afterLink` and the session hook.
 */
export interface VerifySteps {
  begin(): void;
  before(user: UserRow): Promise<void>;
  /**
   * Called by `claimEmail`. Throws when `before` did not run for this user
   * in this attempt, so a test of each path finds a flow that skipped it.
   */
  claimed(userId: string): void;
  /** Fires `afterVerify` and the event `email.verify` once, when this attempt claimed `user`. */
  after(user: UserRow): Promise<void>;
  /** Called by `claimEmail` with the count of the sessions that the claim deleted. */
  sessionsEnded(n: number): void;
  /** The count of the sessions that this attempt's claim deleted (plan 12h Task 5). */
  endedCount(): number;
  /**
   * Called by the flow after the last write of its claim, inside the
   * transaction (plan 12o). When this attempt claimed, it calls `tx.keep()`.
   * A store that then keeps the claim on a later throw records `user`: the
   * row as the claim left it. A flow may call it more than once.
   */
  keep(tx: StorageAdapter, user: UserRow): Promise<void>;
  /**
   * The user of a claim that `keep` made final, or null. A throw after
   * `keep` leaves that claim, so the flow fires its after points on its
   * error answer too (`keptClaimEnded`), and runs no retry.
   */
  kept(): UserRow | null;
  /**
   * Called by a claim loop when it answers 409 `conflict` to a lost claim
   * (`claimRetry`): another proof claimed the user first (plan 12o). Since
   * plan 12p a claim loses at the hold, at the lease, or at the flip.
   */
  flipLost(): void;
  /** True when the flow answers `conflict` to a lost claim. `begin` keeps it. */
  lostFlip(): boolean;
  /**
   * The stop rows of the impersonation sessions that the claim ends (ruling
   * 43 of plan 12f), or null while the tool is off. `begin` empties it, so
   * a retry keeps no row of an attempt that rolled back.
   */
  readonly stops: ImpersonationStops | null;
  /**
   * The clock of the flow. `claimEmail` reads it at its lease, so the life of
   * a lease starts at its write (ruling 35 of plan 12p).
   */
  readonly clock: Clock;
}

export function verifySteps(
  config: Pick<ResolvedConfig, "hooks" | "observe" | "clock"> &
    Partial<Pick<ResolvedConfig, "operator">>,
  via: UserVerifyVia,
): VerifySteps {
  const hooks = config.hooks;
  let checked: string | null = null;
  let claimed: string | null = null;
  let ended = 0;
  let kept: UserRow | null = null;
  let lost = false;
  const stops = impersonationStops(config, "claim");
  return {
    stops,
    clock: config.clock,
    begin() {
      checked = null;
      claimed = null;
      ended = 0;
      if (stops) stops.rows.length = 0;
    },
    async before(user) {
      await runBefore(config.observe, "user.beforeVerify", hooks.user.beforeVerify, { user, via });
      checked = user.id;
    },
    claimed(userId) {
      if (checked !== userId)
        throw new Error("authtempo: user.beforeVerify did not run before the claim");
      claimed = userId;
    },
    async after(user) {
      if (claimed !== user.id) return;
      config.observe.emit({
        name: "email.verify",
        method: via,
        outcome: "success",
        userId: user.id,
        email: user.email,
      });
      await runAfter(
        config.observe,
        "user.afterVerify",
        hooks.user.afterVerify,
        { user, via },
        user.id,
      );
    },
    sessionsEnded(n) {
      ended = n;
    },
    endedCount: () => ended,
    async keep(tx, user) {
      if (claimed !== user.id) return;
      // Postgres and MySQL answer false: a throw there still reverses the claim.
      if (await tx.keep()) kept = user;
    },
    kept: () => kept,
    flipLost() {
      lost = true;
    },
    lostFlip: () => lost,
  };
}

/**
 * The after points of a claim that `keep` made final, for a flow that
 * answers an error or throws after it (plan 12o, spec 8.9). They are
 * `email.verify` and `user.afterVerify`, then `session.end`,
 * `session.afterEnd` with reason `claim`, and `operator.afterAction` per
 * stop row. With no kept claim, nothing runs. `ended` is the list that the
 * claim filled.
 */
export async function keptClaimEnded(
  config: ResolvedConfig,
  verified: VerifySteps,
  ended: readonly SessionRow[] | undefined,
): Promise<void> {
  const user = verified.kept();
  if (!user) return;
  await verified.after(user);
  await sessionsEnded(config, ended, "claim", verified.stops, verified.endedCount());
}

/**
 * Runs `work`, the claim of a flow that answers a `Result` (plan 12o). On an
 * error answer or a throw, it first fires the after points of a claim that
 * `keep` made final (`keptClaimEnded`).
 */
export async function claimAnswer<T>(
  config: ResolvedConfig,
  verified: VerifySteps,
  ended: readonly SessionRow[] | undefined,
  work: () => Promise<Result<T>>,
): Promise<Result<T>> {
  let answer: Result<T>;
  try {
    answer = await work();
  } catch (e) {
    await keptClaimEnded(config, verified, ended);
    throw e;
  }
  if (!answer.ok) await keptClaimEnded(config, verified, ended);
  return answer;
}
