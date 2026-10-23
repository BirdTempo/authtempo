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
