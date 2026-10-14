import type { Auth } from "@authtempo/core";

/**
 * The scheduled rotation of the signing key. Run it from a cron trigger, for
 * example once a month. The old key verifies for 24 hours and signs nothing,
 * so a token that it signed stays valid until its own expiry.
 */
export async function rotateSigningKey(auth: Auth): Promise<string | null> {
  // `api.jwt` is absent when the config sets `jwtMint: false`.
  if (!auth.api.jwt) return null;
  const { kid } = await auth.api.jwt.rotate();
  return kid;
}
