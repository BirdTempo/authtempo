import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/**
 * The origin of the extension: `chrome-extension://` and its ID. Put the
 * `key` of the store item in manifest.json, so a build you load unpacked
 * has the same ID as the store item.
 */
export const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

export function createExtensionAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  mode: "token" | "cookie" = "token",
) {
  return createAuth({
    baseURL: "https://api.example.com",
    // An exact origin. Core refuses a wildcard.
    trustedOrigins: [EXTENSION_ORIGIN],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    // Cookie mode only: the extension is another site than the API.
    ...(mode === "cookie" ? { cookie: { sameSite: "None" as const } } : {}),
  });
}
