import type { Auth } from "@authtempo/core";
import { SUPPORT_DESK } from "./operator-users.ts";

/**
 * Corrects the name or the image of a user. Null clears a field, and a
 * field that is absent stays. The address, the verified flag, the
 * credentials, and the sessions have their own flows: this act never
 * changes them.
 */
export async function correctProfile(
  auth: Auth,
  userId: string,
  change: { name?: string | null; image?: string | null },
  ticket: string,
) {
  const done = await auth.api.operator.users.update({
    actor: SUPPORT_DESK,
    userId,
    ...change,
    reason: `ticket ${ticket}`,
    ip: null,
    userAgent: null,
  });
  if (!done.ok) return { error: done.code };
  // The audit row names the changed fields, never a value.
  return { name: done.value.user.name, auditId: done.value.auditId };
}
