import { ERRORS, type ErrorCode } from "../errors.js";
import { appErrorName } from "../primitives/app-error.js";
import { hasControlChar } from "../primitives/text.js";
import type { Result } from "../result.js";
import type { SessionRow, UserRow } from "../schema.js";
import type { InvitationSummary } from "./invitations.js";
import type { MemberSummary, OrganizationSummary } from "./organizations.js";

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

/** How a member row came: the creator's owner row, an add by an admin, or an accepted invitation. */
export type MemberVia = "create" | "add" | "invitation";
/** A remove by another member, or a leave by the member. */
export type RemoveVia = "remove" | "leave";
export type SessionVia = "password" | "magic_link" | "social" | "passkey" | "handoff" | "email_otp";
export type SessionEndReason =
  | "sign_out"
  | "password_reset"
  | "password_change"
  | "claim"
  | "expired";

/** The member a before hook sees: no row exists yet. */
export interface ProposedMember {
  userId: string;
  role: string;
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
  /** `invitation` is null unless `via` is `invitation`. */
  beforeAddMember?(e: {
    organization: OrganizationSummary;
    member: ProposedMember;
    memberUser: UserRow;
    by: UserRow;
    via: MemberVia;
    invitation: InvitationSummary | null;
  }): Awaitable<void>;
  afterAddMember?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    memberUser: UserRow;
    by: UserRow;
    via: MemberVia;
    invitation: InvitationSummary | null;
  }): Awaitable<void>;
  beforeUpdateMemberRole?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    role: string;
    memberUser: UserRow;
    by: UserRow;
  }): Awaitable<void>;
  /** `member` holds the new role. */
  afterUpdateMemberRole?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    previousRole: string;
    memberUser: UserRow;
    by: UserRow;
  }): Awaitable<void>;
  beforeRemoveMember?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    memberUser: UserRow;
    by: UserRow;
    via: RemoveVia;
  }): Awaitable<void>;
  afterRemoveMember?(e: {
    organization: OrganizationSummary;
    member: MemberSummary;
    memberUser: UserRow;
    by: UserRow;
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
  /** Once per session row that a flow deleted. The sweep fires none. */
  afterEnd?(e: { session: SessionRow; reason: SessionEndReason }): Awaitable<void>;
}

export interface HooksConfig {
  organization?: OrganizationHooks;
  session?: SessionHooks;
}

/** After `resolveConfig`: both groups present, each hook bound to the object it came on. */
export interface ResolvedHooks {
  organization: OrganizationHooks;
  session: SessionHooks;
}

/** The name in a log line. */
export type HookName =
  | `organization.${keyof OrganizationHooks & string}`
  | `session.${keyof SessionHooks & string}`;

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
};

export const SESSION_HOOK_POINTS: Readonly<Record<keyof SessionHooks, true>> = {
  beforeCreate: true,
  afterCreate: true,
  afterEnd: true,
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
    super(`tempo-auth: a hook stopped the flow with ${result.code}`);
    this.name = "HookStop";
    this.result = result;
  }
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
function eventCopy<E>(name: HookName, event: E): { copy: E } | null {
  try {
    return { copy: structuredClone(event) };
  } catch (e) {
    console.error("tempo-auth: hook event copy failed", name, appErrorName(e));
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
  name: HookName,
  hook: ((e: E) => unknown) | undefined,
  event: E,
): Promise<unknown> {
  if (!hook) return undefined;
  const copied = eventCopy(name, event);
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
    console.error("tempo-auth: before hook failed", name, appErrorName(e));
    throw new HookStop({ ok: false, code: "hook_failed", status: ERRORS.hook_failed });
  }
}

/**
 * Runs an after hook on a copy of the event. The row is committed, so a
 * throw cannot undo it: one line with the hook name, the row id, and the
 * filtered error name, and the flow goes on (owner decision 1a, 2026-10-13).
 */
export async function runAfter<E>(
  name: HookName,
  hook: ((e: E) => unknown) | undefined,
  event: E,
  rowId: string,
): Promise<void> {
  if (!hook) return;
  const copied = eventCopy(name, event);
  if (!copied) return;
  try {
    await hook(copied.copy);
  } catch (e) {
    console.error("tempo-auth: after hook failed", name, rowId, appErrorName(e));
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
