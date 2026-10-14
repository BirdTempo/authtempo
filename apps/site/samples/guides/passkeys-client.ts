import { type Client, supportsPasskeys } from "@authtempo/client";

/** The "Add a passkey" button. The person must be signed in with a verified address. */
export async function addPasskey(client: Client, name: string): Promise<string> {
  if (!supportsPasskeys()) return "This browser has no passkeys.";
  const r = await client.passkey.register({ name });
  if (r.ok) return `Passkey ${r.value.name ?? name} added.`;
  // A dismissed prompt is a normal event. Show nothing.
  return r.code === "cancelled" ? "" : `The passkey was not added: ${r.code}.`;
}

/** The "Sign in with a passkey" button. The device offers its discoverable passkeys. */
export async function signInWithPasskey(client: Client): Promise<string> {
  const r = await client.passkey.signIn();
  if (r.ok) return `Signed in as ${r.value.user.email}.`;
  return r.code === "cancelled" ? "" : `The sign-in failed: ${r.code}.`;
}
