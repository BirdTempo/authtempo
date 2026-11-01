import { createOrganization } from "../../src/engine/organizations.js";
import type { makeAuth } from "../helpers.js";
import { enrolled, verifiedSession } from "../totp-helpers.js";

/**
 * A manager of a new organization (plan 12l): a verified user who created
 * `slug` through the organization engine, then enrolled TOTP. The session
 * of the enrolment is fresh. Each step is a flow of the product.
 *
 * The enrolment signs in again and keeps only that session: `enableTotp`
 * ends the other sessions of the user. It moves the clock of `auth` 30 s on.
 */
export async function managerSession(
  auth: ReturnType<typeof makeAuth>,
  email: string,
  slug: string,
) {
  const plain = await verifiedSession(auth, email);
  const made = await createOrganization(auth.config, { user: plain.user, slug, name: slug });
  if (!made.ok) throw new Error(made.code);
  const owner = await enrolled(auth, email);
  return { token: owner.session.token, user: owner.user, org: made.value.organization.id };
}

/** A manager of `managerSession`. */
export type Manager = Awaited<ReturnType<typeof managerSession>>;
