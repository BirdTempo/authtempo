/**
 * The compat entry of core (plan 12d Task 14, ruling 61 P3): the seams that
 * only a compat package uses, off the root entry. `withDomainRecord` and
 * `verifyDomainByRecord` let it prove a domain by its own TXT record.
 * `scimRequestAs` lets it run a SCIM route for a credential that it checked.
 * The SSO seams let it run core's steps of a connection write before its
 * own read of the body, in core's order. `countSsoManageWrite` counts the
 * manager write on core's limit (ruling 51 Minor 1 of the 12j lane).
 * `checkSsoManager` runs core's manager guard for the organization of the
 * query, and `canManageSomeSso` runs the pre-check of a path whose
 * organization is in the body (plan 12l). `countSsoLargeRead` then counts
 * the large read: plan 12l moved that count out of `countSsoManageWrite`,
 * so an account that manages nothing counts no large read (ruling 69 of
 * the 12j lane). `moveSsoManageCount` moves each mark to the request that
 * core gets. Each route step stays core's.
 */
export type { DomainRecordOf } from "./compat-seams.js";
export {
  type CheckedScimCaller,
  canManageSomeSso,
  checkSsoManager,
  countSsoLargeRead,
  countSsoManageWrite,
  moveSsoManageCount,
  scimRequestAs,
  verifyDomainByRecord,
  withDomainRecord,
} from "./create-auth.js";
/**
 * The capped body read of core (ruling 46 of the 12j lane). A compat
 * package reads each request body with it, at the cap of the core route
 * that the body goes to, so no read of the package is unbounded. A read
 * past the cap throws `BodyTooLarge`. A read above the floor past the
 * budget of the large reads of the isolate throws `BodyBusy` (ruling 51).
 * A read above the floor past its deadlines throws `BodyTimeout` (ruling 59).
 * A package that reads a clone passes `bodyClientOf` of the request it
 * cloned, so the read counts on the share of that client (ruling 59).
 */
export {
  BODY_BUSY_RETRY_SECONDS,
  BodyBusy,
  BodyTimeout,
  BodyTooLarge,
  bodyCapOf,
  bodyClientOf,
  bodyReadable,
  parseBodyJson,
  readBodyText,
} from "./http/body-cap.js";
/**
 * Core's query rule of its two SSO connection writes (fix-wave item 8 of
 * plan 12l). A compat package reads the query of such a write with
 * `readQuery` and the query schema of the route. So it takes exactly the
 * queries that core takes, and the rule has one source.
 */
export { connectionCreateQuery, connectionUpdateQuery } from "./http/contract/sso.js";
export { readQuery } from "./http/routes/sso.js";
