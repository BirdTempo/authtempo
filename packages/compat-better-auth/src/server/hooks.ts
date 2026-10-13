import { type HooksConfig, hookRefusal, type OrganizationHooks } from "@tempo-auth/core";
import type { BetterAuthOptions, OrganizationHookOptions } from "../types.js";
import { pluginOf } from "./check-options.js";
import { toInvitation, toMember, toOrganization, toUser } from "./shapes.js";

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
 * `data` that changes nothing passes. `given` is null for a hook whose
 * return Better Auth ignores.
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
    `tempo-auth compat: organizationHooks.${name} returned data that changes ${changed.join(", ")}; a core hook cannot change a row, so the write stops`,
  );
  throw new Error(`tempo-auth compat: organizationHooks.${name} returned data`);
}

/** Core's organization hooks from Better Auth's `organizationHooks`. A core point is set only when a mapped hook exists. */
function organizationHooksOf(h: OrganizationHookOptions): OrganizationHooks {
  const out: OrganizationHooks = {};
  const beforeCreate = h.beforeCreateOrganization;
  if (beforeCreate)
    out.beforeCreate = async (e) => {
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
        { organization, user: toUser(e.user) },
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

/** Core's `hooks` from the Better Auth options (plan 9d). */
export function compatHooks(options: BetterAuthOptions): HooksConfig {
  const org = pluginOf(options, "organization")?.options;
  return org ? { organization: organizationHooksOf(org.organizationHooks ?? {}) } : {};
}
