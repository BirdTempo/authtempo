/**
 * Better Auth's placeholder address (plan 12i Task 16, deviation 7). Better
 * Auth's `user.email` is NOT NULL, and core's address is nullable from
 * schema version 15. So the storage writes a placeholder for a core null
 * and reads each placeholder back as null. A placeholder never reaches core
 * as an address, so it is never mailed and never counts as proved.
 *
 * Better Auth 1.7.2 writes `<id>@<namespace>.placeholder.invalid`
 * (`createPlaceholderEmail` of @better-auth/core, read 2026-10-25): the
 * anonymous plugin with the namespace `anonymous`, TikTok and WeChat with
 * their own. `.invalid` never resolves (RFC 6761 section 6.4). With the
 * anonymous plugin's `emailDomainName`, it writes `temp-<id>@<domain>`.
 * That domain can be the app's own, where real people have addresses. So
 * only the `temp-` form on it is a placeholder, not every address there.
 */

/** The domain of `createPlaceholderEmail`. */
export const PLACEHOLDER_DOMAIN = "placeholder.invalid";

/** A host in lower-case ASCII with at least one dot: the only form of `emailDomainName` that maps. */
export const EMAIL_DOMAIN_RE =
  /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** True for an address on a domain of `createPlaceholderEmail`. */
export function onPlaceholderDomain(address: string): boolean {
  const a = address.toLowerCase();
  const domain = a.slice(a.lastIndexOf("@") + 1);
  return domain === PLACEHOLDER_DOMAIN || domain.endsWith(`.${PLACEHOLDER_DOMAIN}`);
}

/**
 * True for a placeholder: an address on a placeholder domain, or the
 * `temp-` form on `emailDomainName`. statements.ts holds the same rule in
 * SQL (`placeholderSql`), so a where and a read agree.
 */
export function isPlaceholder(address: string, emailDomainName: string | null): boolean {
  if (onPlaceholderDomain(address)) return true;
  if (emailDomainName === null) return false;
  const a = address.toLowerCase();
  return a.startsWith("temp-") && a.endsWith(`@${emailDomainName}`);
}

/** The placeholder that the storage writes for a core null, keyed by the user id, so it is unique. */
export function placeholderFor(userId: string, emailDomainName: string | null): string {
  return emailDomainName === null
    ? `${userId}@anonymous.${PLACEHOLDER_DOMAIN}`
    : `temp-${userId}@${emailDomainName}`;
}

/**
 * The SQL test of `isPlaceholder` on a quoted column. Each pattern is a
 * literal. The domain matches EMAIL_DOMAIN_RE, which has no `%`, `_`, or
 * quote. So no LIKE wildcard and no SQL comes from a value.
 */
export function placeholderSql(column: string, emailDomainName: string | null): string {
  const c = `lower(${column})`;
  const tests = [`${c} LIKE '%@${PLACEHOLDER_DOMAIN}'`, `${c} LIKE '%.${PLACEHOLDER_DOMAIN}'`];
  if (emailDomainName !== null) {
    if (!EMAIL_DOMAIN_RE.test(emailDomainName))
      throw new Error("authtempo compat: emailDomainName is not a lower-case host");
    tests.push(`${c} LIKE 'temp-%@${emailDomainName}'`);
  }
  return `(${tests.join(" OR ")})`;
}

/**
 * The `emailDomainName` of one storage. `betterAuth` sets it from the
 * anonymous plugin before the first statement. One storage serves one
 * domain: a second instance with another domain is refused at construction.
 */
export interface PlaceholderRule {
  domain: string | null;
}

const RULES = new WeakMap<object, PlaceholderRule>();

export function registerPlaceholderRule(storage: object, rule: PlaceholderRule): void {
  RULES.set(storage, rule);
}

export function placeholderRuleOf(storage: object): PlaceholderRule | undefined {
  return RULES.get(storage);
}
