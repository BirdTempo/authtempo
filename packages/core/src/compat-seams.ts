import type { ScimCaller } from "./engine/scim/tokens.js";

/**
 * The seams of a compat package (plan 12d Task 14, ruling 61 P3). Each one
 * holds a value for one object: an AuthConfig, a resolved config and its
 * copies, or a Request that the compat package built. Only core's own
 * functions of `compat.ts` set a value. A core route or the sweep reads the
 * value in place of its own input. Every other step stays core's: the
 * session, the limiter, the manager guard, the scopes, and the audit row.
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
/** The user of an SSO manager write that a compat package counted before its own read. */
const ssoManageCounted = new WeakMap<Request, string>();
/**
 * The user of an SSO connection write whose large read a compat package
 * counted, and whether the counts allowed it (rulings 69 and 72 Low 2).
 */
const largeReadCounted = new WeakMap<Request, { userId: string; allowed: boolean }>();

export function setConfigDomainRecord(input: object, record: DomainRecordOf): void {
  configRecords.set(input, record);
}

/** Carries the record of an AuthConfig onto its resolved config, at `createAuth`. */
export function carryDomainRecord(input: object, resolved: object): void {
  const record = configRecords.get(input);
  if (record) Object.defineProperty(resolved, RECORD, { value: record, enumerable: true });
}

/**
 * The record function of the compat package of this resolved config or of a
 * copy of it, else null.
 */
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

/**
 * Marks `request` as one SSO manager write of `userId` that core's limit
 * counted already (ruling 51 Minor 1 of the 12j lane). Only
 * `countSsoManageWrite` sets the mark, after the count.
 */
export function markSsoManageCounted(request: Request, userId: string): void {
  ssoManageCounted.set(request, userId);
}

/**
 * Marks `request` as one SSO connection write of `userId` whose large body
 * read core's limits counted already (ruling 69 of the 12j lane), with the
 * outcome of those counts. Only `countSsoManageWrite` sets the mark, after
 * the counts. A refused count marks too, so core answers 429 and counts the
 * read no more (ruling 72 Low 2): a second count would spend one more read
 * of the user when only the deployment refused.
 */
export function markLargeReadCounted(request: Request, userId: string, allowed: boolean): void {
  largeReadCounted.set(request, { userId, allowed });
}

/** Moves the mark of `from` in `marks` to `to`. No mark, no move. */
function moveMark<V>(marks: WeakMap<Request, V>, from: Request, to: Request): void {
  const value = marks.get(from);
  if (value === undefined) return;
  marks.delete(from);
  marks.set(to, value);
}

/** Moves the marks of `from` to `to`, a request that core gets in place of `from`. No mark, no move. */
export function moveSsoManageCounted(from: Request, to: Request): void {
  moveMark(ssoManageCounted, from, to);
  moveMark(largeReadCounted, from, to);
}

/**
 * True when `request` holds the mark of a write of `userId`. The mark goes
 * at the read, so it covers one count only.
 */
export function takeSsoManageCounted(request: Request, userId: string): boolean {
  const marked = ssoManageCounted.get(request) === userId;
  ssoManageCounted.delete(request);
  return marked;
}

/**
 * The outcome of the large-read counts of a compat package for a write of
 * `userId`: "allowed", "refused", or null when it counted none for that
 * user. The mark goes at the read.
 */
export function takeLargeReadCounted(
  request: Request,
  userId: string,
): "allowed" | "refused" | null {
  const mark = largeReadCounted.get(request);
  largeReadCounted.delete(request);
  if (mark?.userId !== userId) return null;
  return mark.allowed ? "allowed" : "refused";
}
