// Shapes checked against the expo-web-browser, expo-crypto, and electron docs on 2026-10-09 (expo-web-browser 57.0.3, expo-crypto 57.0.3).
import type { HandoffOpener } from "./handoff.js";
import type { HandoffCrypto } from "./pkce.js";
import type { TokenStore } from "./token-store.js";

export type { TokenStore } from "./token-store.js";

/** The part of `expo-web-browser` the opener calls. Pass the module itself. */
export interface ExpoWebBrowserLike {
  openAuthSessionAsync(
    url: string,
    redirectUrl: string,
    options?: { preferEphemeralSession?: boolean },
  ): Promise<{ type: string; url?: string }>;
}

/**
 * An opener on `WebBrowser.openAuthSessionAsync`. The session is never
 * ephemeral: an ephemeral session keeps no cookies, so the social binding
 * cookie dies between the provider start and its callback, and the flow
 * answers `invalid_token`. A shared session also lets a saved browser
 * session sign in with one press.
 *
 * Unconfirmed on 2026-10-10: no phone has tested the ephemeral claim above.
 * Step 8 of docs/superpowers/runbooks/2026-10-10-expo-cookie-proof.md settles it.
 */
export function expoOpener(WebBrowser: ExpoWebBrowserLike): HandoffOpener {
  return {
    async open(url, redirect) {
      const result = await WebBrowser.openAuthSessionAsync(url, redirect, {
        preferEphemeralSession: false,
      });
      return result.type === "success" && typeof result.url === "string" ? result.url : null;
    },
  };
}

/**
 * The part of `expo-crypto` the PKCE step needs. Pass the module itself.
 * `A` is the module's own `CryptoDigestAlgorithm` enum type. The real
 * `digest` takes that enum and a `BufferSource`, so a string literal does
 * not typecheck (expo-crypto 57.0.2, checked 2026-10-09). The type fixture in
 * `typetest/` pins this shape against a copy of the module's declarations.
 */
export interface ExpoCryptoLike<A> {
  CryptoDigestAlgorithm: { SHA256: A };
  getRandomBytes(n: number): Uint8Array;
  digest(algorithm: A, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

/**
 * Hermes has no `crypto.subtle`; expo-crypto supplies the digest and the
 * random bytes. The digest input is a copy on its own `ArrayBuffer`, the same
 * as `webCrypto()`, because `BufferSource` refuses a shared buffer.
 */
export function expoCrypto<A>(Crypto: ExpoCryptoLike<A>): HandoffCrypto {
  return {
    randomBytes: (n) => Crypto.getRandomBytes(n),
    sha256: async (data) =>
      new Uint8Array(
        await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data)),
      ),
  };
}

/**
 * The part of `expo-secure-store` the token store calls. Pass the module
 * itself. Read on 2026-10-14 from expo-secure-store 57.0.4
 * (build/SecureStore.d.ts); `typetest/expo-shapes.ts` pins it.
 */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: SecureStoreOptionsLike): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreOptionsLike): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStoreOptionsLike): Promise<void>;
}

/**
 * The options of expo-secure-store 57.0.4 (`SecureStoreOptions`). For example
 * `keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK` lets a background task
 * read the token while the phone is locked.
 */
export interface SecureStoreOptionsLike {
  keychainService?: string;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  keychainAccessible?: number;
  accessGroup?: string;
}

/** expo-secure-store: "Keys may contain alphanumeric characters, `.`, `-`, and `_`." */
const SECURE_STORE_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * The bearer token in the iOS Keychain or the Android Keystore, through
 * expo-secure-store (plan 11d). A read that throws answers null for that read
 * and keeps the entry: a locked keychain or a cancelled biometric prompt fails
 * a read for a short time only. An entry that is present but empty is not a
 * token: the read deletes it and answers null.
 */
export function expoTokenStore(
  SecureStore: SecureStoreLike,
  options: {
    key?: string | undefined;
    /** Passed to each call, for example `keychainAccessible` or `keychainService`. */
    secureStoreOptions?: SecureStoreOptionsLike | undefined;
  } = {},
): TokenStore {
  const key = options.key ?? "authtempo.session";
  if (!SECURE_STORE_KEY.test(key))
    throw new Error("authtempo handoff: the key may hold letters, digits, '.', '-', and '_' only");
  const o = options.secureStoreOptions;
  return {
    async get() {
      let value: string | null;
      try {
        value = await SecureStore.getItemAsync(key, o);
      } catch {
        return null;
      }
      if (value === "") {
        await SecureStore.deleteItemAsync(key, o).catch(() => {});
        return null;
      }
      return value;
    },
    set: (token) => SecureStore.setItemAsync(key, token, o),
    clear: () => SecureStore.deleteItemAsync(key, o),
  };
}
