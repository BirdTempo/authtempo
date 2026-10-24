import type { ScimCaller } from "./engine/scim/tokens.js";

/**
 * The seams of a compat package (plan 12d Task 14, ruling 61 P3). Each one
 * holds a value for one object: an AuthConfig, a resolved config and its
 * copies, or a Request that the compat package built. Only core's own functions of `compat.ts` set a value. A
 * core route or the sweep reads the value in place of its own input. Every
 * other step stays core's: the session, the limiter, the manager guard, the
 * scopes, and the audit row.
 */

/**
 * The record of a domain proof of a compat package, built from the row and
 * the label of its connection. The challenge is the row's current one. So a
 * row with a new challenge, after a retry or a loss, never proves itself by
 * an old record. Null: the compat package has no record for this row.
 * Core takes a name of one DNS label under the domain only: a deeper name
 * proves nothing, as the owner of a subdomain may hold its zone.
 */
export type DomainRecordOf = (
  row: { domain: string; challenge: string },
  connectionLabel: string | null,
) => { name: string; values: readonly string[] } | null;

const configRecords = new WeakMap<object, DomainRecordOf>();
/**
 * The key of the record on a resolved config. A property, not a WeakMap
 * entry: plan 12h gives each route a spread copy of the config (the scope
 * of its request), and a spread copy keeps an enumerable symbol property.
 */
const RECORD = Symbol("authtempo.compat.domainRecord");
const recordVerifies = new WeakSet<Request>();
const scimCallers = new WeakMap<Request, ScimCaller>();

export function setConfigDomainRecord(input: object, record: DomainRecordOf): void {
  configRecords.set(input, record);
}

/** Carries the record of an AuthConfig onto its resolved config, at `createAuth`. */
export function carryDomainRecord(input: object, resolved: object): void {
  const record = configRecords.get(input);
  if (record) Object.defineProperty(resolved, RECORD, { value: record, enumerable: true });
}

/** The record function of the compat package of this resolved config or of a copy of it, else null. */
export function domainRecordFor(resolved: object): DomainRecordOf | null {
  return (resolved as { [RECORD]?: DomainRecordOf })[RECORD] ?? null;
}

export function markRecordVerify(request: Request): void {
  recordVerifies.add(request);
}

/** True when `POST /sso/domains/verify` asks for the compat package's record, not core's. */
export function isRecordVerify(request: Request): boolean {
  return recordVerifies.has(request);
}

export function setScimCaller(request: Request, caller: ScimCaller): void {
  scimCallers.set(request, caller);
}

/** The caller of a SCIM route that a compat package checked, or null for core's token check. */
export function scimCallerOf(request: Request): ScimCaller | null {
  return scimCallers.get(request) ?? null;
}
