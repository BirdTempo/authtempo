import type { ResolvedConfig, ResolvedSso } from "../../config.js";
import { ipKey } from "../../limiter/ip-key.js";
import { limit } from "../../limiter/limit.js";
import { fail, ok, type Result } from "../../result.js";
import { normalizeEmail } from "../users.js";
import { claimingDomain } from "./domains.js";

/** `sso-discover:ip`: 30 per 15 minutes (spec 30 item 23). */
const DISCOVER_LIMIT = { seconds: 15 * 60, max: 30 };

/**
 * True when the config turns the kind of the connection on (`sso.oidc`,
 * `sso.saml`). A connection of a kind that is off signs in no one. The
 * start and the discovery read this one rule.
 */
export function kindOn(sso: ResolvedSso, kind: "oidc" | "saml"): boolean {
  return kind === "oidc" ? sso.oidc : sso.saml !== null;
}

/** The start path of a connection, under `basePath`. */
function ssoStartPath(config: ResolvedConfig, connectionId: string): string {
  return `${config.basePath}/sso/${connectionId}/start`;
}

/**
 * The start URL of a connection on the origin of `baseURL`, with `next` as
 * its query when given. The URL is absolute: with `baseURL` on another
 * origin than the app, a path would send the browser to a page of the app.
 */
export function ssoStartUrl(
  config: ResolvedConfig,
  connectionId: string,
  next: string | undefined,
): string {
  const url = `${config.baseURL}${ssoStartPath(config, connectionId)}`;
  return next === undefined ? url : `${url}?next=${encodeURIComponent(next)}`;
}

/**
 * Discovery at sign-in (plan 12d Task 4 Behavior 7, spec 30 item 10). The
 * verified domain that claims the address, the most specific first, names
 * the connection. An enabled connection of a kind that is on answers its
 * id and its start URL, which carries `next`, else `{ sso: false }`. The
 * answer reads no user row, so it tells whether a domain uses SSO and
 * nothing about a person. WebFinger is not used: OIDC Discovery section 2
 * makes it OPTIONAL, and the domain row names the connection.
 */
export async function discoverSso(
  config: ResolvedConfig,
  input: { email: string; next?: string | undefined; ip: string | null },
): Promise<Result<{ sso: true; connectionId: string; start: string } | { sso: false }>> {
  const sso = config.sso;
  if (!sso) return fail("not_found");
  if (!(await limit(config, "sso-discover:ip", ipKey(input.ip), DISCOVER_LIMIT)))
    return fail("rate_limited");
  const email = normalizeEmail(input.email);
  if (email === null) return ok({ sso: false });
  const domain = await claimingDomain(config.storage, email);
  if (!domain || domain.connectionId === null) return ok({ sso: false });
  const row = await config.storage.findOne("ssoConnection", [
    { field: "id", op: "eq", value: domain.connectionId },
  ]);
  if (!row?.enabled || !kindOn(sso, row.kind)) return ok({ sso: false });
  return ok({
    sso: true,
    connectionId: row.id,
    start: ssoStartUrl(config, row.id, input.next),
  });
}
