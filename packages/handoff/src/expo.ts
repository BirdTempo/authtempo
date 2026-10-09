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

/** The part of `expo-crypto` the PKCE step needs. Pass the module itself. */
export interface ExpoCryptoLike {
  getRandomBytes(n: number): Uint8Array;
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

/** Hermes has no `crypto.subtle`; expo-crypto supplies the digest and the random bytes. */
export function expoCrypto(Crypto: ExpoCryptoLike): HandoffCrypto {
  return {
    randomBytes: (n) => Crypto.getRandomBytes(n),
    sha256: async (data) => new Uint8Array(await Crypto.digest("SHA-256", data)),
  };
}
