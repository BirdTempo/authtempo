import { type BrowserWebAuthn, browserWebAuthn, type Client } from "@authtempo/client";

/**
 * The PRF salt of the app: the base64url of 32 bytes. One fixed salt is
 * safe for every user, because each passkey gives its own output.
 */
export const VAULT_SALT = "dmF1bHQta2V5LXYxLXZhdWx0LWtleS12MS12YXVsdC0";

/** Signs in with a passkey and gives the PRF output to the app. The server never sees it. */
export async function signInAndUnlock(
  client: Client,
  unlock: (prfOutput: string) => void,
): Promise<string> {
  const r = await client.passkey.signIn({
    extensions: { prf: { first: VAULT_SALT } },
    onExtensionResults: (results) => {
      if (results.prf) unlock(results.prf.first);
    },
  });
  return r.ok ? "Signed in." : r.code;
}

/** A browser seam that adds a large blob to write to each sign-in. Core never sends one. */
export function writingBlob(blob: string): BrowserWebAuthn {
  const browser = browserWebAuthn();
  return {
    create: (options) => browser.create(options),
    get: (options, ceremony) =>
      browser.get(
        { ...options, extensions: { ...options.extensions, largeBlob: { write: blob } } as never },
        ceremony,
      ),
  };
}
