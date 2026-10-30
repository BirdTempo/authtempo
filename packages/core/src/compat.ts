/**
 * The compat entry of core (plan 12d Task 14, ruling 61 P3): the seams that
 * only a compat package uses, off the root entry. `withDomainRecord` and
 * `verifyDomainByRecord` let it prove a domain by its own TXT record.
 * `scimRequestAs` lets it run a SCIM route for a credential that it checked.
 * `countSsoManageWrite` and `moveSsoManageCount` let it count an SSO
 * manager write on core's limit before its own read of the body (ruling 51
 * Minor 1 of the 12j lane). Each route step stays core's.
 */
export type { DomainRecordOf } from "./compat-seams.js";
export {
  type CheckedScimCaller,
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
