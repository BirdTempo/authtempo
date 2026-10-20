import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import { normalizeSlug } from "./ranks.js";

/** 60 checks per user per minute: a page may check at each key press, and no user may walk the slug space. */
export const SLUG_CHECK_PER_USER = { seconds: 60, max: 60 };

/** The answer of a slug check. `available` is a hint, not a hold. */
export type SlugStatus = "available" | "taken" | "reserved" | "invalid";

/**
 * The organization slug check (plan 12k, spec 29 item 8). It answers the
 * normalized slug and its status, or a null slug for `invalid`. The limiter
 * runs before any read. The answer holds nothing: a create after an
 * `available` answer can still answer `slug_taken`, by the unique key.
 */
export async function checkSlug(
  config: ResolvedConfig,
  input: { user: UserRow; slug: string },
): Promise<Result<{ slug: string | null; status: SlugStatus }>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  if (!(await config.limiter.allow(`slug-check:user:${input.user.id}`, SLUG_CHECK_PER_USER)))
    return fail("rate_limited");
  // normalizeSlug bounds the characters and the case. The slug is only a value in an eq read.
  const slug = normalizeSlug(input.slug);
  if (slug === null) return ok({ slug: null, status: "invalid" });
  // The set holds reservedSlugs and the platform organization (resolveConfig adds it).
  if (o.reservedSlugs.has(slug)) return ok({ slug, status: "reserved" });
  const row = await config.storage.findOne("organization", [
    { field: "slug", op: "eq", value: slug },
  ]);
  return ok({ slug, status: row ? "taken" : "available" });
}
