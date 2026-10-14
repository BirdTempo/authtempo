import type { Auth, StorageAdapter } from "@authtempo/core";

/**
 * Turns every second factor method of one user off. Call it only after a
 * check of who the person is, at the level of the enrollment (ASVS 5.0
 * 6.4.4). Core has no delayed self-recovery, and a reset never turns the
 * factor off, so this call is the only way back for a person who lost every
 * method and every backup code.
 */
export async function recoverSecondFactor(
  auth: Auth,
  storage: StorageAdapter,
  email: string,
): Promise<"off" | "was_off" | "no_user"> {
  // The app holds the storage adapter that it gave to `createAuth`.
  const user = await storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) return "no_user";
  // `api.totp` is absent with `totp: false` or with no `password`: no factor exists.
  if (!auth.api.totp) return "was_off";
  const r = await auth.api.totp.disable({ userId: user.id });
  // The one failure of the disable is `totp_not_enabled`: the factor was off.
  return r.ok ? "off" : "was_off";
}
