import type { ResolvedConfig } from "../config.js";
import { limit } from "../limiter/limit.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow } from "../schema.js";
import { provedAddress } from "./address.js";
import { normalizeSlug } from "./ranks.js";

/**
 * 60 slug reads per user per minute: a page may check at each key press, and
 * no user may walk the slug space. The check, the create, and the rename each
 * answer whether a slug is in use, so all three spend this one key. The cost
 * to a normal user: after 60 checks in one minute, a create or a rename
 * answers `rate_limited` until that minute ends.
 */
export const SLUG_CHECK_PER_USER = { seconds: 60, max: 60 };

/** Spends one slug read of the user. The call runs before the read, and false means `rate_limited`. */
export function spendSlugRead(config: ResolvedConfig, userId: string): Promise<boolean> {
  return limit(config, "slug-check:user", userId, SLUG_CHECK_PER_USER);
}

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
  input: { user: UserRow; session?: SessionRow | undefined; slug: string },
): Promise<Result<{ slug: string | null; status: SlugStatus }>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  // The session's flag with the user's (plan 12p).
  if (!provedAddress(input)) return fail("email_unverified");
  if (!(await spendSlugRead(config, input.user.id))) return fail("rate_limited");
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
