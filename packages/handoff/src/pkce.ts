/**
 * The two primitives the handoff needs. The default is Web Crypto, which
 * browsers, Node 22, and Electron have. React Native (Hermes) has neither
 * `crypto.subtle` nor, on every version, `getRandomValues`; the Expo helper
 * supplies one built on expo-crypto.
 */
export interface HandoffCrypto {
  randomBytes(n: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

export function webCrypto(): HandoffCrypto {
  return {
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sha256: async (data) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))),
  };
}

export function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256: a 32 byte verifier as base64url (43 characters), and the base64url SHA-256 of that string. */
export async function makePkce(c: HandoffCrypto): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(c.randomBytes(32));
  const challenge = base64Url(await c.sha256(new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}
