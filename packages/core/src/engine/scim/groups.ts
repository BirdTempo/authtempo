/**
 * The SCIM Groups of an organization (plan 12d Task 11, RFC 7643 section
 * 4.2, RFC 7644 section 3). A directory creates, reads, changes, and
 * deletes the groups of its staff here. A group is one `scimGroup` row,
 * and one `scimGroupMember` row per member. A member is a SCIM User of the
 * same organization: a nested group is out of 12d.
 *
 * A group feeds the organization by `scim.groups`. With `roles` or `both`,
 * the role map of the organization gives each member of a mapped group a
 * role (Behavior 2). With `teams` or `both`, each group has one team of
 * plan 12k, and a member change is a team member change (Behavior 3).
 *
 * Each write is one transaction with its audit row, as the last statement
 * (`writeAuditIn`). The member and team writes go through the tx-level
 * functions of 12k, in the lock order of user-hold.ts. The after hooks run
 * after the commit.
 */

import type { ResolvedConfig } from "../../config.js";
import { newId } from "../../primitives/ids.js";
import type {
  MemberRow,
  OperatorAuditRow,
  OrganizationRow,
  ScimGroupRow,
  ScimUserRow,
  TeamRow,
  UserRow,
} from "../../schema.js";
import { findManyIn, IN_CHUNK } from "../../storage/batch.js";
import type { Meter } from "../../storage/meter.js";
import { type StorageAdapter, StorageError } from "../../storage/port.js";
import { hookGuard, runAfter, runBefore, stopWith } from "../hooks.js";
import { writeAuditIn } from "../operator/audit.js";
import { writesPlatformRole } from "../operator/guards.js";
import { OPERATOR_CALL_BUDGET } from "../operator/sessions.js";
import { type MemberSummary, publicOrganization, validOrganizationName } from "../organizations.js";
import { isOwner, rankOf } from "../ranks.js";
import { ROUNDS } from "../rounds.js";
import { later } from "../second-factor.js";
import { afterAudit } from "../sso/domains.js";
import {
  addTeamMembersIn,
  createTeamIn,
  deleteTeamIn,
  lockTeam,
  removeTeamMembersIn,
  renameTeamIn,
} from "../teams.js";
import { holdUsers } from "../user-hold.js";
import { scimBase } from "./discovery.js";
import { asciiLower, parseScimFilter, scimKey } from "./filter.js";
import { GROUP_MEMBERS_MAX, GROUP_ROLE_USERS_MAX, PATCH_MEMBERS_MAX } from "./limits.js";
import { GROUP_RULES, NS_SCIM_GROUP, type PatchOp, parsePatch } from "./patch.js";
import { mappedGroups, type RoleMapFacts, roleFromGroups, roleMapFacts } from "./roles.js";
import { type AttributeNotation, pageParams, selectAttributes } from "./select.js";
import {
  columnText,
  draftOf,
  etagOf,
  failAnswer,
  isObject,
  isRefused,
  matches,
  meterFor,
  type Refused,
  refused,
  type ScimResult,
  type ScimUserCaller,
  scimFail,
  VersionLost,
} from "./users.js";

export { roleFromGroups } from "./roles.js";
// One source for the URNs: patch.ts (ruling 23 of plan 12d). The role map lives in roles.ts.
// The caps live in limits.ts, so the discovery documents read them with no import cycle.
export { GROUP_MEMBERS_MAX, GROUP_ROLE_USERS_MAX, NS_SCIM_GROUP, PATCH_MEMBERS_MAX };

/** The longest `displayName`, and the longest `externalId`. */
const DISPLAY_NAME_MAX = 255;
const ID_TEXT_MAX = 256;

/** The caller of a group write: a token of the SCIM routes, or the app through `api.scim.groups`. */
type Caller = ScimUserCaller;

/** A Group of a request, after its checks. `members` holds scimUser ids. */
export interface GroupDoc {
  displayName: string;
  externalId: string | null;
  members: ReadonlySet<string>;
}

// --- The resource.

/** The location of a Group: `<baseURL><basePath>/scim/v2/Groups/<id>`. */
function locationOf(config: ResolvedConfig, id: string): string {
  return `${scimBase(config)}/Groups/${id}`;
}

/**
 * The SCIM Group of a row (RFC 7643 section 4.2). `members` holds each
 * member's id, `$ref`, and `type`. It holds no `display`: that would read
 * one User per member. `meta` holds the version as a weak ETag.
 */
export function toScimGroup(
  config: ResolvedConfig,
  row: ScimGroupRow,
  members: readonly string[],
): Record<string, unknown> {
  return {
    schemas: [NS_SCIM_GROUP],
    id: row.id,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    displayName: row.displayName,
    ...(members.length === 0
      ? {}
      : {
          members: [...members].sort().map((value) => ({
            value,
            $ref: `${scimBase(config)}/Users/${value}`,
            type: "User",
          })),
        }),
    meta: {
      resourceType: "Group",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: locationOf(config, row.id),
      version: etagOf(row.version),
    },
  };
}

const GROUP_KEY = asciiLower(NS_SCIM_GROUP);
/**
 * Entra ID names this URN beside the core Group URN in each group create
 * ("Develop and plan provisioning for a SCIM endpoint", Microsoft Learn, read
 * 2026-10-22). No Schema document defines it, and the body holds no key of
 * it. So core accepts it beside the core URN and reads nothing of it (plan
 * 12d Task 12 P1). Any other URN still answers `invalidSyntax`.
 */
const ENTRA_GROUP_KEY = asciiLower(
  "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group",
);

/** The top-level names of a Group for `attributes`, with the sub-attributes of `members`. */
const KNOWN: ReadonlySet<string> = new Set([
  "id",
  "schemas",
  "meta",
  ...[...GROUP_RULES.values()].map((r) => asciiLower(r.name)),
]);
const NOTATION: AttributeNotation = {
  core: GROUP_KEY,
  subs: new Map([["members", new Set(GROUP_RULES.get("members")?.subs?.keys() ?? [])]]),
};

/** True when the answer holds `members`: `excludedAttributes=members` keeps a large group cheap (Behavior 5). */
function wantsMembers(url: URL | null): boolean {
  if (url === null) return true;
  const probe = selectAttributes(
    { id: "", schemas: [], meta: {}, members: [] },
    url,
    KNOWN,
    NOTATION,
  );
  return probe.ok && Object.hasOwn(probe.value, "members");
}

/** The refusal of `selectAttributes`, read once for the answer. */
async function selectRefusal(url: URL): Promise<ScimResult | null> {
  const probe = selectAttributes({}, url, KNOWN, NOTATION);
  if (probe.ok) return null;
  return { status: probe.response.status, body: await probe.response.json() };
}

/** The answer of one Group with its ETag and its attribute selection. */
function oneAnswer(
  config: ResolvedConfig,
  row: ScimGroupRow,
  members: readonly string[],
  status: number,
  url: URL | null,
): ScimResult {
  const resource = toScimGroup(config, row, members);
  const headers: Record<string, string> = { etag: etagOf(row.version) };
  if (status === 201) headers.location = locationOf(config, row.id);
  if (url === null) return { status, body: resource, headers };
  const picked = selectAttributes(resource, url, KNOWN, NOTATION);
  if (!picked.ok) return { status: 400, body: null, headers: {} };
  return { status, body: picked.value, headers };
}

const NOT_FOUND = (): ScimResult => scimFail(404, "no Group of this organization has the id");

/**
 * The member values of `members` (Behavior 1): a list of objects with the
 * id of a User in `value`. A single object counts as a list of one. A
 * `type` other than `User` is a nested group, which 12d does not serve.
 * `display` and `$ref` are ignored.
 */
function memberValues(value: unknown): string[] | Refused {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > GROUP_MEMBERS_MAX)
    return refused(`a group holds at most ${GROUP_MEMBERS_MAX} members`, "invalidValue");
  const out: string[] = [];
  for (const item of list) {
    if (!isObject(item)) return refused("each member is an object with a value", "invalidValue");
    let id: unknown;
    for (const [key, part] of Object.entries(item)) {
      const lower = asciiLower(key);
      if (lower === "value") id = part;
      else if (lower === "type" && (typeof part !== "string" || asciiLower(part) !== "user"))
        return refused("a member must be a User; a nested group is not supported", "invalidValue");
    }
    const text = columnText(id, "members.value", ID_TEXT_MAX);
    if (typeof text !== "string") return text;
    out.push(text);
  }
  return out;
}

/**
 * Reads a Group of a POST or a PUT body (Behavior 1). `schemas` holds the
 * core Group URN, and the Entra URN of `ENTRA_GROUP_KEY` at most.
 * `displayName` is required. `id` and `meta` are ignored (RFC 7643 section
 * 2.2), and so is an attribute that the schema does not know, as for a User
 * (ruling 45 of plan 12d).
 */
export function readGroup(body: unknown): { ok: true; doc: GroupDoc } | Refused {
  if (!isObject(body)) return refused("the body is not a Group resource", "invalidSyntax");
  const schemas = body.schemas;
  if (
    !Array.isArray(schemas) ||
    !schemas.every((s) => typeof s === "string") ||
    !schemas.some((s) => asciiLower(s) === GROUP_KEY) ||
    !schemas.every((s) => asciiLower(s) === GROUP_KEY || asciiLower(s) === ENTRA_GROUP_KEY)
  )
    return refused(
      "schemas must hold the core Group URN, and the Entra ID group URN at most",
      "invalidSyntax",
    );
  let displayName: unknown;
  let externalId: string | null = null;
  let members: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const rule = GROUP_RULES.get(asciiLower(key));
    if (rule === undefined || rule.name === "id" || rule.name === "meta") continue;
    if (rule.name === "displayName") displayName = value;
    else if (rule.name === "externalId" && value !== null) {
      const text = columnText(value, "externalId", ID_TEXT_MAX);
      if (typeof text !== "string") return text;
      externalId = text;
    } else if (rule.name === "members") {
      const list = memberValues(value);
      if (isRefused(list)) return list;
      members = list;
    }
  }
  if (displayName === undefined || displayName === null)
    return refused("displayName is required", "invalidValue");
  const name = columnText(displayName, "displayName", DISPLAY_NAME_MAX);
  if (typeof name !== "string") return name;
  return { ok: true, doc: { displayName: name, externalId, members: new Set(members) } };
}

/**
 * Applies the operations of one PATCH to a copy of the group (Behavior 4,
 * RFC 7644 section 3.5.2). `add` and `remove` change `members`; a `remove`
 * takes the path `members[value eq "<id>"]` or a value list, and with no
 * value it removes every member. `replace` sets `displayName`,
 * `externalId`, or the whole member list. The caller writes the result
 * once, so one failed operation writes nothing.
 */
export function applyGroupPatch(
  doc: GroupDoc,
  ops: readonly PatchOp[],
): { ok: true; doc: GroupDoc } | Refused {
  let displayName = doc.displayName;
  let externalId = doc.externalId;
  const members = new Set(doc.members);
  for (const op of ops) {
    const path = op.path;
    if (path === null) return refused("each operation needs a path", "invalidPath");
    if (path.attr === "displayName") {
      // RFC 7644 section 3.5.2.2: a required attribute that becomes unassigned answers
      // mutability. A remove, or a replace with null, makes it unassigned (ruling 67).
      if (op.op === "remove" || (op.op === "replace" && op.value === null))
        return refused("displayName is required", "mutability");
      const text = columnText(op.value, "displayName", DISPLAY_NAME_MAX);
      if (typeof text !== "string") return text;
      displayName = text;
    } else if (path.attr === "externalId") {
      if (op.op === "remove" || op.value === null) externalId = null;
      else {
        const text = columnText(op.value, "externalId", ID_TEXT_MAX);
        if (typeof text !== "string") return text;
        externalId = text;
      }
    } else if (path.attr === "members") {
      if (path.sub !== null)
        return refused("a path to a sub-attribute of members is not supported", "invalidPath");
      if (path.filter !== null) {
        // Plan 12d Task 9a i3: the filter path serves a remove only.
        if (op.op !== "remove")
          return refused("add and replace take the path members and a list", "invalidPath");
        // A remove of a non-member changes nothing (ruling 57 item 5 of plan 12d): an IdP
        // sends a removal again after a time-out, and an error marks its push failed.
        members.delete(path.filter.value);
        continue;
      }
      const list = memberValues(op.value);
      if (isRefused(list)) return list;
      if (op.op === "replace") members.clear();
      if (op.op === "remove") {
        if (op.value === null) members.clear();
        for (const id of list) members.delete(id);
      } else for (const id of list) members.add(id);
    } else return refused("the path is not one that this server reads", "invalidPath");
  }
  if (members.size > GROUP_MEMBERS_MAX)
    return refused(`a group holds at most ${GROUP_MEMBERS_MAX} members`, "invalidValue");
  return { ok: true, doc: { displayName, externalId, members } };
}

// --- The write (Behaviors 1 to 4 and 6).

/** One write of a Group: a create, an update of a row and its members, or a delete. */
type Write =
  | { kind: "create"; next: GroupDoc }
  | { kind: "update"; row: ScimGroupRow; before: ReadonlySet<string>; next: GroupDoc }
  | { kind: "delete"; row: ScimGroupRow; before: ReadonlySet<string> };

/** The role recompute of one write does not fit the call budget of one request. */
class TooLarge extends Error {
  constructor() {
    super("authtempo: the role change of the SCIM group write does not fit the budget");
    this.name = "TooLarge";
  }
}

/** A team delete lost its round to a set of the active team: the write runs again. */
class LostRound extends Error {
  constructor() {
    super("authtempo: the team delete of the SCIM group lost its round");
    this.name = "LostRound";
  }
}

/** One role change of a member, for the role hooks. */
interface RoleChange {
  member: MemberRow;
  role: string;
  user: UserRow | null;
}

/** The facts of one role recompute, read before the transaction. */
interface Recompute {
  facts: RoleMapFacts;
  rows: readonly ScimUserRow[];
}

/** The role changes of one write, grouped by the role pair, before the updates. */
interface RolePlan {
  changes: RoleChange[];
  pairs: RoleChange[][];
}

/**
 * Computes the role of each member of `r` again, in the write's transaction
 * (Behavior 2), before the write of the scimGroupMember rows. The member
 * rows are locked, by `id` on Postgres, so a parallel write of another
 * group for the same person waits and then reads this commit. The
 * scimGroupMember rows of the group are the ones the write leaves: `after`,
 * the new member set. A member with the owner rank keeps the role, so the
 * last-owner rule of spec 8.6 holds. So does a member with the platform
 * role: its loss is the role loss of the member routes (question Q2 of Task
 * 10). A user with no member row, such as an inactive one, gets no row
 * back. The meter holds the whole request: when the updates and `tail` do
 * not fit the budget, the write stops here. Only the group row and the team
 * writes come before, so the undo of the refusal on D1 stays small (ruling
 * 59 of plan 12d).
 */
async function planRoles(
  config: ResolvedConfig,
  tx: StorageAdapter,
  organization: OrganizationRow,
  r: Recompute,
  group: { id: string; after: ReadonlySet<string> },
  meter: Meter,
  tail: number,
): Promise<RolePlan> {
  const o = config.organizations;
  const none: RolePlan = { changes: [], pairs: [] };
  if (!o) return none;
  const byScimUser = new Map(r.rows.map((x) => [x.userId, x.id]));
  const userIds = [...byScimUser.keys()];
  if (userIds.length === 0) return none;
  const org = { field: "organizationId" as const, op: "eq" as const, value: organization.id };
  const members = await findManyIn(tx, "member", "userId", userIds, [org]);
  const groups = await mappedGroups(tx, organization.id, r.facts);
  const names = new Map(groups.map((g) => [g.id, g.displayName]));
  const read =
    groups.length === 0
      ? []
      : await findManyIn(
          tx,
          "scimGroupMember",
          "scimUserId",
          r.rows.map((x) => x.id),
        );
  meter.step(3 * Math.ceil(userIds.length / IN_CHUNK) + 1);
  // The rows as the write leaves them: the rows of this group are its new member set.
  const of = [
    ...read.filter((m) => m.groupId !== group.id),
    ...r.rows
      .filter((x) => group.after.has(x.id))
      .map((x) => ({ groupId: group.id, scimUserId: x.id })),
  ];
  const changes: RoleChange[] = [];
  for (const member of members) {
    if (isOwner(o, rankOf(o.ranks, member.role))) continue;
    if (writesPlatformRole(config, organization, member.role)) continue;
    const scimUserId = byScimUser.get(member.userId);
    const groupNames = of.flatMap((m) => {
      const name = m.scimUserId === scimUserId ? names.get(m.groupId) : undefined;
      return name === undefined ? [] : [name];
    });
    const role = roleFromGroups(config, r.facts.map, groupNames, r.facts.ranks);
    if (role === member.role) continue;
    if (r.facts.gone.has(role)) stopWith("role_not_found");
    changes.push({ member, role, user: null });
  }
  if (changes.length === 0) return none;
  // One update per role change and chunk of 50 members: two statements each on D1.
  const byPair = new Map<string, RoleChange[]>();
  for (const c of changes) {
    const key = `${c.member.role}\u0000${c.role}`;
    byPair.set(key, [...(byPair.get(key) ?? []), c]);
  }
  const pairs = [...byPair.values()];
  const updates = pairs.reduce((n, l) => n + Math.ceil(l.length / IN_CHUNK), 0);
  const hooks = config.hooks.organization;
  const hooked =
    hooks.beforeUpdateMemberRole !== undefined || hooks.afterUpdateMemberRole !== undefined;
  const reads = hooked ? Math.ceil(changes.length / IN_CHUNK) : 0;
  if (meter.used + reads + 2 * updates + tail > OPERATOR_CALL_BUDGET) throw new TooLarge();
  if (hooked) {
    const users = new Map(
      (
        await findManyIn(
          tx,
          "user",
          "id",
          changes.map((c) => c.member.userId),
        )
      ).map((u) => [u.id, u]),
    );
    meter.step(reads);
    for (const c of changes) {
      c.user = users.get(c.member.userId) ?? null;
      if (c.user)
        await runBefore("organization.beforeUpdateMemberRole", hooks.beforeUpdateMemberRole, {
          organization: publicOrganization(organization),
          member: memberSummary(c.member, c.user),
          role: c.role,
          memberUser: c.user,
          by: null,
        });
    }
  }
  return { changes, pairs };
}

/**
 * The role updates of a plan, per role change, in chunks of 50 members,
 * each with the role it read. Fewer rows: a role changed after the read,
 * and the write stops.
 */
async function applyRoles(
  tx: StorageAdapter,
  plan: RolePlan,
  meter: Meter,
  now: Date,
): Promise<RoleChange[]> {
  let updates = 0;
  for (const list of plan.pairs)
    for (let i = 0; i < list.length; i += IN_CHUNK) {
      const chunk = list.slice(i, i + IN_CHUNK);
      const first = chunk[0];
      if (!first) continue;
      const n = await tx.update(
        "member",
        [
          { field: "id", op: "in", value: chunk.map((c) => c.member.id) },
          { field: "role", op: "eq", value: first.member.role },
        ],
        { role: first.role, updatedAt: now },
      );
      updates++;
      // Fewer rows: a role changed after the read. The throw undoes each write.
      if (n < chunk.length) stopWith("conflict");
    }
  meter.step(2 * updates);
  return plan.changes;
}

/** The summary of a member row for a role hook. */
function memberSummary(member: MemberRow, user: UserRow): MemberSummary {
  return {
    id: member.id,
    userId: user.id,
    role: member.role,
    email: user.email,
    name: user.name,
    createdAt: member.createdAt,
  };
}

/** The 409 of a unique key of a group write. */
function uniqueAnswer(err: unknown): ScimResult | null {
  if (!(err instanceof StorageError) || err.code !== "unique_violation") return null;
  if (err.model === "scimGroup")
    return scimFail(409, "another Group of this organization has the displayName", "uniqueness");
  return scimFail(409, "the Group changed during the write; send it again");
}

/** The names of the attributes that a write changes, never their values. */
function changedNames(write: Write, added: number, removed: number): string[] {
  if (write.kind === "delete") return [];
  const before = write.kind === "update" ? write.row : null;
  const out: string[] = [];
  if (before?.displayName !== write.next.displayName) out.push("displayName");
  if ((before?.externalId ?? null) !== write.next.externalId) out.push("externalId");
  if (added + removed > 0) out.push("members");
  return out;
}

/** `hooks.scim.afterChange` once per write, after the commit (Behavior 6). */
async function afterChange(
  config: ResolvedConfig,
  organizationId: string,
  action: "create" | "update" | "delete",
  id: string,
): Promise<void> {
  await runAfter(
    "scim.afterChange",
    config.hooks.scim.afterChange,
    { organizationId, resource: "Group", action, id },
    id,
  );
}

/** The member rows of one group write, and the role recompute with them. */
interface MemberStep {
  groupId: string;
  organization: OrganizationRow;
  /** The member set that the write leaves: empty for a delete. */
  after: ReadonlySet<string>;
  added: readonly string[];
  removed: readonly string[];
  recompute: Recompute | null;
  now: Date;
}

/**
 * The member step of a group write, in the step of the member rows of
 * user-hold.ts: the locks of the member rows of the role recompute, the
 * role plan with its budget check, the scimGroupMember rows, the read after
 * the inserts, and the role updates. The scimGroupMember rows come after
 * the member rows, in each flow that writes both (ruling 59 M1 of plan
 * 12d). A delete removes every scimGroupMember row of the group. The answer
 * is the role changes, for the after hooks.
 */
async function writeMembers(
  config: ResolvedConfig,
  t: StorageAdapter,
  all: boolean,
  m: MemberStep,
  meter: Meter,
  tail: number,
): Promise<RoleChange[]> {
  const org = { field: "organizationId" as const, op: "eq" as const, value: m.organization.id };
  const r = m.recompute;
  if (r !== null) {
    const ids = [...new Set(r.rows.map((x) => x.userId))].sort();
    for (let i = 0; i < ids.length; i += IN_CHUNK)
      await t.lockInOrder?.("member", [
        org,
        { field: "userId", op: "in", value: ids.slice(i, i + IN_CHUNK) },
      ]);
  }
  const plan =
    r === null
      ? null
      : await planRoles(
          config,
          t,
          m.organization,
          r,
          { id: m.groupId, after: m.after },
          meter,
          tail,
        );
  if (all) await t.delete("scimGroupMember", [{ field: "groupId", op: "eq", value: m.groupId }]);
  else {
    for (let i = 0; i < m.removed.length; i += IN_CHUNK)
      await t.delete("scimGroupMember", [
        { field: "groupId", op: "eq", value: m.groupId },
        { field: "scimUserId", op: "in", value: m.removed.slice(i, i + IN_CHUNK) },
      ]);
    for (const scimUserId of m.added)
      await t.create("scimGroupMember", {
        id: newId(m.now),
        groupId: m.groupId,
        scimUserId,
        createdAt: m.now,
        updatedAt: m.now,
      });
    // The read after the inserts: a SCIM delete or an account delete of a User that
    // ended before the hold took its row. Then the write stops, and no row stays.
    if (
      m.added.length > 0 &&
      (await findManyIn(t, "scimUser", "id", m.added, [org])).length < m.added.length
    )
      stopWith("conflict");
  }
  return plan === null ? [] : applyRoles(t, plan, meter, m.now);
}

/**
 * The calls of the transaction that the meter does not see, at the worst
 * (Behavior 2). Where the storage has row locks (`locks`): one hold per 50
 * users of `holds`. The scimGroupMember rows: `rows` calls (`rowCalls`).
 * Per 50 persons who leave the team: the session lock
 * on Postgres or the undo read on D1, the team member delete, and the
 * session update. Per 50 persons who join it: the hold where the storage
 * has row locks, the reads of the member rows and the team rows, and the
 * read after the inserts; then the count and one create per person. A team
 * delete: the team member delete and the session update with its undo read
 * on D1. Then the audit row.
 */
function tailOf(
  adds: number,
  removes: number,
  teamDelete: boolean,
  locks: boolean,
  holds: number,
  rows: number,
): number {
  const chunks = (n: number) => Math.ceil(n / IN_CHUNK);
  return (
    (locks ? chunks(holds) : 0) +
    rows +
    (removes > 0 ? 3 * chunks(removes) : 0) +
    (adds > 0 ? (locks ? 4 : 3) * chunks(adds) + 1 + adds : 0) +
    (teamDelete ? 3 : 0) +
    1
  );
}

/**
 * The calls of the scimGroupMember rows of a write: one delete for a group
 * delete. Else one delete per 50 removed members, one create per added
 * member, and one read after the creates per 50 of them. A D1 run of
 * ruling 59 of plan 12d found these calls outside the meter: a write of 51
 * queries passed the budget check.
 */
function rowCalls(kind: Write["kind"], added: number, removed: number): number {
  const chunks = (n: number) => Math.ceil(n / IN_CHUNK);
  if (kind === "delete") return 1;
  return chunks(removed) + added + chunks(added);
}

/**
 * One write of a Group (Behaviors 1 to 4 and 6). The reads come first: the
 * Users of the added members, the Users of the members whose role or team
 * changes, the organization, the team, and the role map. Then one
 * transaction in the lock order of user-hold.ts. The group row comes first:
 * only the group writes take it, so it orders two writes of one group, and
 * no flow of user-hold.ts takes it. Then the users that join the team, the
 * sessions of the persons who leave it, the organization row and the team
 * row, the member rows of the role recompute, and the team member rows.
 * The audit row is the last statement.
 */
async function writeGroup(
  config: ResolvedConfig,
  caller: Caller,
  write: Write,
  meter: Meter,
  url: URL | null,
): Promise<ScimResult> {
  const o = config.organizations;
  const sc = config.scim;
  if (!o || !sc) return NOT_FOUND();
  const storage = config.storage;
  const orgId = caller.organizationId;
  const org = { field: "organizationId" as const, op: "eq" as const, value: orgId };
  const before: ReadonlySet<string> = write.kind === "create" ? new Set() : write.before;
  const after: ReadonlySet<string> = write.kind === "delete" ? new Set() : write.next.members;
  const added = [...after].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !after.has(id)).sort();
  if (write.kind !== "delete" && added.length + removed.length > PATCH_MEMBERS_MAX)
    return scimFail(
      400,
      `one request changes at most ${PATCH_MEMBERS_MAX} members of a group`,
      "invalidValue",
    );
  if (after.size > GROUP_MEMBERS_MAX)
    return scimFail(400, `a group holds at most ${GROUP_MEMBERS_MAX} members`, "invalidValue");
  const oldName = write.kind === "create" ? null : write.row.displayName;
  const newName = write.kind === "delete" ? null : write.next.displayName;
  const teams = sc.groups !== "roles";
  const renamed = oldName !== null && newName !== null && oldName !== newName;
  if (teams && newName !== null && oldName !== newName && !validOrganizationName(newName))
    return scimFail(400, "displayName must fit the name rule of a team", "invalidValue");
  const facts = await roleMapFacts(config, storage, orgId);
  meter.step(facts === null ? 1 : 3);
  const mapped = (name: string | null) => name !== null && facts?.byKey.has(scimKey(name)) === true;
  const keyMoved = oldName !== null && newName !== null && scimKey(oldName) !== scimKey(newName);
  let again: string[] = [];
  if (write.kind === "create") again = mapped(newName) ? added : [];
  else if (write.kind === "delete") again = mapped(oldName) ? [...before] : [];
  else if (keyMoved && (mapped(oldName) || mapped(newName))) again = [...after, ...removed];
  else if (mapped(newName)) again = [...added, ...removed];
  if (again.length > GROUP_ROLE_USERS_MAX)
    return scimFail(
      400,
      `the change computes the roles of more than ${GROUP_ROLE_USERS_MAX} members; take the group out of the role map, or change fewer members first`,
      "invalidValue",
    );
  // One read of the Users that the write names. A delete leaves the team with the team
  // delete, so it reads no User of a removed member.
  const wanted = new Set([...added, ...(write.kind === "delete" ? [] : removed), ...again]);
  const users = new Map(
    (await findManyIn(storage, "scimUser", "id", [...wanted], [org])).map((x) => [x.id, x]),
  );
  meter.step(Math.ceil(wanted.size / IN_CHUNK));
  // Behavior 1: each added member is a User of this organization. A group id, an id of
  // another organization, or an unknown id reads as no row.
  if (added.some((id) => !users.has(id)))
    return scimFail(
      400,
      "each member value must be the id of a User of this organization",
      "invalidValue",
    );
  const organization = await storage.findOne("organization", [
    { field: "id", op: "eq", value: orgId },
  ]);
  const teamId = write.kind === "create" ? null : write.row.teamId;
  const team =
    teams && teamId !== null
      ? await storage.findOne("team", [{ field: "id", op: "eq", value: teamId }, org])
      : null;
  meter.step(2);
  if (!organization) return NOT_FOUND();
  const now = config.clock.now();
  const groupId = write.kind === "create" ? newId(now) : write.row.id;
  const newTeam: TeamRow | null =
    teams && write.kind === "create" && newName !== null
      ? { id: newId(now), organizationId: orgId, name: newName, createdAt: now, updatedAt: now }
      : null;
  const rowsOf = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const x = users.get(id);
      return x ? [x] : [];
    });
  // Behavior 2: a user with active false holds no member row, so it joins no team either.
  const joins = rowsOf(added)
    .filter((x) => x.active)
    .map((x) => x.userId);
  const leaves = rowsOf(removed).map((x) => x.userId);
  const teamOf = newTeam ?? team;
  const r: Recompute | null =
    facts !== null && again.length > 0 ? { facts, rows: rowsOf(again) } : null;
  // The users whose role or team the write changes: the added and removed members, and
  // each member of the role recompute. The write holds them, as an account delete holds
  // its user. A reactivate holds its user before it reads the groups, so the two run one
  // at a time (ruling 59 M2 of plan 12d). A delete reads no User of a removed member.
  const holds = [...new Set(rowsOf([...added, ...removed, ...again]).map((x) => x.userId))];
  const tail = tailOf(
    teamOf ? joins.length : 0,
    teamOf && write.kind !== "delete" ? leaves.length : 0,
    write.kind === "delete" && team !== null,
    storage.lockInOrder !== undefined,
    holds.length,
    rowCalls(write.kind, added.length, removed.length),
  );
  const changedList = changedNames(write, added.length, removed.length);
  const action =
    write.kind === "create"
      ? "scim_group_create"
      : write.kind === "delete"
        ? "scim_group_delete"
        : "scim_group_update";
  const data = {
    organizationId: orgId,
    scimGroupId: groupId,
    changed: changedList,
    membersAdded: added.length,
    membersRemoved: removed.length,
  };
  const summary = publicOrganization(organization);
  let changes: RoleChange[] = [];
  const run = () =>
    hookGuard(() =>
      storage.transaction(async (tx) => {
        changes = [];
        const versioned =
          write.kind === "create"
            ? []
            : [
                { field: "id" as const, op: "eq" as const, value: write.row.id },
                { field: "version" as const, op: "eq" as const, value: write.row.version },
              ];
        if (write.kind === "create" && newName !== null)
          await tx.create("scimGroup", {
            id: groupId,
            organizationId: orgId,
            displayName: newName,
            displayNameKey: scimKey(newName),
            externalId: write.next.externalId,
            teamId: newTeam?.id ?? null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
        else if (write.kind === "update") {
          const n = await tx.update("scimGroup", versioned, {
            displayName: write.next.displayName,
            displayNameKey: scimKey(write.next.displayName),
            externalId: write.next.externalId,
            version: write.row.version + 1,
            updatedAt: later(now, write.row.updatedAt),
          });
          if (n === 0) throw new VersionLost();
        } else if (write.kind === "delete") {
          if ((await tx.delete("scimGroup", versioned)) === 0) throw new VersionLost();
        }
        // The users first, after the group row, in the lock order of user-hold.ts.
        if (holds.length > 0) await holdUsers(tx, holds);
        // The member rows, the group rows, and the roles: in the step of the member rows.
        const step: MemberStep = {
          groupId,
          organization,
          after,
          added,
          removed,
          recompute: r,
          now,
        };
        const members = async (t: StorageAdapter) => {
          changes = await writeMembers(config, t, write.kind === "delete", step, meter, tail);
        };
        if (write.kind === "delete") {
          if (team) {
            const gone = await deleteTeamIn(config, tx, {
              organization: summary,
              team,
              by: null,
              members,
            });
            if (!gone.ok && gone.code !== "not_found") stopWith(gone.code);
            if (gone.ok && !gone.value) throw new LostRound();
            // A team that an owner deleted first: the group goes on with no team.
            if (!gone.ok) await members(tx);
          } else await members(tx);
        } else {
          // The sessions of those who leave the team.
          if (team && leaves.length > 0)
            for (let i = 0; i < leaves.length; i += IN_CHUNK)
              await tx.lockInOrder?.("session", [
                { field: "userId", op: "in", value: [...leaves].sort().slice(i, i + IN_CHUNK) },
              ]);
          let live: TeamRow | null = null;
          if (newTeam) {
            const made = await createTeamIn(config, tx, {
              organization,
              row: newTeam,
              by: null,
            });
            if (!made.ok) stopWith(made.code);
            live = newTeam;
          } else if (team && renamed && newName !== null) {
            const named = await renameTeamIn(tx, { team, name: newName, now });
            live = named.ok ? team : null;
          } else if (team && (joins.length > 0 || leaves.length > 0))
            live = (await lockTeam(tx, team.id, team.organizationId)) ? team : null;
          changes = await writeMembers(config, tx, false, step, meter, tail);
          if (live && leaves.length > 0) {
            const left = await removeTeamMembersIn(config, tx, {
              team: live,
              userIds: leaves,
              events: [],
              strict: false,
              teamLocked: true,
            });
            if (!left.ok) stopWith(left.code);
          }
          if (live && joins.length > 0) {
            const joined = await addTeamMembersIn(config, tx, {
              organization: summary,
              team: live,
              userIds: joins,
              hooks: null,
              now,
              strict: false,
              teamLocked: true,
            });
            if (!joined.ok) stopWith(joined.code);
          }
        }
        return {
          ok: true as const,
          value: await writeAuditIn(tx, draftOf(caller, action, null, data), now),
        };
      }),
    );
  let written: Awaited<ReturnType<typeof run>> | null = null;
  try {
    for (let round = 0; round < ROUNDS && written === null; round++)
      try {
        written = await run();
      } catch (err) {
        if (!(err instanceof LostRound)) throw err;
      }
  } catch (err) {
    if (err instanceof TooLarge)
      return scimFail(
        400,
        "the role change of this request does not fit one request; change fewer members in each request",
        "invalidValue",
      );
    const answer = uniqueAnswer(err);
    if (answer) return answer;
    throw err;
  }
  // Each round lost to a set of the active team: the directory sends the delete again.
  if (written === null) return scimFail(409, "the team of the Group changed; send it again");
  if (!written.ok) return failAnswer(written);
  const audit: OperatorAuditRow = written.value;
  for (const c of changes)
    if (c.user)
      await runAfter(
        "organization.afterUpdateMemberRole",
        config.hooks.organization.afterUpdateMemberRole,
        {
          organization: summary,
          member: memberSummary({ ...c.member, role: c.role }, c.user),
          previousRole: c.member.role,
          memberUser: c.user,
          by: null,
        },
        c.member.id,
      );
  await afterChange(
    config,
    orgId,
    write.kind === "create" ? "create" : write.kind === "delete" ? "delete" : "update",
    groupId,
  );
  await afterAudit(config, audit);
  if (write.kind === "delete") return { status: 204, body: null };
  const stored: ScimGroupRow =
    write.kind === "create"
      ? {
          id: groupId,
          organizationId: orgId,
          displayName: write.next.displayName,
          displayNameKey: scimKey(write.next.displayName),
          externalId: write.next.externalId,
          teamId: newTeam?.id ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        }
      : {
          ...write.row,
          displayName: write.next.displayName,
          displayNameKey: scimKey(write.next.displayName),
          externalId: write.next.externalId,
          version: write.row.version + 1,
          updatedAt: later(now, write.row.updatedAt),
        };
  if (write.kind === "create") return oneAnswer(config, stored, [...after], 201, null);
  // Behavior 4: a PATCH answers 204 with no body unless the request asks for attributes.
  if (url !== null && !url.searchParams.has("attributes")) return { status: 204, body: null };
  return oneAnswer(config, stored, [...after], 200, url);
}

/** The row of the caller's organization, or null. An id of another organization reads as unknown. */
async function rowOf(
  storage: StorageAdapter,
  caller: Caller,
  id: string,
): Promise<ScimGroupRow | null> {
  return storage.findOne("scimGroup", [
    { field: "id", op: "eq", value: id },
    { field: "organizationId", op: "eq", value: caller.organizationId },
  ]);
}

/** The member ids of a group: one read, also for a group of 10 000 members. */
async function membersOf(storage: StorageAdapter, groupId: string): Promise<Set<string>> {
  const rows = await storage.findMany("scimGroupMember", [
    { field: "groupId", op: "eq", value: groupId },
  ]);
  return new Set(rows.map((m) => m.scimUserId));
}

/**
 * One write of a Group that exists (Behaviors 1, 4, and 6). The write
 * spends the version it read: a lost race answers 412 when the request sent
 * `If-Match`, else the engine reads again and tries once more, then answers
 * 409, as for a User.
 */
async function changeGroup(
  config: ResolvedConfig,
  caller: Caller,
  id: string,
  ifMatch: string | null,
  next: (row: ScimGroupRow, before: ReadonlySet<string>) => Write | ScimResult,
  url: URL | null,
): Promise<ScimResult> {
  const meter = await meterFor(config, caller);
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await rowOf(config.storage, caller, id);
    meter.step(1);
    if (!row) return NOT_FOUND();
    if (!matches(ifMatch, row.version))
      return scimFail(412, "the version of the Group is not the one of If-Match");
    const before = await membersOf(config.storage, row.id);
    meter.step(1);
    const write = next(row, before);
    if (!("kind" in write)) return write;
    try {
      return await writeGroup(config, caller, write, meter, url);
    } catch (err) {
      if (!(err instanceof VersionLost)) throw err;
      if (ifMatch !== null)
        return scimFail(412, "the version of the Group is not the one of If-Match");
    }
  }
  return scimFail(409, "the Group changed twice during the write; send it again");
}

/** Creates a Group (Behaviors 1 to 3), `POST /Groups`. */
export async function scimCreateGroup(
  config: ResolvedConfig,
  caller: Caller,
  body: unknown,
): Promise<ScimResult> {
  const read = readGroup(body);
  if (!read.ok) return read.answer;
  const meter = await meterFor(config, caller);
  return writeGroup(config, caller, { kind: "create", next: read.doc }, meter, null);
}

/** Reads one Group of the caller's organization (Behavior 5), `GET /Groups/:id`. */
export async function scimGetGroup(
  config: ResolvedConfig,
  caller: Caller,
  id: string,
  url: URL,
): Promise<ScimResult> {
  const bad = await selectRefusal(url);
  if (bad) return bad;
  const row = await rowOf(config.storage, caller, id);
  if (!row) return NOT_FOUND();
  const members = wantsMembers(url) ? [...(await membersOf(config.storage, row.id))] : [];
  return oneAnswer(config, row, members, 200, url);
}

/**
 * The member rows of a list page, at most GROUP_MEMBERS_MAX of them, so a
 * page reads no more rows than one group (ruling 59 of plan 12d). The rows
 * come by group id, as the page does, one read per 50 groups. The page ends
 * before the first group that does not fit whole. The first group always
 * fits: it holds at most GROUP_MEMBERS_MAX members.
 */
async function pageMembers(
  storage: StorageAdapter,
  slice: readonly ScimGroupRow[],
): Promise<{ groups: ScimGroupRow[]; rows: { groupId: string; scimUserId: string }[] }> {
  const rows: { groupId: string; scimUserId: string }[] = [];
  let cut: string | null = null;
  for (let i = 0; i < slice.length && cut === null; i += IN_CHUNK) {
    const read = await storage.findMany(
      "scimGroupMember",
      [{ field: "groupId", op: "in", value: slice.slice(i, i + IN_CHUNK).map((g) => g.id) }],
      {
        sort: [
          { field: "groupId", dir: "asc" },
          { field: "id", dir: "asc" },
        ],
        limit: GROUP_MEMBERS_MAX + 1 - rows.length,
      },
    );
    rows.push(...read);
    if (rows.length > GROUP_MEMBERS_MAX) cut = rows.at(-1)?.groupId ?? null;
  }
  if (cut === null) return { groups: [...slice], rows };
  const end = slice.findIndex((g) => g.id === cut);
  return { groups: slice.slice(0, end), rows: rows.filter((m) => m.groupId !== cut) };
}

/**
 * Lists the Groups of the caller's organization (Behavior 5), by `id`,
 * with the filter of Task 9 Behavior 6 and its paging. The one member
 * check of Entra ID (`id eq "<g>" and members[value eq "<u>"]`) answers the
 * group when the user is a member, else no group. `excludedAttributes=members`
 * reads no member row. A page with members holds at most GROUP_MEMBERS_MAX
 * member rows: it ends early, and `itemsPerPage` says how many groups it
 * holds (RFC 7644 section 3.4.2.4 lets a page hold fewer than `count`).
 */
export async function scimListGroups(
  config: ResolvedConfig,
  caller: Caller,
  url: URL,
): Promise<ScimResult> {
  const page = pageParams(url);
  if (!page.ok) return { status: page.response.status, body: await page.response.json() };
  const bad = await selectRefusal(url);
  if (bad) return bad;
  const text = url.searchParams.get("filter");
  const filter = text === null ? null : parseScimFilter(text, "Group");
  if (text !== null && filter === null)
    return scimFail(400, "the filter is not one that this server reads", "invalidFilter");
  const storage = config.storage;
  const org = { field: "organizationId" as const, op: "eq" as const, value: caller.organizationId };
  const sort = { sort: { field: "id" as const, dir: "asc" as const } };
  let rows: ScimGroupRow[];
  if (filter === null) rows = await storage.findMany("scimGroup", [org], sort);
  else {
    const where =
      filter.attr === "displayName"
        ? { field: "displayNameKey" as const, op: "eq" as const, value: scimKey(filter.value) }
        : filter.attr === "externalId"
          ? { field: "externalId" as const, op: "eq" as const, value: filter.value }
          : { field: "id" as const, op: "eq" as const, value: filter.value };
    rows = await storage.findMany("scimGroup", [org, where], sort);
    if ("member" in filter && rows.length > 0) {
      const hit = await storage.findOne("scimGroupMember", [
        { field: "groupId", op: "eq", value: filter.value },
        { field: "scimUserId", op: "eq", value: filter.member },
      ]);
      if (!hit) rows = [];
    }
  }
  let slice = rows.slice(page.startIndex - 1, page.startIndex - 1 + page.count);
  const members = new Map<string, string[]>();
  if (wantsMembers(url)) {
    const read = await pageMembers(storage, slice);
    slice = read.groups;
    for (const m of read.rows)
      members.set(m.groupId, [...(members.get(m.groupId) ?? []), m.scimUserId]);
  }
  const resources: Record<string, unknown>[] = [];
  for (const row of slice) {
    const picked = selectAttributes(
      toScimGroup(config, row, members.get(row.id) ?? []),
      url,
      KNOWN,
      NOTATION,
    );
    if (picked.ok) resources.push(picked.value);
  }
  return {
    status: 200,
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: rows.length,
      startIndex: page.startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    },
  };
}

/** Replaces a Group (Behaviors 1 to 3), `PUT /Groups/:id`. */
export async function scimReplaceGroup(
  config: ResolvedConfig,
  caller: Caller,
  id: string,
  body: unknown,
  ifMatch: string | null,
): Promise<ScimResult> {
  const read = readGroup(body);
  if (!read.ok) return read.answer;
  const doc = read.doc;
  return changeGroup(
    config,
    caller,
    id,
    ifMatch,
    (row, before) => ({ kind: "update", row, before, next: doc }),
    null,
  );
}

/**
 * Patches a Group (Behavior 4), `PATCH /Groups/:id`. Every operation
 * applies to a copy, and the write runs once, so the operations are atomic.
 * The answer is 204 with no body unless `url` asks for `attributes` (RFC
 * 7644 section 3.5.2: the server MAY answer 204). An id of the no-path form
 * that differs from the target answers `mutability` (ruling 24 of plan 12d).
 */
export async function scimPatchGroup(
  config: ResolvedConfig,
  caller: Caller,
  id: string,
  body: unknown,
  ifMatch: string | null,
  url: URL = NO_QUERY,
): Promise<ScimResult> {
  const parsed = parsePatch(body, "Group");
  if (!parsed.ok) return scimFail(parsed.status, parsed.detail, parsed.scimType);
  if (parsed.id !== null && parsed.id !== id) return scimFail(400, "id is read-only", "mutability");
  const bad = await selectRefusal(url);
  if (bad) return bad;
  return changeGroup(
    config,
    caller,
    id,
    ifMatch,
    (row, before) => {
      const applied = applyGroupPatch(
        { displayName: row.displayName, externalId: row.externalId, members: before },
        parsed.ops,
      );
      if (!applied.ok) return applied.answer;
      const next = applied.doc;
      // A PATCH that changes nothing writes nothing: no new version, no audit row, and no
      // hook. So a remove of a non-member, which an IdP sends again after a time-out,
      // answers as a removal does (ruling 57 item 5 of plan 12d).
      if (
        next.displayName === row.displayName &&
        next.externalId === row.externalId &&
        next.members.size === before.size &&
        [...next.members].every((m) => before.has(m))
      )
        return url.searchParams.has("attributes")
          ? oneAnswer(config, row, [...before], 200, url)
          : { status: 204, body: null };
      return { kind: "update", row, before, next };
    },
    url,
  );
}

/** The URL of a call with no query. */
const NO_QUERY = new URL("https://scim.invalid/");

/**
 * Deletes a Group (Behaviors 2, 3, and 6), `DELETE /Groups/:id`: the group
 * row, its member rows, its team, and the role of each member of a mapped
 * group, in one transaction. The Users stay.
 */
export async function scimDeleteGroup(
  config: ResolvedConfig,
  caller: Caller,
  id: string,
  ifMatch: string | null,
): Promise<ScimResult> {
  return changeGroup(
    config,
    caller,
    id,
    ifMatch,
    (row, before) => ({ kind: "delete", row, before }),
    null,
  );
}
