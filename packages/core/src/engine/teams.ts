import type { Statements } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { TeamMemberRow, TeamRow, UserRow } from "../schema.js";
import { findManyIn } from "../storage/batch.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import { hookGuard, runAfter, runBefore } from "./hooks.js";
import { publicOrganization, standing, validOrganizationName, verified } from "./organizations.js";
import { effectiveIn, type Standing, touchCheck } from "./permissions.js";
import type { ResolvedOrganizations } from "./ranks.js";
import { ROUNDS } from "./rounds.js";
import { type PublicSession, publicSession, type ResolvedSession } from "./sessions.js";
import { holdUser, userStays } from "./user-hold.js";

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
  const hooks = config.hooks.organization;
  const limit = sc.o.limits.teamsPerOrganization;
  const written = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<true>> => {
      // Also with no limit: a team of an organization that a delete removes must not stay.
      if (!(await lockOrganization(tx, s.value.organization))) return fail("not_found");
      if (limit !== null) {
        const held = await tx.findMany(
          "team",
          [{ field: "organizationId", op: "eq", value: input.organizationId }],
          { limit },
        );
        if (held.length >= limit) return fail("team_limit");
      }
      await runBefore("organization.beforeCreateTeam", hooks.beforeCreateTeam, {
        organization,
        team,
        user: input.user,
      });
      await tx.create("team", row);
      return ok(true);
    }),
  );
  if (!written.ok) return written;
  await runAfter(
    "organization.afterCreateTeam",
    hooks.afterCreateTeam,
    { organization, team, user: input.user },
    row.id,
  );
  return ok(team);
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
  const hooks = config.hooks.organization;
  const written = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<true>> => {
      await runBefore("organization.beforeUpdateTeam", hooks.beforeUpdateTeam, {
        organization,
        team: publicTeam(team),
        patch: { name: input.name },
        user: input.user,
      });
      const n = await tx.update("team", [{ field: "id", op: "eq", value: team.id }], {
        name: input.name,
        updatedAt: now,
      });
      // Zero rows: a delete ran after the read. A zero-row update writes nothing.
      return n === 0 ? fail("not_found") : ok(true);
    }),
  );
  if (!written.ok) return written;
  const stored = publicTeam({ ...team, name: input.name, updatedAt: now });
  await runAfter(
    "organization.afterUpdateTeam",
    hooks.afterUpdateTeam,
    { organization, team: stored, user: input.user },
    team.id,
  );
  return ok(stored);
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
 * `keepLastTeam` steps. Then three writes, one read of every pending
 * invitation of the organization, and one update per invitation that names
 * the team. The read also takes the expired pending rows. So
 * `pendingInvitationsPerOrganization`, which counts only the live rows, does
 * not bound it.
 */
export async function deleteTeam(
  config: ResolvedConfig,
  input: { user: UserRow; teamId: string },
): Promise<Result<{ ok: true }>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const t = await teamStanding(config, input.user, input.teamId, { team: ["delete"] });
  if (!t.ok) return t;
  const { team, organization } = t.value;
  const summary = publicTeam(team);
  const hooks = config.hooks.organization;
  const byTeam: Where<"session">[] = [{ field: "activeTeamId", op: "eq", value: team.id }];
  // ok(false): a set moved a session into the team after the lock read. The next round locks it.
  let deleted: Result<boolean> = ok(false);
  for (let round = 0; round < ROUNDS && deleted.ok && !deleted.value; round++)
    deleted = await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<boolean>> => {
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
          if ((await tx.findMany("session", byTeam)).some((x) => !ids.includes(x.id)))
            return ok(false);
        }
        await runBefore("organization.beforeDeleteTeam", hooks.beforeDeleteTeam, {
          organization,
          team: summary,
          user: input.user,
        });
        if ((await tx.delete("team", [{ field: "id", op: "eq", value: team.id }])) === 0)
          return fail("not_found");
        await tx.delete("teamMember", [{ field: "teamId", op: "eq", value: team.id }]);
        await tx.update("session", byTeam, { activeTeamId: null });
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
        return ok(true);
      }),
    );
  if (!deleted.ok) return deleted;
  // Each round lost to a set: the person tries again.
  if (!deleted.value) return fail("conflict");
  await runAfter(
    "organization.afterDeleteTeam",
    hooks.afterDeleteTeam,
    { organization, team: summary, user: input.user },
    team.id,
  );
  return ok({ ok: true });
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
  const sc = scope(config);
  if (!sc) return fail("not_found");
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
  const row: TeamMemberRow = {
    id: newId(now),
    teamId: team.id,
    organizationId: team.organizationId,
    userId: input.userId,
    createdAt: now,
    updatedAt: now,
  };
  const hooks = config.hooks.organization;
  const summary = publicTeam(team);
  const limit = sc.o.limits.membersPerTeam;
  try {
    const written = await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<true>> => {
        // The added user first, in the lock order of user-hold.ts, for the reason of the member
        // add (plan 12a Task 11). The hold writes no new value, so a refusal below changes nothing.
        await holdUser(tx, input.userId);
        // Zero rows: a delete ran after the read. A zero-row update writes nothing.
        if (!(await lockTeam(tx, team.id, team.organizationId))) return fail("not_found");
        // The member row again, after the hold: a member removal holds the same user (ruling 43).
        // So the removal commits before this read, or it waits for this commit.
        if (
          !(await tx.findOne("member", [
            { field: "organizationId", op: "eq", value: team.organizationId },
            { field: "userId", op: "eq", value: input.userId },
          ]))
        )
          return fail("not_found");
        // A no-op add runs no hook. The unique key stays the guard for a race.
        if (
          await tx.findOne("teamMember", [
            { field: "teamId", op: "eq", value: team.id },
            { field: "userId", op: "eq", value: input.userId },
          ])
        )
          return fail("already_member");
        if (limit !== null) {
          const held = await tx.findMany(
            "teamMember",
            [{ field: "teamId", op: "eq", value: team.id }],
            { limit },
          );
          if (held.length >= limit) return fail("team_member_limit");
        }
        await runBefore("organization.beforeAddTeamMember", hooks.beforeAddTeamMember, {
          organization,
          team: summary,
          teamMember: { teamId: team.id, userId: input.userId },
          memberUser,
          by: input.user,
        });
        await tx.create("teamMember", row);
        await userStays(tx, input.userId);
        return ok(true);
      }),
    );
    if (!written.ok) return written;
  } catch (err) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (err instanceof StorageError && err.code === "unique_violation")
      return fail("already_member");
    throw err;
  }
  const added = teamMemberSummary(row, memberUser);
  await runAfter(
    "organization.afterAddTeamMember",
    hooks.afterAddTeamMember,
    { organization, team: summary, teamMember: added, memberUser, by: input.user },
    row.id,
  );
  return ok(added);
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
  const hooks = config.hooks.organization;
  const event = {
    organization,
    team: publicTeam(team),
    teamMember: teamMemberSummary(row, memberUser),
    memberUser,
    by: input.user,
  };
  const removed = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<true>> => {
      // The session locks come before the team row, in the order of user-hold.ts (ruling 48).
      await tx.lockInOrder?.("session", [{ field: "userId", op: "eq", value: input.userId }]);
      // The lock of setActiveTeam: a set that holds it commits first, and the session update
      // below sees its active team (ruling 43). Zero rows: a delete ran after the read.
      if (!(await lockTeam(tx, team.id, team.organizationId))) return fail("not_found");
      await runBefore("organization.beforeRemoveTeamMember", hooks.beforeRemoveTeamMember, event);
      if ((await tx.delete("teamMember", [{ field: "id", op: "eq", value: row.id }])) === 0)
        return fail("not_found");
      // An active team needs its membership, as setActiveTeam checks.
      await tx.update(
        "session",
        [
          { field: "userId", op: "eq", value: input.userId },
          { field: "activeTeamId", op: "eq", value: team.id },
        ],
        { activeTeamId: null },
      );
      return ok(true);
    }),
  );
  if (!removed.ok) return removed;
  await runAfter("organization.afterRemoveTeamMember", hooks.afterRemoveTeamMember, event, row.id);
  return ok({ ok: true });
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
