import type { Client } from "@authtempo/client";

/**
 * The sign-in of a phone or desktop app by email code. `askCode` shows a field
 * and answers what the person types. The answer holds the bearer token: store
 * it in the device's secure store.
 */
export async function signInByCode(client: Client, email: string, askCode: () => Promise<string>) {
  const sent = await client.emailOtp.request({ email });
  if (!sent.ok) return sent;
  return client.emailOtp.verify({ email, code: await askCode() });
}
