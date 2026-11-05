/**
 * The compat entry of core (plan 12d Task 14, ruling 61 P3): the seams that
 * only a compat package uses, off the root entry. `withDomainRecord` and
 * `verifyDomainByRecord` let it prove a domain by its own TXT record.
 * `scimRequestAs` lets it run a SCIM route for a credential that it checked.
 * The SSO seams let it run core's steps of a connection write before its
 * own read of the body, in core's order. `countSsoManageWrite` counts the
 * manager write on core's limit (ruling 51 Minor 1 of the 12j lane).
 * `checkSsoManager` runs core's manager guard for the organization of the
 * query (plan 12l). `canManageSomeSso` runs the pre-check of a path whose
 * organization is in the body. `countSsoLargeRead` then counts the large
 * read. Plan 12l moved that count out of `countSsoManageWrite`. So an
 * account that manages nothing counts no large read (ruling 69 of the 12j
 * lane). `moveSsoManageCount` moves each mark to the request that core
 * gets. Each route step stays core's. `createApiTokenAs` and
 * `createOrganizationTokenAs` make a token for a server call that names its
 * user and has no session (plan 12p), with the user row's rule. This entry
 * is public, and no check holds it to a compat package. So any importer of
 * the two seams gets the user row's rule, with no session and no fresh rule.
 */
export type { DomainRecordOf } from "./compat-seams.js";
export {
  type CheckedScimCaller,
  canManageSomeSso,
  checkSsoManager,
  countSsoLargeRead,
  countSsoManageWrite,
  createApiTokenAs,
  createOrganizationTokenAs,
  moveSsoManageCount,
  scimRequestAs,
  verifyDomainByRecord,
  withDomainRecord,
} from "./create-auth.js";
/**
 * The providers of core's ID-token route (plan 12n decision 18). A compat
 * package takes its list of ID-token providers from here, so the two lists
 * cannot drift.
 */
export { ID_TOKEN_PROVIDERS } from "./engine/id-token.js";
/** The input of `createOrganizationTokenAs` (plan 12p). */
export type { OrganizationTokenCreateFor } from "./engine/organization-tokens.js";
/**
 * A new sign-up proof (ruling 11 of plan 12q). A compat package answers a
 * taken address with a made-up user, as Better Auth does. It gives that
 * answer a proof of the same form, so the answer tells no account.
 */
export { newSignUpProof } from "./engine/password.js";
/** The input of `createApiTokenAs` (plan 12p). */
export type { ApiTokenCreateFor } from "./engine/tokens.js";
/**
 * The capped body read of core (ruling 46 of the 12j lane). A compat
 * package reads each request body with it, at the cap of the core route
 * that the body goes to. So no read of the package is unbounded. A read
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
 * These exports give core's query rule of its two SSO connection writes
 * (fix-wave item 8 of plan 12l). A compat package reads the query of such
 * a write with `readQuery` and the query schema of the route. So it takes
 * exactly the queries that core takes, and the rule has one source.
 */
export { connectionCreateQuery, connectionUpdateQuery } from "./http/contract/sso.js";
export { readQuery } from "./http/routes/sso.js";
