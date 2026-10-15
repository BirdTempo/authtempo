import type { ResolvedConfig } from "../config.js";
import type { UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";
import {
  type IdentitySummary,
  runAfter,
  runBefore,
  stopWith,
  type UserCreateVia,
} from "./hooks.js";
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
function refusePatch(what: string): never {
  console.error("authtempo: user patch refused", what);
  return stopWith("hook_failed");
}

/**
 * The minted user after the answer of `user.beforeCreate`. Only `name` and
 * `image` change, under the profile rules. Any other key or value stops the
 * flow with `hook_failed`.
 */
export function patchedNewUser(user: UserRow, patch: unknown): UserRow {
  if (patch === undefined || patch === null) return user;
  if (typeof patch !== "object" || Array.isArray(patch))
    return refusePatch("a value that is not an object");
  const fields = patch as Record<string, unknown>;
  for (const key of Object.keys(fields))
    if (key !== "name" && key !== "image") return refusePatch("a field other than name and image");
  const out: UserRow = { ...user };
  const { name, image } = fields;
  if (name !== undefined) {
    if (name !== null && (typeof name !== "string" || !validUserName(name)))
      return refusePatch("a name that breaks the name rule");
    out.name = name;
  }
  if (image !== undefined) {
    if (image !== null && (typeof image !== "string" || !validImageUrl(image)))
      return refusePatch("an image that breaks the image rule");
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
  options: { signUpRule: boolean },
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
      const answer = await runBefore("user.beforeCreate", hooks.user.beforeCreate, { user, via });
      const patched = patchedNewUser(user, answer);
      minted = patched.id;
      return patched;
    },
    async identity(user, identity) {
      await runBefore("identity.beforeLink", hooks.identity.beforeLink, {
        user,
        identity,
        via: "sign_in",
      });
      linked = { userId: user.id, identity };
    },
    async after(user) {
      if (minted === user.id)
        await runAfter("user.afterCreate", hooks.user.afterCreate, { user, via }, user.id);
      if (linked && linked.userId === user.id)
        await runAfter(
          "identity.afterLink",
          hooks.identity.afterLink,
          { user, identity: linked.identity, via: "sign_in" },
          user.id,
        );
    },
  };
}
