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
 * away (Behavior 1, ruling 25 N4 of plan 12d). D1 Free allows 50 queries
 * per invocation (D1 limits page, read 2026-10-21), and the port has no
 * batch insert: each added member costs one create, and one more with a
 * team (`scim.groups: "both"`). So the cap comes from the budget, not from
 * the 1000 of spec item 18. The worst request on the D1 binding
 * (scim-groups-budget.test.ts, 2026-10-22) is a PATCH of a mapped group
 * with a team, a dynamic role in the map, the role hooks, and
 * `membersPerTeam`: 8 adds and 1 removal send 49 queries with the token
 * write of `lastUsedAt`. Each further add costs 2, so a tenth value does
 * not fit. Okta sends up to 1000 members in one PATCH (Okta developer
 * forum, read 2026-10-22), so the SCIM docs name the cap.
 */
export const PATCH_MEMBERS_MAX = 9;

/**
 * The most members whose role one request computes again (Behavior 2): at
 * a delete or a rename of a mapped group, each member. Per 50 members the
 * recompute reads their Users, their member rows, their groups, and their
 * users for the role hooks, and sends two statements per role change on D1
 * (the undo read and the update). On the D1 binding (2026-10-22) a rename
 * into the map of a group of 250 members sends 46 queries, and one of 300
 * does not fit. A larger mapped group answers 400 `invalidValue` at a
 * delete or a rename. The fix is a smaller group, or a group out of the
 * role map first. The meter of `recompute` is the second guard: members
 * with many different roles need more updates, and a change that does not
 * fit the budget answers the same.
 */
export const GROUP_ROLE_USERS_MAX = 250;
