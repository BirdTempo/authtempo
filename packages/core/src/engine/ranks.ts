import type { ResolvedConfig } from "../config.js";

export type ResolvedOrganizations = NonNullable<ResolvedConfig["organizations"]>;

/** One or more role names joined by comma. Lower case, no spaces, no empty part. */
export const ROLE_RE = /^[a-z0-9_-]{1,64}(?:,[a-z0-9_-]{1,64})*$/;

/** The highest rank among the parts; an unknown part ranks 0, so an unknown role fails closed. */
export function rankOf(ranks: Readonly<Record<string, number>>, role: string): number {
  let best = 0;
  for (const part of role.split(",")) {
    const r = Object.hasOwn(ranks, part) ? (ranks[part] ?? 0) : 0;
    if (r > best) best = r;
  }
  return best;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** NFKC, then lower case, then the shape check. A look-alike such as fullwidth letters folds to ASCII, so a reserved word cannot hide behind it. */
export function normalizeSlug(raw: string): string | null {
  const s = raw.normalize("NFKC").toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

/** The platform role is valid in the platform organization only. */
export function roleAllowedIn(
  config: ResolvedOrganizations,
  role: string,
  organizationSlug: string,
): boolean {
  if (config.platformRole === null) return true;
  if (!role.split(",").includes(config.platformRole)) return true;
  return organizationSlug === config.platformOrganization;
}

/** The role each rule needs. One table, read by every operation. */
export const RULES = {
  update: "admin",
  slugChange: "owner",
  delete: "owner",
  members: "viewer",
  addMember: "admin",
  updateRole: "admin",
  removeOther: "admin",
  invite: "admin",
  invitations: "admin",
  revoke: "admin",
} as const;

/** The rank a rule needs. A rule that names a role the table lacks needs the highest rank, so it fails closed. */
export function needs(config: ResolvedOrganizations, rule: keyof typeof RULES): number {
  const role = RULES[rule];
  if (Object.hasOwn(config.ranks, role)) return config.ranks[role] ?? Number.POSITIVE_INFINITY;
  return Math.max(...Object.values(config.ranks));
}
