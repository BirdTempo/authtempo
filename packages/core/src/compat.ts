/**
 * The compat entry of core (plan 12d Task 14, ruling 61 P3): the seams that
 * only a compat package uses, off the root entry. `withDomainRecord` and
 * `verifyDomainByRecord` let it prove a domain by its own TXT record.
 * `scimRequestAs` lets it run a SCIM route for a credential that it checked.
 * Each route step stays core's.
 */
export type { DomainRecordOf } from "./compat-seams.js";
export {
  type CheckedScimCaller,
  scimRequestAs,
  verifyDomainByRecord,
  withDomainRecord,
} from "./create-auth.js";
/**
 * The capped body read of core (ruling 46 of the 12j lane). A compat
 * package reads each request body with it, at the cap of the core route
 * that the body goes to, so no read of the package is unbounded. A read
 * past the cap throws `BodyTooLarge`.
 */
export {
  BodyTooLarge,
  bodyCapOf,
  parseBodyJson,
  readBodyText,
} from "./http/body-cap.js";
