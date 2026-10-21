import { ERRORS, type ErrorCode } from "../errors.js";
import type { Observer } from "../observe/observer.js";
import { hasControlChar } from "../primitives/text.js";
import type { Result } from "../result.js";
import type { OperatorAuditRow, SessionRow, UserRow } from "../schema.js";
import type { InvitationSummary } from "./invitations.js";
import type { OperatorAuditDraft } from "./operator/audit.js";
import type { MemberSummary, OrganizationSummary } from "./organizations.js";
import type { TeamMemberSummary, TeamSummary } from "./teams.js";

/**
 * Hooks (plan 9d, spec 8.9). A hook is the app's code at a named point of a
 * core flow. The engine owns the flow, the rank checks, and the limits; a
 * hook never widens them. A before hook runs inside the flow's transaction,
 * after core's checks and after core mints the row's id, and before the
 * first write: a throw undoes the transaction, so a refusal leaves no row.
 * An after hook runs after the commit and cannot undo it: a throw is logged
 * and the flow answers its success. Hooks run in process with no timeout,
 * as the mail port does.
 */

export type Awaitable<T> = T | Promise<T>;

/**
 * How a member row came. `create`: the creator's owner row. `add`: an add by
 * an admin. `invitation`: an accepted invitation. `operator`: an operator act
 * of plan 12f, the grant of the platform role or `createAdmin`.
 */
export type MemberVia = "create" | "add" | "invitation" | "operator";
/** A remove by another member, a leave by the member, or the revoke of the platform role (plan 12f). */
export type RemoveVia = "remove" | "leave" | "operator";
/** How a session came. `impersonation`: a platform operator opened it for the user (plan 12f). */
export type SessionVia =
  | "password"
  | "magic_link"
  | "social"
  | "passkey"
  | "handoff"
  | "email_otp"
  | "impersonation";
/**
 * Each value of `SessionVia` (plan 12f). The ban doors test reads it, so a
 * new value fails that test until the test gets a row for it.
 */
export const SESSION_VIA = {
  password: true,
  magic_link: true,
  social: true,
  passkey: true,
  handoff: true,
  email_otp: true,
  impersonation: true,
} as const satisfies Record<SessionVia, true>;
export type SessionEndReason =
  | "sign_out"
  | "password_reset"
  | "password_change"
  | "claim"
  | "expired"
  // plan 9f: the enable of a second factor ends the user's other sessions.
  | "two_factor"
  // plan 12a: a revoke of one session or of the others from a settings page.
  | "revoked"
  // plan 12a: a change of address ends every other session and grant.
  | "email_change"
  // plan 12a: the account delete ends every session of the user. Since plan
  // 12f it also ends the impersonation sessions that the user opened.
  | "account_deleted"
  // plan 12e: a relying party asks for the end (OIDC RP-Initiated Logout 1.0).
  | "oidc_logout"
  // plan 12f: an operator bans the user, or a session of a banned user is presented.
  // It also ends the impersonation sessions that a banned operator opened.
  | "banned"
  // plan 12f: an operator ends the sessions of one user or of all users, or
  // revokes the platform role. A revoke also ends the impersonation sessions
  // that the user opened.
  | "operator"
  // plan 12f: the end of an impersonation session for one of three causes.
  // The operator stops it. A removal, a leave, or a role change takes the
  // platform role from its operator. Or a session read finds its operator
  // banned, deleted, or without the platform role.
  | "impersonation_end";
/**
 * Each value of `SessionEndReason`, for the `reason` field of the event
 * `session.end` (plan 12h Task 5). A Record, so a new reason fails the
 * compile until it has a row here.
 */
export const SESSION_END_REASONS = {
  sign_out: true,
  password_reset: true,
  password_change: true,
  claim: true,
  expired: true,
  two_factor: true,
  revoked: true,
  email_change: true,
  account_deleted: true,
  oidc_logout: true,
  banned: true,
  operator: true,
  impersonation_end: true,
} as const satisfies Record<SessionEndReason, true>;

/** The member a before hook sees: no row exists yet. */
export interface ProposedMember {
  userId: string;
  role: string;
}

/** The team member a before hook sees: no row exists yet (plan 12k). */
export interface ProposedTeamMember {
  teamId: string;
  userId: string;
}

/** The fields a team update writes (plan 12k). */
export interface TeamPatch {
  name: string;
}

/** The fields an organization update writes. Only the fields the caller sent are present. */
export interface OrganizationPatch {
  name?: string;
  slug?: string;
  metadata?: Record<string, unknown> | null;
}

export interface OrganizationHooks {
  beforeCreate?(e: { organization: OrganizationSummary; user: UserRow }): Awaitable<void>;
  afterCreate?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    user: UserRow;
  }): Awaitable<void>;
  /** `member` is the caller's own member row. */
  beforeUpdate?(e: {
    organization: OrganizationSummary;
    patch: OrganizationPatch;
    member: MemberSummary;
    user: UserRow;
  }): Awaitable<void>;
  /** `organization` is the stored row after the update. */
  afterUpdate?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    user: UserRow;
  }): Awaitable<void>;
  beforeDelete?(e: { organization: OrganizationSummary; user: UserRow }): Awaitable<void>;
  afterDelete?(e: { organization: OrganizationSummary; user: UserRow }): Awaitable<void>;
  /**
   * `invitation` is null unless `via` is `invitation`. In the six member
   * points, `by` is the user who acts. It is null for an operator act of a
   * secret or of the app (plan 12f), which has no user.
   */
  beforeAddMember?(e: {
    organization: OrganizationSummary;
    member: ProposedMember;
    memberUser: UserRow;
    by: UserRow | null;
    via: MemberVia;
    invitation: InvitationSummary | null;
  }): Awaitable<void>;
  afterAddMember?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    memberUser: UserRow;
    by: UserRow | null;
    via: MemberVia;
    invitation: InvitationSummary | null;
  }): Awaitable<void>;
  beforeUpdateMemberRole?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    role: string;
    memberUser: UserRow;
    by: UserRow | null;
  }): Awaitable<void>;
  /** `member` holds the new role. */
  afterUpdateMemberRole?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    previousRole: string;
    memberUser: UserRow;
    by: UserRow | null;
  }): Awaitable<void>;
  beforeRemoveMember?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    memberUser: UserRow;
    by: UserRow | null;
    via: RemoveVia;
  }): Awaitable<void>;
  afterRemoveMember?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    memberUser: UserRow;
    by: UserRow | null;
    via: RemoveVia;
  }): Awaitable<void>;
  beforeInvite?(e: {
    organization: OrganizationSummary;
    invitation: { email: string; role: string };
    by: UserRow;
  }): Awaitable<void>;
  afterInvite?(e: {
    organization: OrganizationSummary;
    invitation: InvitationSummary;
    by: UserRow;
  }): Awaitable<void>;
  afterAcceptInvitation?(e: {
    organization: OrganizationSummary;
    invitation: InvitationSummary;
    member: MemberSummary;
    user: UserRow;
  }): Awaitable<void>;
  /** `user` is the user of the session the request carried, or null: a decline needs the token only. */
  afterDeclineInvitation?(e: {
    organization: OrganizationSummary;
    invitation: InvitationSummary;
    user: UserRow | null;
  }): Awaitable<void>;
  afterRevokeInvitation?(e: {
    organization: OrganizationSummary;
    invitation: InvitationSummary;
    by: UserRow;
  }): Awaitable<void>;
  // The ten team points (plan 12k): Better Auth 1.7.2's names (`organization/types.d.mts`, read 2026-10-14).
  // A cascade fires none: a member removal, a team delete, and an organization delete drop team rows
  // with no team hook. The default team of a create and the team rows of an accept are part of that
  // flow's own write. They fire no team hook either.
  /** `user` is the caller. `team` holds the id that core minted; no row exists yet. */
  beforeCreateTeam?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    user: UserRow;
  }): Awaitable<void>;
  afterCreateTeam?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    user: UserRow;
  }): Awaitable<void>;
  beforeUpdateTeam?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    patch: TeamPatch;
    user: UserRow;
  }): Awaitable<void>;
  /** `team` is the stored row after the update. */
  afterUpdateTeam?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    user: UserRow;
  }): Awaitable<void>;
  beforeDeleteTeam?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    user: UserRow;
  }): Awaitable<void>;
  afterDeleteTeam?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    user: UserRow;
  }): Awaitable<void>;
  /** `memberUser` is the person who joins the team; `by` is the caller. */
  beforeAddTeamMember?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    teamMember: ProposedTeamMember;
    memberUser: UserRow;
    by: UserRow;
  }): Awaitable<void>;
  afterAddTeamMember?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    teamMember: TeamMemberSummary;
    memberUser: UserRow;
    by: UserRow;
  }): Awaitable<void>;
  /** A leave of the team has `by` equal to `memberUser`. */
  beforeRemoveTeamMember?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    teamMember: TeamMemberSummary;
    memberUser: UserRow;
    by: UserRow;
  }): Awaitable<void>;
  afterRemoveTeamMember?(e: {
    organization: OrganizationSummary;
    team: TeamSummary;
    teamMember: TeamMemberSummary;
    memberUser: UserRow;
    by: UserRow;
  }): Awaitable<void>;
}

/** The event of one organization hook point. */
export type OrganizationHookEvent<K extends keyof OrganizationHooks> = Parameters<
  NonNullable<OrganizationHooks[K]>
>[0];

/** The session a before hook sees: core writes the id, the token hash, and the dates. */
export interface SessionDraft {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  activeOrganizationId: null;
}

/**
 * What `session.beforeCreate` may change. A set `activeOrganizationId` must
 * name an organization the user is a member of, or the sign-in answers
 * `not_found`.
 */
export interface SessionPatch {
  ip?: string | null;
  userAgent?: string | null;
  activeOrganizationId?: string | null;
}

/** A patch, or nothing: a hook with no return statement returns void. */
// biome-ignore lint/suspicious/noConfusingVoidType: with undefined, a hook with no return statement does not type-check.
type SessionPatchAnswer = SessionPatch | void;

export interface SessionHooks {
  beforeCreate?(e: {
    session: SessionDraft;
    user: UserRow;
    via: SessionVia;
  }): Awaitable<SessionPatchAnswer>;
  afterCreate?(e: { session: SessionRow; user: UserRow; via: SessionVia }): Awaitable<void>;
  /**
   * Once per session row that a flow deleted. The sweep fires it only for
   * a session that a ban or a revoke left for it (ruling 44 of plan 12f).
   */
  afterEnd?(e: { session: SessionRow; reason: SessionEndReason }): Awaitable<void>;
}

/**
 * How a user row came: the flow's sign-in, or a reset that created the user
 * (plan 12a). `operator`: `createAdmin` of plan 12f creates the user, with no
 * proof of the address. An impersonation opens a session of a user that
 * exists, so it creates no user.
 */
export type UserCreateVia = Exclude<SessionVia, "impersonation"> | "password_reset" | "operator";
/** Each value of `UserCreateVia`, for the event `sign_up` (plan 12h Task 5). */
export const USER_CREATE_VIA = {
  password: true,
  magic_link: true,
  social: true,
  passkey: true,
  handoff: true,
  email_otp: true,
  password_reset: true,
  operator: true,
} as const satisfies Record<UserCreateVia, true>;
/** The profile update, the change of address (plan 12a), or an operator's ban and unban (plan 12f). */
export type UserUpdateVia = "profile" | "email_change" | "ban" | "unban";
/**
 * The flow that proves the address of an existing unverified user (plan
 * 12a). `social` is a sign-in with a verified provider address.
 * `password_reset` is the reset link or the reset code.
 */
export type UserVerifyVia =
  | "password_verify"
  | "magic_link"
  | "email_otp"
  | "social"
  | "password_reset";
/** Each value of `UserVerifyVia`, for the event `email.verify` (plan 12h Task 5). */
export const USER_VERIFY_VIA = {
  password_verify: true,
  magic_link: true,
  email_otp: true,
  social: true,
  password_reset: true,
} as const satisfies Record<UserVerifyVia, true>;
/**
 * How an identity came (plan 12a). `sign_in` is a social sign-in that
 * creates a user or links a verified equal address. `link` is the link of
 * a signed-in user.
 */
export type IdentityLinkVia = "sign_in" | "link";

/** The identity a hook sees: the provider name and the provider's subject. Never the `email` identity. */
export interface IdentitySummary {
  provider: string;
  subject: string;
}

/** The fields of a user update. Only the fields the flow writes are present (plan 12a). */
export interface UserPatch {
  name?: string | null;
  image?: string | null;
  email?: string;
  /** The ban writes the three ban fields. The unban writes `banUntil` alone, while a ban is active (ruling 28). */
  bannedAt?: Date | null;
  banReason?: string | null;
  banUntil?: Date | null;
}

/**
 * What `user.beforeCreate` may change (plan 12a): `name` and `image`, each a
 * string or null, under the profile rules. A name passes `validUserName`:
 * 1 to 200 code units with no control, format (except U+200C and U+200D),
 * line separator, paragraph separator, or lone surrogate character.
 * An image passes `validImageUrl`: an `https://`
 * URL with a host, of at most 2048 characters, with no credentials. Any
 * other key or value answers `hook_failed`.
 */
export interface UserCreatePatch {
  name?: string | null;
  image?: string | null;
}

/** A patch, or nothing: a hook with no return statement returns void. */
// biome-ignore lint/suspicious/noConfusingVoidType: with undefined, a hook with no return statement does not type-check.
type UserCreatePatchAnswer = UserCreatePatch | void;

/**
 * The user points (plan 12a, spec 8.9). The social fill of the name and the
 * image, the sweep, and the importer fire no user hook. A claim's flip of
 * `emailVerified` fires `beforeVerify` and `afterVerify` only.
 */
export interface UserHooks {
  /**
   * Before every user create: the magic link, the email code, social, the
   * password sign-up, and the reset that creates a user. `user` is the row
   * that core minted. It does not exist yet.
   */
  beforeCreate?(e: { user: UserRow; via: UserCreateVia }): Awaitable<UserCreatePatchAnswer>;
  afterCreate?(e: { user: UserRow; via: UserCreateVia }): Awaitable<void>;
  /** The profile update, the change of address, the ban, and the unban. `patch` holds the fields the flow writes. */
  beforeUpdate?(e: { user: UserRow; patch: UserPatch; via: UserUpdateVia }): Awaitable<void>;
  /** `user` is the stored row after the update. */
  afterUpdate?(e: { user: UserRow; previous: UserRow; via: UserUpdateVia }): Awaitable<void>;
  /** The account delete. `organizations` holds the ids of the organizations that go with the account. */
  beforeDelete?(e: { user: UserRow; organizations: string[] }): Awaitable<void>;
  /** `user` is the row as it was before the delete. */
  afterDelete?(e: { user: UserRow }): Awaitable<void>;
  /**
   * Before a flow moves an existing user from `emailVerified: false` to
   * true, and before the flow's first write. `user` is the stored row, still
   * unverified. A user that a flow creates verified fires `beforeCreate`, not
   * this point. The change of address fires `beforeUpdate`, not this point.
   */
  beforeVerify?(e: { user: UserRow; via: UserVerifyVia }): Awaitable<void>;
  /** Once after the commit. `user` is the stored row, now verified. */
  afterVerify?(e: { user: UserRow; via: UserVerifyVia }): Awaitable<void>;
}

/** The identity points (plan 12a, spec 8.9). A claim's identity deletes and the account delete fire none. */
export interface IdentityHooks {
  beforeLink?(e: {
    user: UserRow;
    identity: IdentitySummary;
    via: IdentityLinkVia;
  }): Awaitable<void>;
  afterLink?(e: {
    user: UserRow;
    identity: IdentitySummary;
    via: IdentityLinkVia;
  }): Awaitable<void>;
  beforeUnlink?(e: { user: UserRow; identity: IdentitySummary }): Awaitable<void>;
  afterUnlink?(e: { user: UserRow; identity: IdentitySummary }): Awaitable<void>;
}

/**
 * The operator points (plan 12f, spec 26 item 10). Each operator act runs
 * them through `operatorAct`. They need `operator.users`.
 */
export interface OperatorHooks {
  /**
   * Before the act's transaction, so before its first write. `audit` is
   * the row that the act writes, with no id yet. A refusal answers
   * `hook_refused`, and the act writes nothing.
   */
  beforeAction?(e: { audit: OperatorAuditDraft }): Awaitable<void>;
  /**
   * Once per audit row, after the commit. A throw writes one log line and
   * cannot undo the act. Send the row to a separate system here: a person
   * with write access to the database can change the table (ASVS 16.4.3).
   */
  afterAction?(e: { audit: OperatorAuditRow }): Awaitable<void>;
}

export interface HooksConfig {
  organization?: OrganizationHooks;
  session?: SessionHooks;
  user?: UserHooks;
  identity?: IdentityHooks;
  operator?: OperatorHooks;
}

/** After `resolveConfig`: every group present, each hook bound to the object it came on. */
export interface ResolvedHooks {
  organization: OrganizationHooks;
  session: SessionHooks;
  user: UserHooks;
  identity: IdentityHooks;
  operator: OperatorHooks;
}

/** The name in a log line. */
export type HookName =
  | `organization.${keyof OrganizationHooks & string}`
  | `session.${keyof SessionHooks & string}`
  | `user.${keyof UserHooks & string}`
  | `identity.${keyof IdentityHooks & string}`
  | `operator.${keyof OperatorHooks & string}`;

/** Every hook point. A Record, so a point added to the interface and not listed here fails the compile. */
export const ORGANIZATION_HOOK_POINTS: Readonly<Record<keyof OrganizationHooks, true>> = {
  beforeCreate: true,
  afterCreate: true,
  beforeUpdate: true,
  afterUpdate: true,
  beforeDelete: true,
  afterDelete: true,
  beforeAddMember: true,
  afterAddMember: true,
  beforeUpdateMemberRole: true,
  afterUpdateMemberRole: true,
  beforeRemoveMember: true,
  afterRemoveMember: true,
  beforeInvite: true,
  afterInvite: true,
  afterAcceptInvitation: true,
  afterDeclineInvitation: true,
  afterRevokeInvitation: true,
  beforeCreateTeam: true,
  afterCreateTeam: true,
  beforeUpdateTeam: true,
  afterUpdateTeam: true,
  beforeDeleteTeam: true,
  afterDeleteTeam: true,
  beforeAddTeamMember: true,
  afterAddTeamMember: true,
  beforeRemoveTeamMember: true,
  afterRemoveTeamMember: true,
};

export const SESSION_HOOK_POINTS: Readonly<Record<keyof SessionHooks, true>> = {
  beforeCreate: true,
  afterCreate: true,
  afterEnd: true,
};

export const USER_HOOK_POINTS: Readonly<Record<keyof UserHooks, true>> = {
  beforeCreate: true,
  afterCreate: true,
  beforeUpdate: true,
  afterUpdate: true,
  beforeDelete: true,
  afterDelete: true,
  beforeVerify: true,
  afterVerify: true,
};

export const IDENTITY_HOOK_POINTS: Readonly<Record<keyof IdentityHooks, true>> = {
  beforeLink: true,
  afterLink: true,
  beforeUnlink: true,
  afterUnlink: true,
};

export const OPERATOR_HOOK_POINTS: Readonly<Record<keyof OperatorHooks, true>> = {
  beforeAction: true,
  afterAction: true,
};

/** The longest refusal text, in UTF-16 code units. The text goes into a JSON body that a client shows. */
export const HOOK_MESSAGE_MAX = 200;
export const HOOK_REFUSED_TEXT = "The app refused this request.";

/** What a before hook throws to refuse. Build it with `hookRefusal`. */
export class HookRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookRefusal";
  }
}

/** `throw hookRefusal("...")` in a before hook: the flow answers `hook_refused` (403) with the message. */
export function hookRefusal(message: string): HookRefusal {
  return new HookRefusal(message);
}

/** The message, when it has 1 to 200 UTF-16 code units and no control character; else the default text. */
export function publicHookMessage(message: string): string {
  return message.length >= 1 && message.length <= HOOK_MESSAGE_MAX && !hasControlChar(message)
    ? message
    : HOOK_REFUSED_TEXT;
}

type HookFailure = Extract<Result<never>, { ok: false }>;

/**
 * Thrown inside a transaction to stop the flow: a thrown error is the one
 * signal that makes every adapter undo the writes that already ran.
 * `hookGuard`, or the flow's own `catch`, catches it outside the transaction
 * and answers its `result`.
 */
export class HookStop extends Error {
  readonly result: HookFailure;
  constructor(result: HookFailure) {
    super(`authtempo: a hook stopped the flow with ${result.code}`);
    this.name = "HookStop";
    this.result = result;
  }
}

/**
 * What `patchFields` refuses: the shape of a patch answer. The patch lines
 * print one of these texts, and their event fields read these lists (plan 12h).
 */
export const PATCH_SHAPE_REFUSALS = [
  "a value that is not an object",
  "a value that cannot be read",
  "a value that is not a plain object",
] as const;
export type PatchShapeRefusal = (typeof PATCH_SHAPE_REFUSALS)[number];

/** What the session patch refuses after its shape. A key outside the patch keys prints `the field <key>`. */
export const SESSION_PATCH_REFUSALS = [
  "an ip that is not a string or null",
  "a userAgent that is not a string or null",
  "an activeOrganizationId that is not a string or null",
] as const;
export type SessionPatchRefusal = (typeof SESSION_PATCH_REFUSALS)[number];

/** What the user patch of `user.beforeCreate` refuses after its shape. */
export const USER_PATCH_REFUSALS = [
  "a field other than name and image",
  "a name that breaks the name rule",
  "an image that breaks the image rule",
] as const;
export type UserPatchRefusal = (typeof USER_PATCH_REFUSALS)[number];

/**
 * The own fields of a before hook's patch answer, or null for no patch
 * (`undefined` or `null`). The session patch and the user patch read the
 * answer here only. The answer is the app's object, so a getter or a proxy
 * can throw. The copy reads each own enumerable field once, in a `try`. A
 * throw, an array, a value that is not an object, or an object that is not
 * plain goes to `refuse`. It logs the reason and stops with `hook_failed`
 * (review L3 and L7 of plan 12a Task 5). A non-enumerable field is not read.
 */
export function patchFields(
  patch: unknown,
  refuse: (what: PatchShapeRefusal) => never,
): Record<string, unknown> | null {
  if (patch === undefined || patch === null) return null;
  if (typeof patch !== "object") return refuse("a value that is not an object");
  let copy: Record<string, unknown> | "array" | "not plain";
  try {
    if (Array.isArray(patch)) copy = "array";
    else {
      // createAuth's rule for hook objects (L7): a class instance or an
      // Object.create answer is refused, not read in part.
      const proto: unknown = Object.getPrototypeOf(patch);
      copy =
        proto === Object.prototype || proto === null
          ? { ...(patch as Record<string, unknown>) }
          : "not plain";
    }
  } catch {
    return refuse("a value that cannot be read");
  }
  if (copy === "array") return refuse("a value that is not an object");
  if (copy === "not plain") return refuse("a value that is not a plain object");
  return copy;
}

/** Stops the flow with a plain code, for example `not_found` for a session patch. */
export function stopWith(code: ErrorCode): never {
  throw new HookStop({ ok: false, code, status: ERRORS[code] });
}

function isRefusal(e: unknown): e is Error {
  // The name too: a second copy of this package in one bundle has its own class.
  return e instanceof HookRefusal || (e instanceof Error && e.name === "HookRefusal");
}

/**
 * The copy of the event that the hook gets. Core builds the event, so a
 * clone failure is a core fault, not the app's: it has its own log line, so
 * that it never reads as a hook failure (parked Minor 4).
 */
function eventCopy<E>(observe: Observer, name: HookName, event: E): { copy: E } | null {
  try {
    return { copy: structuredClone(event) };
  } catch (e) {
    observe.emit({ name: "hook.copy_failed", hook: name, errorName: e });
    return null;
  }
}

/**
 * Runs a before hook on a copy of the event and answers its value. A
 * refusal throws `HookStop` with `hook_refused`; any other throw writes one
 * line with the hook name and the filtered error name (`appErrorName`),
 * never the error message, and throws `HookStop` with `hook_failed`. A
 * refusal is matched before the filter, by its class or its name.
 */
export async function runBefore<E>(
  observe: Observer,
  name: HookName,
  hook: ((e: E) => unknown) | undefined,
  event: E,
): Promise<unknown> {
  if (!hook) return undefined;
  const copied = eventCopy(observe, name, event);
  if (!copied) throw new HookStop({ ok: false, code: "hook_failed", status: ERRORS.hook_failed });
  try {
    return await hook(copied.copy);
  } catch (e) {
    if (isRefusal(e))
      throw new HookStop({
        ok: false,
        code: "hook_refused",
        status: ERRORS.hook_refused,
        message: publicHookMessage(e.message),
      });
    observe.emit({ name: "hook.before_failed", hook: name, errorName: e });
    throw new HookStop({ ok: false, code: "hook_failed", status: ERRORS.hook_failed });
  }
}

/**
 * Runs an after hook on a copy of the event. The row is committed, so a
 * throw cannot undo it: one line with the hook name, the row id, and the
 * filtered error name, and the flow goes on (owner decision 1a, 2026-10-13).
 */
export async function runAfter<E>(
  observe: Observer,
  name: HookName,
  hook: ((e: E) => unknown) | undefined,
  event: E,
  rowId: string,
): Promise<void> {
  if (!hook) return;
  const copied = eventCopy(observe, name, event);
  if (!copied) return;
  try {
    await hook(copied.copy);
  } catch (e) {
    observe.emit({ name: "hook.after_failed", hook: name, rowId, errorName: e });
  }
}

/** Answers the failure of a `HookStop` that `work` threw. Any other error passes. */
export async function hookGuard<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof HookStop) return e.result;
    throw e;
  }
}
