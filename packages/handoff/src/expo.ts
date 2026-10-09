// Shapes checked against the expo-web-browser, expo-crypto, and electron docs on 2026-10-09 (expo-web-browser 57.0.3, expo-crypto 57.0.3).
import type { HandoffOpener } from "./handoff.js";
import type { HandoffCrypto } from "./pkce.js";

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
