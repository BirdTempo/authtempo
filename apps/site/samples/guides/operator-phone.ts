import type { Auth } from "@authtempo/core";
import { SUPPORT_DESK } from "./operator-users.ts";

/**
 * Creates a user with a phone number only. No SMS goes out at the create:
 * the person asks for a phone code at the first sign-in. Until then, no
 * code proved the number. Do not act on that user in process as if the
 * number were proved: wait for the first phone session.
 */
export async function createPhoneOnly(auth: Auth, phone: string, ticket: string) {
  const created = await auth.api.operator.users.create({
    actor: SUPPORT_DESK,
    // Null on purpose: the user has no address.
    email: null,
    phone,
    reason: `ticket ${ticket}`,
    ip: null,
    userAgent: null,
  });
  return created.ok ? { userId: created.value.userId } : { error: created.code };
}
