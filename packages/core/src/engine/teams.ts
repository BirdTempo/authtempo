import type { Statements } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import { organizationChange } from "../observe/events.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { OrganizationRow, TeamMemberRow, TeamRow, UserRow } from "../schema.js";
import { findManyIn, findManyList, insertRows, listChunks } from "../storage/batch.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import { hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import {
  type OrganizationSummary,
  publicOrganization,
  standing,
  validOrganizationName,
  verified,
} from "./organizations.js";
import { effectiveIn, type Standing, touchCheck } from "./permissions.js";
import type { ResolvedOrganizations } from "./ranks.js";
import { ROUNDS } from "./rounds.js";
import { type PublicSession, publicSession, type ResolvedSession } from "./sessions.js";
import { holdUsers, usersStay } from "./user-hold.js";

/**
 * Teams (plan 12k, spec 29 item 7). A team is a named group of members of
 * one organization. It has no role: every right comes from the organization
 * role (owner decision 1 of 2026-10-14). Each operation answers `not_found`
 * while `organizations.teams` is off. Each team write needs a verified
 * address first (`verified`), as every other organization write does.
 */

/** One team of an organization. */
export interface TeamSummary {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One member of one team, with the person's address and name. */
export interface TeamMemberSummary {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  name: string | null;
  createdAt: Date;
}

interface Scope {
  o: ResolvedOrganizations;
  keepLastTeam: boolean;
}

function scope(config: ResolvedConfig): Scope | null {
  const o = config.organizations;
  if (!o || o.teams === null) return null;
  return { o, keepLastTeam: o.teams.keepLastTeam };
}

function publicTeam(row: TeamRow): TeamSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function teamMemberSummary(row: TeamMemberRow, user: UserRow): TeamMemberSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    email: user.email,
    name: user.name,
    createdAt: row.createdAt,
  };
}

/** The statement of a team member add (spec 29 item 7). An invite that names teams asks it too. */
export const TEAM_MEMBER_ADD: Statements = { member: ["update"] };

const byName = (a: TeamSummary, b: TeamSummary) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;

/**
 * Locks one team row in the caller's transaction, and answers false when no
 * team has the id in that organization. The update writes `organizationId`
 * with its own value, so no field changes. On Postgres the update holds the
 * row lock until the commit. A team delete, or a second write of the team
 * rows, waits for it and then counts the committed rows. Read committed
 * gives no other guard (ruling 26). D1 transactions are not isolated (spec
 * 8.6), so there the lock holds nothing.
 *
 * Why no `updatedAt` stamp, as `ownerWrite` writes (ruling 27): the second
 * racer then counts again and answers its true code (`team_member_limit`),
 * not `conflict`. The team's `updatedAt` also stays as it is at a member
 * add, so the team in each answer shows only the last rename.
 */
export async function lockTeam(
  tx: StorageAdapter,
  teamId: string,
  organizationId: string,
): Promise<boolean> {
  const n = await tx.update(
    "team",
    [
      { field: "id", op: "eq", value: teamId },
      { field: "organizationId", op: "eq", value: organizationId },
    ],
    { organizationId },
  );
  return n > 0;
}

/**
 * Locks the organization row in the caller's transaction, before a count of
 * its teams, and answers false when the organization is gone. The update
 * writes `createdAt` with its own value, so no field changes. On Postgres a
 * second team create or delete waits at this lock and then counts the
 * committed teams (ruling 26).
 *
 * Why no `updatedAt` stamp, as `ownerWrite` writes (ruling 27): the second
 * racer then answers its true code (`team_limit`, `last_team`), not
 * `conflict`. Also, a parallel owner write compares `updatedAt` with its own
 * read, so a stamp of a team write would give it a false `conflict`.
 *
 * The organization token create and a member removal with `revokeTokens`
 * take the same lock (ruling 32 of plan 12k), and so does the role create
 * before its count of `maxPerOrganization` (ruling 43).
 */
export async function lockOrganization(
  tx: StorageAdapter,
  organization: { id: string; createdAt: Date },
): Promise<boolean> {
  const n = await tx.update("organization", [{ field: "id", op: "eq", value: organization.id }], {
    createdAt: organization.createdAt,
  });
  return n > 0;
}

/**
 * The team and the caller's standing in its organization for `wanted`. A
 * missing team answers `not_found`; the standing answers as
 * `standing` does. A null set needs membership only. `standing` is the
 * caller's rank and set, for the touch rule.
 */
async function teamStanding(
  config: ResolvedConfig,
  user: UserRow,
  teamId: string,
  wanted: Statements | null,
) {
  const team = await config.storage.findOne("team", [{ field: "id", op: "eq", value: teamId }]);
  if (!team) return fail("not_found");
  const s = await standing(config, user, team.organizationId, wanted);
  if (!s.ok) return s;
  const caller: Standing = { rank: s.value.rank, granted: s.value.granted };
  return ok({ team, organization: publicOrganization(s.value.organization), standing: caller });
}

/**
 * Creates a team. Needs `team:create`. The name rule is the organization
 * name rule; names are not unique. `teamsPerOrganization` counts inside the
 * transaction, after the lock of the organization row and before the write.
 * The lock holds the count on Postgres. D1 transactions are not isolated
 * (spec 8.6), so on D1 two creates at one moment can both pass the count.
 */
export async function createTeam(
  config: ResolvedConfig,
  input: { user: UserRow; organizationId: string; name: string },
): Promise<Result<TeamSummary>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const s = await standing(config, input.user, input.organizationId, { team: ["create"] });
  if (!s.ok) return s;
  if (!validOrganizationName(input.name)) return fail("invalid_body");
  const now = config.clock.now();
  const row: TeamRow = {
    id: newId(now),
    organizationId: input.organizationId,
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };
  const team = publicTeam(row);
  const organization = publicOrganization(s.value.organization);
  const written = await hookGuard(() =>
    config.storage.transaction((tx) =>
      createTeamIn(config, tx, { organization: s.value.organization, row, by: input.user }),
    ),
  );
  if (!written.ok) return written;
  await runAfter(
    config.observe,
    "organization.afterCreateTeam",
    config.hooks.organization.afterCreateTeam,
    { organization, team, user: input.user },
    row.id,
  );
  config.observe.emit(organizationChange("afterCreateTeam", organization.id));
  return ok(team);
}

/**
 * The team create in the caller's transaction (ruling 25 N3 of plan 12d).
 * `createTeam` calls it after its standing check, and a SCIM group create
 * calls it with no user caller (`by` null). It takes the organization lock,
 * counts `teamsPerOrganization`, runs `beforeCreateTeam`, and writes the
 * row. The caller runs `afterCreateTeam` after its commit.
 *
 * With `by` null no team hook runs: the SCIM group write is the act, and a
 * cascade fires no team hook either. `hooks.scim.afterChange` reports it.
 */
export async function createTeamIn(
  config: ResolvedConfig,
  tx: StorageAdapter,
  input: { organization: OrganizationRow; row: TeamRow; by: UserRow | null },
): Promise<Result<true>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  // Also with no limit: a team of an organization that a delete removes must not stay.
  if (!(await lockOrganization(tx, input.organization))) return fail("not_found");
  const limit = sc.o.limits.teamsPerOrganization;
  if (limit !== null) {
    const held = await tx.findMany(
      "team",
      [{ field: "organizationId", op: "eq", value: input.row.organizationId }],
      { limit },
    );
    if (held.length >= limit) return fail("team_limit");
  }
  if (input.by)
    await runBefore(
      config.observe,
      "organization.beforeCreateTeam",
      config.hooks.organization.beforeCreateTeam,
      {
        organization: publicOrganization(input.organization),
        team: publicTeam(input.row),
        user: input.by,
      },
    );
  await tx.create("team", input.row);
  return ok(true);
}

/** Renames a team. Needs `team:update`. */
export async function updateTeam(
  config: ResolvedConfig,
  input: { user: UserRow; teamId: string; name: string },
): Promise<Result<TeamSummary>> {
  if (!scope(config)) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const t = await teamStanding(config, input.user, input.teamId, { team: ["update"] });
  if (!t.ok) return t;
  if (!validOrganizationName(input.name)) return fail("invalid_body");
  const { team, organization } = t.value;
  const now = config.clock.now();
  const written = await hookGuard(() =>
    config.storage.transaction(async (tx) => {
      // The hook comes before the write and takes no lock, so renameTeamIn holds no hook.
      await runBefore(
        config.observe,
        "organization.beforeUpdateTeam",
        config.hooks.organization.beforeUpdateTeam,
        {
          organization,
          team: publicTeam(team),
          patch: { name: input.name },
          user: input.user,
        },
      );
      return renameTeamIn(tx, { team, name: input.name, now });
    }),
  );
  if (!written.ok) return written;
  const stored = publicTeam({ ...team, name: input.name, updatedAt: now });
  await runAfter(
    config.observe,
    "organization.afterUpdateTeam",
    config.hooks.organization.afterUpdateTeam,
    { organization, team: stored, user: input.user },
    team.id,
  );
  config.observe.emit(organizationChange("afterUpdateTeam", organization.id));
  return ok(stored);
}

/**
 * The team rename in the caller's transaction (ruling 25 N3 of plan 12d).
 * `updateTeam` calls it after its checks and its `beforeUpdateTeam`, which
 * takes no lock. A SCIM group rename calls it with no user caller, so no
 * team hook runs, as `createTeamIn` says. The caller checks the name rule
 * first.
 */
export async function renameTeamIn(
  tx: StorageAdapter,
  input: { team: TeamRow; name: string; now: Date },
): Promise<Result<true>> {
  const n = await tx.update("team", [{ field: "id", op: "eq", value: input.team.id }], {
    name: input.name,
    updatedAt: input.now,
  });
  // Zero rows: a delete ran after the read. A zero-row update writes nothing.
  return n === 0 ? fail("not_found") : ok(true);
}

/**
 * Deletes a team. Needs `team:delete`. With `keepLastTeam`, the last team of
 * the organization answers `last_team`. The cascade fires no team hook. The
 * team rows go, and each session that acts in the team loses its active
 * team. Each pending invitation loses the team id.
 *
 * The transaction first takes the locks of the sessions that act in the
 * team, before the organization row and the team row, in the order of
 * user-hold.ts. A role loss and a member removal hold the sessions of a
 * member. Then they delete the member's team rows (rulings 48 and 49 of
 * plan 12k).
 *
 * A set of the active team can commit between the lock read and the team
 * lock. Its session then acts in the team with no lock of this delete. A
 * removal that holds that session waits on the team member rows of this
 * delete. So on Postgres the delete reads the ids first and locks them, and
 * reads the sessions of the team again after the team lock. A new session
 * there ends the round with no write, and the next round locks it. After
 * `ROUNDS` lost rounds the answer is `conflict` (ruling 49).
 *
 * Cost of one round on Postgres: the read of the session ids and their lock
 * read. With `keepLastTeam`, the lock of the organization row and the count
 * of at most two teams. Then the team lock and the second read of the
 * sessions. D1 and memory have no row lock: they skip all but the
 * `keepLastTeam` steps. Then the team delete, one read of every pending
 * invitation of the organization, one update per invitation that names the
 * team, and two more writes. The read also takes the expired pending rows. So
 * `pendingInvitationsPerOrganization`, which counts only the live rows, does
 * not bound it.
 */
export async function deleteTeam(
  config: ResolvedConfig,
  input: { user: UserRow; teamId: string },
): Promise<Result<{ ok: true }>> {
  if (!scope(config)) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const t = await teamStanding(config, input.user, input.teamId, { team: ["delete"] });
  if (!t.ok) return t;
  const { team, organization } = t.value;
  // ok(false): a set moved a session into the team after the lock read. The next round locks it.
  let deleted: Result<boolean> = ok(false);
  for (let round = 0; round < ROUNDS && deleted.ok && !deleted.value; round++)
    deleted = await hookGuard(() =>
      config.storage.transaction((tx) =>
        deleteTeamIn(config, tx, { organization, team, by: input.user }),
      ),
    );
  if (!deleted.ok) return deleted;
  // Each round lost to a set: the person tries again.
  if (!deleted.value) return fail("conflict");
  await runAfter(
    config.observe,
    "organization.afterDeleteTeam",
    config.hooks.organization.afterDeleteTeam,
    { organization, team: publicTeam(team), user: input.user },
    team.id,
  );
  config.observe.emit(organizationChange("afterDeleteTeam", organization.id));
  return ok({ ok: true });
}

/**
 * One round of the team delete in the caller's transaction (ruling 25 N3 of
 * plan 12d), with the locks and the cascade of `deleteTeam`. `deleteTeam`
 * runs the rounds, and so does a SCIM group delete, with `by` null. Then no
 * team hook runs, as `createTeamIn` says. The answer `ok(false)` means that
 * a set moved a session into the team after the lock read: the caller
 * writes nothing and runs the next round.
 *
 * `members` runs the caller's member writes in their step of the lock order
 * of user-hold.ts: after the invitations and before the team member rows.
 * A SCIM group delete changes the roles of the group's members there.
 *
 * With `sessionsLater`, the caller ends the sessions of the team with
 * `endDeletedTeamSessions` as its last write. A SCIM group delete does so
 * after its audit row, so no undo on D1 restores a session (ruling 87 of
 * plan 12d). The locks of these sessions stay at the start of the round.
 */
export async function deleteTeamIn(
  config: ResolvedConfig,
  tx: StorageAdapter,
  input: {
    organization: OrganizationSummary;
    team: TeamRow;
    by: UserRow | null;
    members?: (tx: StorageAdapter) => Promise<void>;
    sessionsLater?: boolean;
  },
): Promise<Result<boolean>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const { team, organization } = input;
  const byTeam: Where<"session">[] = [{ field: "activeTeamId", op: "eq", value: team.id }];
  // With row locks, the ids of the sessions that act in the team, and their locks.
  const locks = tx.lockInOrder !== undefined;
  const ids = locks ? (await tx.findMany("session", byTeam)).map((x) => x.id) : [];
  await tx.lockInOrder?.("session", [{ field: "id", op: "in", value: ids }]);
  if (sc.keepLastTeam) {
    if (!(await lockOrganization(tx, organization))) return fail("not_found");
    const held = await tx.findMany(
      "team",
      [{ field: "organizationId", op: "eq", value: team.organizationId }],
      { limit: 2 },
    );
    if (held.length <= 1) return fail("last_team");
  }
  if (locks) {
    // After the team lock, no set moves a session into the team. A session that a set
    // moved in after the read above has no lock here, so this round writes nothing.
    if (!(await lockTeam(tx, team.id, team.organizationId))) return fail("not_found");
    if ((await tx.findMany("session", byTeam)).some((x) => !ids.includes(x.id))) return ok(false);
  }
  if (input.by)
    await runBefore(
      config.observe,
      "organization.beforeDeleteTeam",
      config.hooks.organization.beforeDeleteTeam,
      {
        organization,
        team: publicTeam(team),
        user: input.by,
      },
    );
  if ((await tx.delete("team", [{ field: "id", op: "eq", value: team.id }])) === 0)
    return fail("not_found");
  // The invitations come after the team row and before the team member rows, in the order
  // of user-hold.ts (ruling 50 of plan 12k).
  const pending = await tx.findMany("invitation", [
    { field: "organizationId", op: "eq", value: team.organizationId },
    { field: "acceptedAt", op: "eq", value: null },
  ]);
  for (const invitation of pending) {
    const teamIds = invitation.teamIds ?? [];
    if (!teamIds.includes(team.id)) continue;
    const rest = teamIds.filter((id) => id !== team.id);
    await tx.update(
      "invitation",
      [
        { field: "id", op: "eq", value: invitation.id },
        { field: "acceptedAt", op: "eq", value: null },
      ],
      { teamIds: rest.length > 0 ? rest : null },
    );
  }
  await input.members?.(tx);
  await tx.delete("teamMember", [{ field: "teamId", op: "eq", value: team.id }]);
  if (!input.sessionsLater) await endDeletedTeamSessions(tx, team.id);
  return ok(true);
}

/**
 * Clears the active team `teamId` of each session that acts in it, after
 * the team delete of `deleteTeamIn`: one update. The caller holds the locks
 * of these sessions and of the team, so no set moves a session into the
 * team. The count of the changed sessions has no cap, and on D1 the undo of
 * this update restores about 1450 sessions per statement. So a SCIM group
 * delete runs it as its last write (ruling 87 of plan 12d). A failed update
 * changes no session, because D1 runs it as one batch.
 */
export async function endDeletedTeamSessions(tx: StorageAdapter, teamId: string): Promise<void> {
  await tx.update("session", [{ field: "activeTeamId", op: "eq", value: teamId }], {
    activeTeamId: null,
  });
}

/**
 * The teams of an organization, by name. Needs membership only.
 *
 * Cost: the standing reads and one read of the teams.
 * `teamsPerOrganization` bounds the rows when it is set.
 */
export async function listTeams(
  config: ResolvedConfig,
  input: { user: UserRow; organizationId: string },
): Promise<Result<TeamSummary[]>> {
  if (!scope(config)) return fail("not_found");
  const s = await standing(config, input.user, input.organizationId, null);
  if (!s.ok) return s;
  const rows = await config.storage.findMany(
    "team",
    [{ field: "organizationId", op: "eq", value: input.organizationId }],
    {
      sort: [
        { field: "name", dir: "asc" },
        { field: "id", dir: "asc" },
      ],
    },
  );
  return ok(rows.map(publicTeam));
}

/**
 * The members of a team, by address. Needs `member:read`.
 *
 * Cost: the team read, the standing reads, one read of the team rows, and
 * one user read for each 50 members (`findManyIn`). It never reads one user
 * per member. `membersPerTeam` bounds the rows when it is set.
 */
export async function listTeamMembers(
  config: ResolvedConfig,
  input: { user: UserRow; teamId: string },
): Promise<Result<TeamMemberSummary[]>> {
  if (!scope(config)) return fail("not_found");
  const t = await teamStanding(config, input.user, input.teamId, { member: ["read"] });
  if (!t.ok) return t;
  const rows = await config.storage.findMany("teamMember", [
    { field: "teamId", op: "eq", value: input.teamId },
  ]);
  const users = await findManyIn(
    config.storage,
    "user",
    "id",
    rows.map((r) => r.userId),
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  return ok(
    rows
      .flatMap((r) => {
        const u = byId.get(r.userId);
        return u ? [teamMemberSummary(r, u)] : [];
      })
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : a.id < b.id ? -1 : 1)),
  );
}

/**
 * Adds a member of the organization to a team. Needs `member:update`. A
 * person who is not a member of the organization answers `not_found`; a
 * second add answers `already_member`. The add of another person runs the
 * touch rule on that person (spec 29 item 5). `membersPerTeam` counts
 * inside the transaction, after the lock of the team row and before the
 * write. The hold of the added user comes before the team lock, in the lock
 * order of user-hold.ts (ruling 43).
 */
export async function addTeamMember(
  config: ResolvedConfig,
  input: { user: UserRow; teamId: string; userId: string },
): Promise<Result<TeamMemberSummary>> {
  if (!scope(config)) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const t = await teamStanding(config, input.user, input.teamId, TEAM_MEMBER_ADD);
  if (!t.ok) return t;
  const { team, organization } = t.value;
  const member = await config.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: team.organizationId },
    { field: "userId", op: "eq", value: input.userId },
  ]);
  if (!member) return fail("not_found");
  if (
    input.userId !== input.user.id &&
    !touchCheck(
      t.value.standing,
      await effectiveIn(config, config.storage, team.organizationId, member.role),
    )
  )
    return fail("forbidden_rank");
  const memberUser = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (!memberUser) return fail("not_found");
  const now = config.clock.now();
  let row: TeamMemberRow | undefined;
  try {
    const written = await hookGuard(() =>
      config.storage.transaction((tx) =>
        addTeamMembersIn(config, tx, {
          organization,
          team,
          userIds: [memberUser.id],
          hooks: { by: input.user, users: new Map([[memberUser.id, memberUser]]) },
          now,
          strict: true,
        }),
      ),
    );
    if (!written.ok) return written;
    row = written.value[0];
  } catch (err) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (err instanceof StorageError && err.code === "unique_violation")
      return fail("already_member");
    throw err;
  }
  if (!row) return fail("not_found");
  const summary = publicTeam(team);
  const added = teamMemberSummary(row, memberUser);
  await runAfter(
    config.observe,
    "organization.afterAddTeamMember",
    config.hooks.organization.afterAddTeamMember,
    { organization, team: summary, teamMember: added, memberUser, by: input.user },
    row.id,
  );
  config.observe.emit(organizationChange("afterAddTeamMember", organization.id));
  return ok(added);
}

/**
 * The team member add in the caller's transaction (ruling 25 N3 of plan
 * 12d), for one person or many. `addTeamMember` calls it after its standing
 * and touch checks, and a SCIM group write calls it with `by` null. The
 * steps keep the order of `addTeamMember`: the hold of the added users,
 * the team lock, the member rows again, the team rows that exist, the
 * count of `membersPerTeam`, the before hooks, the rows, and the read
 * after the inserts. The hold comes before the team lock, in the lock order
 * of user-hold.ts (ruling 43 of plan 12k).
 *
 * With `strict` (one person, `addTeamMember`), a person with no member row
 * answers `not_found` and a person in the team answers `already_member`.
 * Without it (a SCIM group write), each such person is skipped. `hooks`
 * holds the user caller and the user row of each person; with `hooks` null
 * no team hook runs, as `createTeamIn` says. With `teamLocked`, the caller
 * took `lockTeam` earlier in the transaction, and the add does not take it
 * again. The answer is the new rows. The caller runs `afterAddTeamMember`
 * after its commit.
 *
 * Cost: one statement of the hold per list of `listChunks` (up to 1000
 * persons) on Postgres and none on D1, the team lock, one read per list
 * of the member rows and of the team rows, the count, one create per chunk
 * of `rowChunks` new rows (rulings 57 and 84 of plan 12d), and one read
 * per list of the users. A SCIM write reads no user with the hold of `holdUser`: on D1 that
 * hold costs three statements per person.
 */
export async function addTeamMembersIn(
  config: ResolvedConfig,
  tx: StorageAdapter,
  input: {
    organization: OrganizationSummary;
    team: TeamRow;
    userIds: readonly string[];
    hooks: { by: UserRow; users: ReadonlyMap<string, UserRow> } | null;
    now: Date;
    strict: boolean;
    teamLocked?: boolean;
  },
): Promise<Result<TeamMemberRow[]>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const { team, now } = input;
  const ids = [...new Set(input.userIds)];
  if (ids.length === 0) return ok([]);
  // The added users first, in the lock order of user-hold.ts, for the reason of the member
  // add (plan 12a Task 11). The hold writes no new value, so a refusal below changes nothing.
  await holdUsers(tx, ids);
  // Zero rows: a delete ran after the read. A zero-row update writes nothing.
  if (!input.teamLocked && !(await lockTeam(tx, team.id, team.organizationId)))
    return fail("not_found");
  // The member rows again, after the hold: a member removal holds the same user (ruling 43).
  // So the removal commits before this read, or it waits for this commit.
  const members = new Set(
    (
      await findManyList(tx, "member", "userId", ids, [
        { field: "organizationId", op: "eq", value: team.organizationId },
      ])
    ).map((m) => m.userId),
  );
  if (input.strict && ids.some((id) => !members.has(id))) return fail("not_found");
  // A no-op add runs no hook. The unique key stays the guard for a race.
  const inTeam = new Set(
    (
      await findManyList(tx, "teamMember", "userId", ids, [
        { field: "teamId", op: "eq", value: team.id },
      ])
    ).map((r) => r.userId),
  );
  if (input.strict && ids.some((id) => inTeam.has(id))) return fail("already_member");
  const adding = ids.filter((id) => members.has(id) && !inTeam.has(id));
  if (adding.length === 0) return ok([]);
  const limit = sc.o.limits.membersPerTeam;
  if (limit !== null) {
    const held = await tx.findMany("teamMember", [{ field: "teamId", op: "eq", value: team.id }], {
      limit,
    });
    if (held.length + adding.length > limit) return fail("team_member_limit");
  }
  const rows = adding.map(
    (userId): TeamMemberRow => ({
      id: newId(now),
      teamId: team.id,
      organizationId: team.organizationId,
      userId,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const hooks = input.hooks;
  if (hooks)
    for (const userId of adding) {
      const memberUser = hooks.users.get(userId);
      // The user caller reads each person before the transaction.
      if (!memberUser) return fail("not_found");
      await runBefore(
        config.observe,
        "organization.beforeAddTeamMember",
        config.hooks.organization.beforeAddTeamMember,
        {
          organization: input.organization,
          team: publicTeam(team),
          teamMember: { teamId: team.id, userId },
          memberUser,
          by: hooks.by,
        },
      );
    }
  // One statement per chunk of rows (rulings 57 and 84 of plan 12d).
  await insertRows(tx, "teamMember", rows);
  await usersStay(
    tx,
    rows.map((r) => r.userId),
  );
  return ok(rows);
}

/**
 * Removes a person from a team. The removal of another person needs
 * `member:delete` and passes the touch rule on that person (spec 29 item 5).
 * A member leaves a team with membership only. The person's sessions that
 * act in the team lose their active team. The transaction takes the locks
 * of the person's sessions first, then the lock of the team row, as
 * `setActiveTeam` does (user-hold.ts). So a set in flight commits first,
 * and this removal then clears its active team. A role loss and a member
 * removal hold the same sessions before they delete the person's team rows
 * (rulings 48 and 49 of plan 12k). All of the person's sessions lock, so no
 * session that a set moves into the team after the lock read stays outside
 * the lock.
 */
export async function removeTeamMember(
  config: ResolvedConfig,
  input: { user: UserRow; teamId: string; userId: string },
): Promise<Result<{ ok: true }>> {
  if (!scope(config)) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const self = input.userId === input.user.id;
  const t = await teamStanding(
    config,
    input.user,
    input.teamId,
    self ? null : { member: ["delete"] },
  );
  if (!t.ok) return t;
  const { team, organization } = t.value;
  const row = await config.storage.findOne("teamMember", [
    { field: "teamId", op: "eq", value: team.id },
    { field: "userId", op: "eq", value: input.userId },
  ]);
  if (!row) return fail("not_found");
  if (!self) {
    const member = await config.storage.findOne("member", [
      { field: "organizationId", op: "eq", value: team.organizationId },
      { field: "userId", op: "eq", value: input.userId },
    ]);
    if (!member) return fail("not_found");
    if (
      !touchCheck(
        t.value.standing,
        await effectiveIn(config, config.storage, team.organizationId, member.role),
      )
    )
      return fail("forbidden_rank");
  }
  const memberUser = self
    ? input.user
    : await config.storage.findOne("user", [{ field: "id", op: "eq", value: input.userId }]);
  if (!memberUser) return fail("not_found");
  const event: TeamMemberEvent = {
    organization,
    team: publicTeam(team),
    teamMember: teamMemberSummary(row, memberUser),
    memberUser,
    by: input.user,
  };
  const removed = await hookGuard(() =>
    config.storage.transaction((tx) =>
      removeTeamMembersIn(config, tx, {
        team,
        userIds: [input.userId],
        events: [event],
        strict: true,
      }),
    ),
  );
  if (!removed.ok) return removed;
  await runAfter(
    config.observe,
    "organization.afterRemoveTeamMember",
    config.hooks.organization.afterRemoveTeamMember,
    event,
    row.id,
  );
  config.observe.emit(organizationChange("afterRemoveTeamMember", event.organization.id));
  return ok({ ok: true });
}

/** The event of a team member hook of a user caller. */
export interface TeamMemberEvent {
  organization: OrganizationSummary;
  team: TeamSummary;
  teamMember: TeamMemberSummary;
  memberUser: UserRow;
  by: UserRow;
}

/**
 * The team member removal in the caller's transaction (ruling 25 N3 of
 * plan 12d), for one person or many. `removeTeamMember` calls it after its
 * checks, and a SCIM group write calls it with no events. The steps keep
 * the order of `removeTeamMember`: the locks of the persons' sessions, the
 * team lock, the before hook of each event, the team rows, and the active
 * team of the sessions. With `strict`, a person with no team row answers
 * `not_found`, and no row changes. An empty `events` runs no team hook, as
 * `createTeamIn` says. `teamLocked` is the flag of `addTeamMembersIn`. With
 * `sessionsLater`, the caller ends the sessions with `endTeamSessions` as
 * its last write: a SCIM group write does so after its last read that can
 * conflict (ruling 86 of plan 12d). The caller runs `afterRemoveTeamMember`
 * after its commit.
 *
 * Cost: per list of `listChunks` (up to 1000 persons, ruling 84 of plan
 * 12d), one session lock statement on Postgres (none on D1), one delete,
 * and one session update. Then the team lock once.
 */
export async function removeTeamMembersIn(
  config: ResolvedConfig,
  tx: StorageAdapter,
  input: {
    team: TeamRow;
    userIds: readonly string[];
    events: readonly TeamMemberEvent[];
    strict: boolean;
    teamLocked?: boolean;
    sessionsLater?: boolean;
  },
): Promise<Result<true>> {
  const { team } = input;
  const ids = [...new Set(input.userIds)].sort();
  if (ids.length === 0) return ok(true);
  // One statement per list of up to 1000 persons (ruling 84 of plan 12d).
  const chunks = listChunks(ids);
  // The session locks come before the team row, in the order of user-hold.ts (ruling 48).
  for (const chunk of chunks)
    await tx.lockInOrder?.("session", [{ field: "userId", op: "in", value: chunk }]);
  // The lock of setActiveTeam: a set that holds it commits first, and the session update
  // below sees its active team (ruling 43). Zero rows: a delete ran after the read.
  if (!input.teamLocked && !(await lockTeam(tx, team.id, team.organizationId)))
    return fail("not_found");
  for (const event of input.events)
    await runBefore(
      config.observe,
      "organization.beforeRemoveTeamMember",
      config.hooks.organization.beforeRemoveTeamMember,
      event,
    );
  let removed = 0;
  for (const chunk of chunks)
    removed += await tx.delete("teamMember", [
      { field: "teamId", op: "eq", value: team.id },
      { field: "userId", op: "in", value: chunk },
    ]);
  // Fewer rows: a removal ran after the read. Each team row that a delete wrote goes back.
  if (input.strict && removed < ids.length) stopWith("not_found");
  if (!input.sessionsLater) await endTeamSessions(tx, team.id, ids);
  return ok(true);
}

/**
 * Clears the active team `teamId` of the sessions of `userIds`: one update
 * per list of `listChunks`. An active team needs its membership, as
 * setActiveTeam checks. The caller holds the locks of these sessions.
 *
 * The count of the changed sessions has no cap: a person can hold many
 * sessions. On D1 the undo of this update restores about 1450 sessions per
 * statement. So a SCIM group write runs it as its last write, after its
 * last read that can conflict and after its audit row. Then no undo of the
 * write restores the sessions (ruling 86 of plan 12d). A failed update
 * changes no session, because D1 runs it as one batch.
 */
export async function endTeamSessions(
  tx: StorageAdapter,
  teamId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const chunk of listChunks([...new Set(userIds)].sort()))
    await tx.update(
      "session",
      [
        { field: "userId", op: "in", value: chunk },
        { field: "activeTeamId", op: "eq", value: teamId },
      ],
      { activeTeamId: null },
    );
}

/**
 * Sets the team the session acts in. The team must be a team of the
 * session's active organization, and the caller a member of the team, else
 * `forbidden_rank`. `null` clears it.
 *
 * The checks and the write run in one transaction after the lock of the
 * session and then of the team row (ruling 26, and ruling 48 of plan 12k
 * for the order of user-hold.ts). A team delete waits for the commit, then
 * clears the active team. The session update names the active
 * organization: a member removal clears it in its own transaction, so
 * after a removal zero rows match. On Postgres a removal that starts after
 * the session lock waits for this commit, and then clears both.
 */
export async function setActiveTeam(
  config: ResolvedConfig,
  input: { session: ResolvedSession; teamId: string | null },
): Promise<Result<PublicSession>> {
  if (!scope(config)) return fail("not_found");
  const { session, user } = input.session;
  const now = config.clock.now();
  const teamId = input.teamId;
  if (teamId === null) {
    await config.storage.update("session", [{ field: "id", op: "eq", value: session.id }], {
      activeTeamId: null,
      updatedAt: now,
    });
  } else {
    const organizationId = session.activeOrganizationId;
    if (organizationId === null) return fail("forbidden_rank");
    const set = await config.storage.transaction(async (tx): Promise<boolean> => {
      // The session lock comes before the team row, in the order of user-hold.ts (ruling 48).
      await tx.lockInOrder?.("session", [{ field: "id", op: "eq", value: session.id }]);
      // Zero rows: no team of the active organization has the id.
      if (!(await lockTeam(tx, teamId, organizationId))) return false;
      const row = await tx.findOne("teamMember", [
        { field: "teamId", op: "eq", value: teamId },
        { field: "userId", op: "eq", value: user.id },
      ]);
      if (!row) return false;
      const n = await tx.update(
        "session",
        [
          { field: "id", op: "eq", value: session.id },
          { field: "activeOrganizationId", op: "eq", value: organizationId },
        ],
        { activeTeamId: teamId, updatedAt: now },
      );
      return n > 0;
    });
    if (!set) return fail("forbidden_rank");
  }
  return ok(
    publicSession({
      ...input.session,
      session: { ...session, activeTeamId: teamId, updatedAt: now },
    }),
  );
}

/**
 * The teams of the caller in every organization, by name.
 *
 * Cost: one read of the caller's team rows, and one team read for each 50
 * of them (`findManyIn`).
 */
export async function listUserTeams(
  config: ResolvedConfig,
  input: { user: UserRow },
): Promise<Result<TeamSummary[]>> {
  if (!scope(config)) return fail("not_found");
  const rows = await config.storage.findMany("teamMember", [
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  const teams = await findManyIn(
    config.storage,
    "team",
    "id",
    rows.map((r) => r.teamId),
  );
  return ok(teams.map(publicTeam).sort(byName));
}

/**
 * Deletes the person's team rows of one organization and clears their active
 * team, in the caller's transaction. A member removal, a leave, and the
 * revoke of the platform role call it. It fires no team hook: a cascade
 * fires none. It runs with teams off too, so the rows of an earlier config
 * go as well. The caller holds the person's sessions before its member
 * delete, in the order of user-hold.ts (ruling 49 of plan 12k). So the
 * session write here takes no new lock.
 */
export async function dropMemberTeams(
  tx: StorageAdapter,
  organizationId: string,
  userId: string,
): Promise<void> {
  await tx.delete("teamMember", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);
  // An active team is a team of the active organization (setActiveTeam).
  await tx.update(
    "session",
    [
      { field: "userId", op: "eq", value: userId },
      { field: "activeOrganizationId", op: "eq", value: organizationId },
    ],
    { activeTeamId: null },
  );
}

/**
 * The default team of an organization create (`defaultTeam`), in the
 * create's transaction: one team named as the organization, with the creator
 * in it. It fires no team hook: it is part of the create.
 */
export async function createDefaultTeam(
  tx: StorageAdapter,
  organizationId: string,
  name: string,
  userId: string,
  now: Date,
): Promise<void> {
  const team: TeamRow = { id: newId(now), organizationId, name, createdAt: now, updatedAt: now };
  await tx.create("team", team);
  await tx.create("teamMember", {
    id: newId(now),
    teamId: team.id,
    organizationId,
    userId,
    createdAt: now,
    updatedAt: now,
  });
}
