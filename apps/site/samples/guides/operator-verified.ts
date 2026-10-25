import type { Auth, UserRow } from "@authtempo/core";
import { SUPPORT_DESK } from "./operator-users.ts";

/**
 * Creates a user and adds the user to an organization before the first
 * sign-in. `owner` is the user of the admin page, with the rank to add a
 * member. A member add needs a verified address, so the desk states it.
 * Set `emailVerified: true` only after your own check of the address: a
 * wrong address gives the account to the owner of that address.
 */
export async function addCreatedMember(
  auth: Auth,
  owner: UserRow,
  input: { email: string; organizationId: string; ticket: string },
) {
  const created = await auth.api.operator.users.create({
    actor: SUPPORT_DESK,
    email: input.email,
    // The statement of the desk, not a proof. The audit row records the flag.
    emailVerified: true,
    firstSignIn: "invite",
    reason: `ticket ${input.ticket}`,
    ip: null,
    userAgent: null,
  });
  if (!created.ok) return created;
  return auth.api.addMember({
    user: owner,
    organizationId: input.organizationId,
    userId: created.value.userId,
    role: "member",
  });
}
