/**
 * The member caps of the SCIM Groups (plan 12d Task 11). groups.ts keeps
 * them, and the ServiceProviderConfig of discovery.ts states them, so a
 * directory can read them (ruling 53 P4 of plan 12d).
 */

/** The most members of one group (Behavior 1). A larger group answers 400 `invalidValue`. */
export const GROUP_MEMBERS_MAX = 10_000;

/**
 * The most member values that one request changes: the values that an add
 * or a remove names, and the members that a replace or a PUT adds or takes
 * away (Behavior 1, ruling 25 N4 of plan 12d). It is the 1000 of spec item
 * 18: Okta sends up to 1000 members in one PATCH (Okta developer forum,
 * read 2026-10-22). D1 Free allows 50 queries per invocation (D1 limits
 * page, read 2026-10-24). Since ruling 84 of plan 12d a read, a delete,
 * and an update of up to 1000 ids is one statement on every store: D1 and
 * SQLite bind the list as one JSON text. The rows go in with `createMany`
 * in the chunks of `rowChunks`. So the count of a write does not grow with
 * its members, past the few inserts. The worst request on the D1 binding
 * (scim-groups-budget.test.ts, 2026-10-24) is a PATCH of a mapped group
 * with a team, a dynamic role in the map, the role hooks, and
 * `membersPerTeam`: 999 adds and 1 removal send 41 queries with the token
 * write of `lastUsedAt`. The scratch measure of the same day sent 26, 35,
 * 37, and 41 queries for 1, 61, 500, and 1000 values. The cap is the same
 * on every store, because the engine keeps the D1 Free budget on every
 * store.
 */
export const PATCH_MEMBERS_MAX = 1000;

/**
 * The most members whose role one request computes again (Behavior 2): at
 * a delete or a rename of a mapped group, each member. It must hold
 * PATCH_MEMBERS_MAX, because an add of that many members to a mapped
 * group computes each role. The recompute reads their Users, their member
 * rows, their groups, and their users for the role hooks, and sends two
 * statements per role change on D1 (the undo read and the update). Since
 * ruling 84 of plan 12d each read and each update takes up to 1000 ids in
 * one statement. On the D1 binding (2026-10-24) a rename out of the map
 * and back into it of a group of 1000 members sends 21 and 22 queries,
 * and its delete 24. A larger mapped group answers 400 `invalidValue` at a
 * delete or a rename. The fix is a smaller group, or a group out of the
 * role map first. The meter of `recompute` is the second guard: members
 * with many different roles need more updates, and a change that does not
 * fit the budget answers the same.
 */
export const GROUP_ROLE_USERS_MAX = 1000;
