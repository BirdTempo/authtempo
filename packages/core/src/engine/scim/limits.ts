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
 * per invocation (D1 limits page, read 2026-10-24). So the cap comes from
 * the budget, not from the 1000 of spec item 18. Since ruling 57 of plan
 * 12d the rows go in with `createMany`: one INSERT per 20 scimGroupMember
 * rows and per 16 team member rows on D1, where one statement binds at most
 * 100 parameters. The reads take 50 ids each. The worst request on the D1
 * binding (scim-groups-budget.test.ts, 2026-10-24) is a PATCH of a mapped
 * group with a team, a dynamic role in the map, the role hooks, and
 * `membersPerTeam`: 60 adds and 1 removal send 50 queries with the token
 * write of `lastUsedAt`. One more add needs a fourth scimGroupMember
 * insert, and the budget check refuses it. The cap is the same on every
 * store, because the engine keeps the D1 Free budget on every store. Okta
 * sends up to 1000 members in one PATCH (Okta developer forum, read
 * 2026-10-22), so the SCIM docs name the cap.
 */
export const PATCH_MEMBERS_MAX = 61;

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
 * fit the budget answers the same. `createMany` (ruling 57 of plan 12d)
 * does not change this cap: the recompute inserts no row. The pins of
 * 2026-10-24 hold the same counts as those of 2026-10-22.
 */
export const GROUP_ROLE_USERS_MAX = 250;
