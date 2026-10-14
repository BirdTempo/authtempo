// Type fixture. It copies the public declarations of two Expo modules, so that `typecheck`
// fails when `expoCrypto` or `expoOpener` stops fitting the real modules.
// Reason: the unit tests use fakes that the author types, and a fake cannot see a mismatch
// with the real declaration. This is how the string-literal `digest` shipped broken once.
// Copied by hand on 2026-10-09 from expo-crypto 57.0.2 (build/Crypto.d.ts, build/Crypto.types.d.ts)
// and from the expo-web-browser docs for openAuthSessionAsync (57.0.3).
// And from expo-secure-store 57.0.4 (build/SecureStore.d.ts), read 2026-10-14.
// Update the copy and the date when you raise either module.
import { expoCrypto, expoOpener, expoTokenStore } from "../src/expo.js";

// expo-crypto 57.0.2: a string enum, and a digest that takes BufferSource.
enum CryptoDigestAlgorithm {
  SHA1 = "SHA-1",
  SHA256 = "SHA-256",
  SHA384 = "SHA-384",
  SHA512 = "SHA-512",
}
declare function getRandomBytes(byteCount: number): Uint8Array;
declare function digest(algorithm: CryptoDigestAlgorithm, data: BufferSource): Promise<ArrayBuffer>;
const Crypto = { CryptoDigestAlgorithm, getRandomBytes, digest };

// expo-web-browser: the result is a union, and the options are all optional.
type WebBrowserAuthSessionResult =
  | { type: "cancel" | "dismiss" | "locked" }
  | { type: "success"; url: string };
declare function openAuthSessionAsync(
  url: string,
  redirectUrl?: string | null,
  options?: { preferEphemeralSession?: boolean; showTitle?: boolean },
): Promise<WebBrowserAuthSessionResult>;
const WebBrowser = { openAuthSessionAsync };

export const crypto = expoCrypto(Crypto);
export const opener = expoOpener(WebBrowser);

// expo-secure-store 57.0.4: every function takes an optional options object.
type KeychainAccessibilityConstant = number;
type SecureStoreOptions = {
  keychainService?: string;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  keychainAccessible?: KeychainAccessibilityConstant;
  accessGroup?: string;
};
declare function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
declare function setItemAsync(
  key: string,
  value: string,
  options?: SecureStoreOptions,
): Promise<void>;
declare function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
const SecureStore = { getItemAsync, setItemAsync, deleteItemAsync };

export const tokens = expoTokenStore(SecureStore);
