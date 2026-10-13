import { fromBase64Url, toBase64Url } from "./crypto.js";

/**
 * AES-256-GCM under a key that HKDF-SHA256 derives from the app secret
 * (plan 9f). The salt is empty and `info` names the use, so one app secret
 * gives one key per use. `aad` binds the sealed value to its owner: a value
 * copied to another row does not open. The output is base64url of the
 * 12-byte IV followed by the ciphertext and its 16-byte tag.
 */
async function aesKey(secret: string, info: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(
  secret: string,
  info: string,
  plain: Uint8Array,
  aad: string,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      await aesKey(secret, info),
      plain as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

/** The plain bytes, or null: a malformed value, another key, another `info`, another `aad`, or a changed byte. */
export async function openSealed(
  secret: string,
  info: string,
  sealed: string,
  aad: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const bytes = fromBase64Url(sealed);
    // 12 bytes of IV and at least the 16-byte tag.
    if (bytes.length < 28) return null;
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, 12) as Uint8Array<ArrayBuffer>,
        additionalData: new TextEncoder().encode(aad),
      },
      await aesKey(secret, info),
      bytes.slice(12) as Uint8Array<ArrayBuffer>,
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}
