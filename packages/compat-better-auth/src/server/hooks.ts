import {
  HOOK_REFUSED_TEXT,
  type HooksConfig,
  hookRefusal,
  type IdentityHooks,
  type IdentitySummary,
  type OrganizationHooks,
  type SessionHooks,
  type SessionPatch,
  type UserCreatePatch,
  type UserHooks,
  type UserRow,
} from "@authtempo/core";
import type {
  AccountHookFields,
  BetterAuthOptions,
  OrganizationHookOptions,
  SessionDraftFields,
  User,
} from "../types.js";
import { pluginOf } from "./check-options.js";
import { toInvitation, toMember, toOrganization, toSession, toUser } from "./shapes.js";

/** Better Auth 1.7.2's text for the limit (dist/plugins/organization/error-codes.mjs:5, read 2026-10-13). */
export const ORGANIZATION_LIMIT_TEXT = "You have reached the maximum number of organizations";

/** Better Auth's function form of `organizationLimit`: true means the user is at the limit. */
type OrganizationLimitFn = (user: User) => boolean | Promise<boolean>;

type SessionCreateHooks = NonNullable<
  NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]>["create"]
>;

/** Any Better Auth hook, called with the one argument it reads by its own type. */
type AnyHook = (data: never) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runs `work`, and turns a thrown `APIError` into core's refusal with its
 * message: core answers `hook_refused` (403). The name check covers
 * better-call's own class too, for an app that imports it in a test.
 */
async function refusingApiErrors<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof Error && e.name === "APIError") throw hookRefusal(e.message);
    throw e;
  }
}

/**
 * Calls one Better Auth hook. In Better Auth a before hook may return
 * `{ data }` to change the row; a core hook cannot change a row. So a `data`
 * field whose value differs from the value in `given` stops the write: one
 * line names the hook and the fields, and core answers `hook_failed`. A
 * `data` that changes nothing passes. The compare is `Object.is`, so an
 * object or array field compares by reference: a new copy of `metadata`
 * with the same content counts as a change and stops the write (parked
 * Minor 15). `given` is null for a hook whose return Better Auth ignores.
 */
async function callHook(
  name: keyof OrganizationHookOptions,
  hook: AnyHook,
  data: object,
  given: Record<string, unknown> | null,
): Promise<void> {
  const out = await refusingApiErrors(() => hook(data as never));
  if (given === null || !isRecord(out) || !isRecord(out.data)) return;
  const returned = out.data;
  const changed = Object.keys(returned).filter((key) => !Object.is(returned[key], given[key]));
  if (changed.length === 0) return;
  console.error(
    `authtempo compat: organizationHooks.${name} returned data that changes ${changed.join(", ")}; a core hook cannot change a row, so the write stops`,
  );
  throw new Error(`authtempo compat: organizationHooks.${name} returned data`);
}

/** Core's organization hooks from Better Auth's `organizationHooks`. A core point is set only when a mapped hook exists. */
function organizationHooksOf(
  h: OrganizationHookOptions,
  limit: OrganizationLimitFn | null,
): OrganizationHooks {
  const out: OrganizationHooks = {};
  const beforeCreate = h.beforeCreateOrganization;
  if (beforeCreate || limit)
    out.beforeCreate = async (e) => {
      const user = toUser(e.user);
      // Better Auth runs the function limit before beforeCreateOrganization, and a truthy
      // answer means the user is at the limit (crud-org.mjs:61-64, read 2026-10-13).
      if (limit && (await refusingApiErrors(() => limit(user))))
        throw hookRefusal(ORGANIZATION_LIMIT_TEXT);
      if (!beforeCreate) return;
      // Better Auth passes the body. Core minted the id already, so the id is here too:
      // an app that keeps its own row writes it with this id (consumerc's order).
      const organization = {
        id: e.organization.id,
        name: e.organization.name,
        slug: e.organization.slug,
        logo: null,
        metadata: e.organization.metadata,
      };
      await callHook(
        "beforeCreateOrganization",
        beforeCreate,
        { organization, user },
        organization,
      );
    };
  const afterCreate = h.afterCreateOrganization;
  if (afterCreate)
    out.afterCreate = (e) =>
      callHook(
        "afterCreateOrganization",
        afterCreate,
        {
          organization: toOrganization(e.organization),
          member: toMember(e.organization.id, e.member),
          user: toUser(e.user),
        },
        null,
      );
  const beforeUpdate = h.beforeUpdateOrganization;
  if (beforeUpdate)
    out.beforeUpdate = (e) => {
      // Better Auth passes the patch, not the row (crud-org.mjs:218).
      const organization = { ...e.patch };
      return callHook(
        "beforeUpdateOrganization",
        beforeUpdate,
        {
          organization,
          user: toUser(e.user),
          member: toMember(e.organization.id, e.member),
        },
        organization,
      );
    };
  const afterUpdate = h.afterUpdateOrganization;
  if (afterUpdate)
    out.afterUpdate = (e) =>
      callHook(
        "afterUpdateOrganization",
        afterUpdate,
        {
          organization: toOrganization(e.organization),
          user: toUser(e.user),
          member: toMember(e.organization.id, e.member),
        },
        null,
      );
  const beforeDelete = h.beforeDeleteOrganization;
  if (beforeDelete)
    out.beforeDelete = (e) =>
      callHook(
        "beforeDeleteOrganization",
        beforeDelete,
        { organization: toOrganization(e.organization), user: toUser(e.user) },
        null,
      );
  const afterDelete = h.afterDeleteOrganization;
  if (afterDelete)
    out.afterDelete = (e) =>
      callHook(
        "afterDeleteOrganization",
        afterDelete,
        { organization: toOrganization(e.organization), user: toUser(e.user) },
        null,
      );
  const beforeAdd = h.beforeAddMember;
  const beforeAccept = h.beforeAcceptInvitation;
  if (beforeAdd || beforeAccept)
    out.beforeAddMember = async (e) => {
      const organization = toOrganization(e.organization);
      const user = toUser(e.memberUser);
      // Better Auth runs beforeAcceptInvitation on an accept (crud-invites.mjs:280), and
      // beforeAddMember on a create or an add (crud-org.mjs:85, crud-members.mjs:75).
      if (e.via === "invitation") {
        if (beforeAccept && e.invitation)
          await callHook(
            "beforeAcceptInvitation",
            beforeAccept,
            {
              invitation: toInvitation(e.invitation, e.invitation.id, "pending"),
              user,
              organization,
            },
            null,
          );
        return;
      }
      if (!beforeAdd) return;
      const member = {
        userId: e.member.userId,
        organizationId: e.organization.id,
        role: e.member.role,
      };
      await callHook("beforeAddMember", beforeAdd, { member, user, organization }, member);
    };
  const afterAdd = h.afterAddMember;
  if (afterAdd)
    out.afterAddMember = async (e) => {
      // Better Auth fires no afterAddMember on an accept; afterAcceptInvitation names that member.
      if (e.via === "invitation") return;
      await callHook(
        "afterAddMember",
        afterAdd,
        {
          member: toMember(e.organization.id, e.member),
          user: toUser(e.memberUser),
          organization: toOrganization(e.organization),
        },
        null,
      );
    };
  const beforeRole = h.beforeUpdateMemberRole;
  if (beforeRole)
    out.beforeUpdateMemberRole = (e) => {
      const member = toMember(e.organization.id, e.member);
      return callHook(
        "beforeUpdateMemberRole",
        beforeRole,
        {
          member,
          newRole: e.role,
          user: toUser(e.memberUser),
          organization: toOrganization(e.organization),
        },
        { ...member, role: e.role },
      );
    };
  const afterRole = h.afterUpdateMemberRole;
  if (afterRole)
    out.afterUpdateMemberRole = (e) =>
      callHook(
        "afterUpdateMemberRole",
        afterRole,
        {
          member: toMember(e.organization.id, e.member),
          previousRole: e.previousRole,
          user: toUser(e.memberUser),
          organization: toOrganization(e.organization),
        },
        null,
      );
  const beforeRemove = h.beforeRemoveMember;
  if (beforeRemove)
    out.beforeRemoveMember = (e) =>
      callHook(
        "beforeRemoveMember",
        beforeRemove,
        {
          member: toMember(e.organization.id, e.member),
          user: toUser(e.memberUser),
          organization: toOrganization(e.organization),
        },
        null,
      );
  const afterRemove = h.afterRemoveMember;
  if (afterRemove)
    out.afterRemoveMember = (e) =>
      callHook(
        "afterRemoveMember",
        afterRemove,
        {
          member: toMember(e.organization.id, e.member),
          user: toUser(e.memberUser),
          organization: toOrganization(e.organization),
        },
        null,
      );
  const beforeInvite = h.beforeCreateInvitation;
  if (beforeInvite)
    out.beforeInvite = (e) => {
      const invitation = {
        email: e.invitation.email,
        role: e.invitation.role,
        organizationId: e.organization.id,
        inviterId: e.by.id,
      };
      return callHook(
        "beforeCreateInvitation",
        beforeInvite,
        { invitation, inviter: toUser(e.by), organization: toOrganization(e.organization) },
        invitation,
      );
    };
  const afterInvite = h.afterCreateInvitation;
  if (afterInvite)
    out.afterInvite = (e) =>
      callHook(
        "afterCreateInvitation",
        afterInvite,
        {
          invitation: toInvitation(e.invitation, e.invitation.id, "pending"),
          inviter: toUser(e.by),
          organization: toOrganization(e.organization),
        },
        null,
      );
  const afterAccept = h.afterAcceptInvitation;
  if (afterAccept)
    out.afterAcceptInvitation = (e) =>
      callHook(
        "afterAcceptInvitation",
        afterAccept,
        {
          invitation: toInvitation(e.invitation, e.invitation.id, "accepted"),
          member: toMember(e.organization.id, e.member),
          user: toUser(e.user),
          organization: toOrganization(e.organization),
        },
        null,
      );
  const afterReject = h.afterRejectInvitation;
  if (afterReject)
    out.afterDeclineInvitation = (e) =>
      callHook(
        "afterRejectInvitation",
        afterReject,
        {
          invitation: toInvitation(e.invitation, e.invitation.id, "rejected"),
          user: e.user ? toUser(e.user) : null,
          organization: toOrganization(e.organization),
        },
        null,
      );
  const afterCancel = h.afterCancelInvitation;
  if (afterCancel)
    out.afterRevokeInvitation = (e) =>
      callHook(
        "afterCancelInvitation",
        afterCancel,
        {
          invitation: toInvitation(e.invitation, e.invitation.id, "canceled"),
          cancelledBy: toUser(e.by),
          organization: toOrganization(e.organization),
        },
        null,
      );
  return out;
}

/**
 * Core's session hooks from `databaseHooks.session.create` (plan 9d). The
 * before hook's `{ data }` may change `ipAddress`, `userAgent`, and
 * `activeOrganizationId`. A change of any other field is dropped, with one
 * line per instance. `false` refuses, as in Better Auth.
 */
function sessionHooksOf(create: SessionCreateHooks | undefined): SessionHooks {
  const out: SessionHooks = {};
  const before = create?.before;
  if (before) {
    let warned = false;
    out.beforeCreate = async (e) => {
      // Better Auth's names. Core writes the id, the token, and the dates after this hook.
      const given: SessionDraftFields = {
        userId: e.session.userId,
        ipAddress: e.session.ip,
        userAgent: e.session.userAgent,
        activeOrganizationId: null,
      };
      const answer = await refusingApiErrors(() => before({ ...given }, null));
      // Better Auth: "if the hook returns false, the session will not be created".
      if (answer === false) throw hookRefusal(HOOK_REFUSED_TEXT);
      if (!isRecord(answer) || !isRecord(answer.data)) return undefined;
      const patch: SessionPatch = {};
      const dropped: string[] = [];
      for (const [key, value] of Object.entries(answer.data)) {
        if (Object.hasOwn(given, key) && Object.is(value, given[key as keyof SessionDraftFields]))
          continue;
        if (key === "ipAddress" && (typeof value === "string" || value === null)) patch.ip = value;
        else if (key === "userAgent" && (typeof value === "string" || value === null))
          patch.userAgent = value;
        else if (key === "activeOrganizationId" && (typeof value === "string" || value === null))
          patch.activeOrganizationId = value;
        else dropped.push(key);
      }
      if (dropped.length > 0 && !warned) {
        warned = true;
        console.error(
          `authtempo compat: databaseHooks.session.create.before changed ${dropped.join(", ")}; core takes ipAddress, userAgent, and activeOrganizationId only and drops the rest (one line per instance)`,
        );
      }
      return patch;
    };
  }
  const after = create?.after;
  if (after)
    out.afterCreate = async (e) => {
      // The session.token column holds the token's SHA-256 hex, so the hook gets that value.
      await after(toSession(e.session, e.session.tokenHash), null);
    };
  return out;
}

/**
 * Core's user hooks from `databaseHooks.user` and `user.deleteUser` (plan
 * 12a). `create.before` may answer `{ data }` with `name` and `image`. A
 * change of any other field is dropped, with one line per instance. `false`
 * refuses, as in Better Auth. Core's update hooks change no row, so an
 * update answer with `data` is dropped with one line. The delete runs
 * `deleteUser.beforeDelete`, then `databaseHooks.user.delete.before`. After
 * the delete it runs `databaseHooks.user.delete.after`, then
 * `deleteUser.afterDelete`. Better Auth 1.7.2 runs the database hooks
 * inside its deleteUser (dist/api/routes/update-user.mjs:340 to :346 and
 * dist/db/with-hooks.mjs:115 to :145, read 2026-10-17). The `request`
 * argument is undefined: core's hook carries no request.
 */
function userHooksOf(options: BetterAuthOptions): UserHooks {
  const db = options.databaseHooks?.user;
  const del = options.user?.deleteUser;
  const out: UserHooks = {};
  const createBefore = db?.create?.before;
  if (createBefore) {
    let warned = false;
    out.beforeCreate = async (e) => {
      const given = toUser(e.user);
      const answer = await refusingApiErrors(() => createBefore({ ...given }, null));
      if (answer === false) throw hookRefusal(HOOK_REFUSED_TEXT);
      if (!isRecord(answer) || !isRecord(answer.data)) return undefined;
      const patch: UserCreatePatch = {};
      const dropped: string[] = [];
      for (const [key, value] of Object.entries(answer.data)) {
        if (Object.hasOwn(given, key) && Object.is(value, given[key as keyof User])) continue;
        // Better Auth's names: an empty name for no name.
        if (key === "name" && typeof value === "string") patch.name = value === "" ? null : value;
        else if (key === "image" && (typeof value === "string" || value === null))
          patch.image = value;
        else dropped.push(key);
      }
      if (dropped.length > 0 && !warned) {
        warned = true;
        console.error(
          `authtempo compat: databaseHooks.user.create.before changed ${dropped.join(", ")}; core takes name and image only and drops the rest (one line per instance)`,
        );
      }
      return patch;
    };
  }
  const createAfter = db?.create?.after;
  if (createAfter) out.afterCreate = async (e) => createAfter(toUser(e.user), null);
  const updateBefore = db?.update?.before;
  if (updateBefore) {
    let warned = false;
    out.beforeUpdate = async (e) => {
      // Better Auth passes the fields of the update, in its own names.
      const data: Partial<User> = {};
      if (e.patch.name !== undefined) data.name = e.patch.name ?? "";
      if (e.patch.image !== undefined) data.image = e.patch.image;
      if (e.patch.email !== undefined) data.email = e.patch.email;
      const answer = await refusingApiErrors(() => updateBefore(data, null));
      if (answer === false) throw hookRefusal(HOOK_REFUSED_TEXT);
      if (isRecord(answer) && isRecord(answer.data) && !warned) {
        warned = true;
        console.error(
          "authtempo compat: databaseHooks.user.update.before answered data; core's update hooks change no row, so it is dropped (one line per instance)",
        );
      }
    };
  }
  const updateAfter = db?.update?.after;
  if (updateAfter) out.afterUpdate = async (e) => updateAfter(toUser(e.user), null);
  const beforeDeletes: ((u: User) => unknown)[] = [];
  const dbBefore = db?.delete?.before;
  if (del?.beforeDelete) beforeDeletes.push(del.beforeDelete);
  if (dbBefore) beforeDeletes.push((u) => dbBefore(u, null));
  if (beforeDeletes.length > 0)
    out.beforeDelete = async (e) => {
      const user = toUser(e.user);
      for (const hook of beforeDeletes) {
        const answer = await refusingApiErrors(() => hook({ ...user }));
        if (answer === false) throw hookRefusal(HOOK_REFUSED_TEXT);
      }
    };
  const afterDeletes: ((u: User) => unknown)[] = [];
  const dbAfter = db?.delete?.after;
  if (dbAfter) afterDeletes.push((u) => dbAfter(u, null));
  if (del?.afterDelete) afterDeletes.push(del.afterDelete);
  if (afterDeletes.length > 0)
    out.afterDelete = async (e) => {
      const user = toUser(e.user);
      for (const hook of afterDeletes) await hook({ ...user });
    };
  return out;
}

type AccountHook = (account: AccountHookFields, context: null) => unknown;

/** Better Auth's account fields of a core identity event. */
function accountFields(e: { user: UserRow; identity: IdentitySummary }): AccountHookFields {
  return { providerId: e.identity.provider, accountId: e.identity.subject, userId: e.user.id };
}

/** A before hook: `false` or a thrown APIError refuses. */
function beforeAccount(hook: AccountHook | undefined) {
  if (!hook) return undefined;
  return async (e: { user: UserRow; identity: IdentitySummary }) => {
    const answer = await refusingApiErrors(() => hook(accountFields(e), null));
    if (answer === false) throw hookRefusal(HOOK_REFUSED_TEXT);
  };
}

function afterAccount(hook: AccountHook | undefined) {
  if (!hook) return undefined;
  return async (e: { user: UserRow; identity: IdentitySummary }) => {
    await hook(accountFields(e), null);
  };
}

/**
 * Core's identity hooks from `databaseHooks.account` (plan 12a): create maps
 * to the link, and delete to the unlink. A credential account fires none: it
 * is core's password row. Core's account delete fires no identity hook,
 * where Better Auth's user delete runs the account delete hooks.
 */
function identityHooksOf(options: BetterAuthOptions): IdentityHooks {
  const db = options.databaseHooks?.account;
  const out: IdentityHooks = {};
  const beforeLink = beforeAccount(db?.create?.before);
  if (beforeLink) out.beforeLink = beforeLink;
  const afterLink = afterAccount(db?.create?.after);
  if (afterLink) out.afterLink = afterLink;
  const beforeUnlink = beforeAccount(db?.delete?.before);
  if (beforeUnlink) out.beforeUnlink = beforeUnlink;
  const afterUnlink = afterAccount(db?.delete?.after);
  if (afterUnlink) out.afterUnlink = afterUnlink;
  return out;
}

/** Core's `hooks` from the Better Auth options (plan 9d; user and identity since plan 12a). */
export function compatHooks(options: BetterAuthOptions): HooksConfig {
  const org = pluginOf(options, "organization")?.options;
  const limit = org && typeof org.organizationLimit === "function" ? org.organizationLimit : null;
  return {
    ...(org ? { organization: organizationHooksOf(org.organizationHooks ?? {}, limit) } : {}),
    session: sessionHooksOf(options.databaseHooks?.session?.create),
    user: userHooksOf(options),
    identity: identityHooksOf(options),
  };
}
