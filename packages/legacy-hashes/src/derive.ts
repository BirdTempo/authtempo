import { argon2idAsync } from "@noble/hashes/argon2.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bcrypt from "bcryptjs";
import { decodeBase64, type ParsedLegacyHash } from "./grammar.js";

/** The Firebase project's hash parameters from the console ("Password hash parameters"), base64 as shown there. */
export interface FirebaseHashConfig {
  signerKey: string;
  saltSeparator: string;
}

/**
 * The primitives one verify calls. The seam takes them as an option, so a
 * test can count the derives. The default is `NOBLE_DERIVES`.
 */
export interface Derives {
  bcrypt(plain: string, stored: string): Promise<boolean>;
  argon2id(
    plain: Uint8Array,
    salt: Uint8Array,
    o: { m: number; t: number; p: number; dkLen: number },
  ): Promise<Uint8Array>;
  pbkdf2(plain: Uint8Array, salt: Uint8Array, o: { c: number; dkLen: number }): Promise<Uint8Array>;
  scrypt(
    plain: Uint8Array,
    salt: Uint8Array,
    o: { N: number; r: number; p: number; dkLen: number },
  ): Promise<Uint8Array>;
}

/**
 * Pure JavaScript: bcryptjs 3.0.3 and @noble/hashes 2.4.0. bcryptjs imports
 * Node's `crypto` only for random salt bytes after `crypto.getRandomValues`,
 * and a verify needs no salt (bcryptjs index.js, read 2026-10-11).
 */
export const NOBLE_DERIVES: Derives = {
  bcrypt: (plain, stored) => bcrypt.compare(plain, stored),
  argon2id: (plain, salt, o) => argon2idAsync(plain, salt, { ...o, version: 0x13 }),
  pbkdf2: (plain, salt, o) => pbkdf2Async(sha256, plain, salt, o),
  // maxmem above the default 1 GiB is never needed: the grammar bounds 128 * N * r at 32 MiB.
  scrypt: (plain, salt, o) => scryptAsync(plain, salt, o),
};

/** Constant time for equal lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Firebase's modified scrypt (firebase/scrypt README and Supabase's and
 * Ory's code, read 2026-10-11): key = scrypt(password, salt || separator,
 * N = 2^n, r, p = 1, 32 bytes); the hash is AES-256-CTR of the signer key
 * under that key with a zero counter block.
 */
async function firebaseHash(
  derives: Derives,
  plain: Uint8Array,
  h: { n: number; r: number; salt: Uint8Array },
  config: { signerKey: Uint8Array; saltSeparator: Uint8Array },
): Promise<Uint8Array> {
  const salt = new Uint8Array(h.salt.length + config.saltSeparator.length);
  salt.set(h.salt);
  salt.set(config.saltSeparator, h.salt.length);
  const key = await derives.scrypt(plain, salt, { N: 2 ** h.n, r: h.r, p: 1, dkLen: 32 });
  const aes = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "AES-CTR" },
    false,
    ["encrypt"],
  );
  const out = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: new Uint8Array(16), length: 128 },
    aes,
    config.signerKey as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(out);
}

/** The decoded Firebase parameters, or an Error that names the bad one. */
export function decodeFirebase(config: FirebaseHashConfig): {
  signerKey: Uint8Array;
  saltSeparator: Uint8Array;
} {
  const signerKey = decodeBase64(config.signerKey);
  const saltSeparator = decodeBase64(config.saltSeparator);
  if (!signerKey || signerKey.length < 16 || signerKey.length > 64)
    throw new Error("authtempo legacy-hashes: firebase.signerKey must be base64 of 16 to 64 bytes");
  if (!saltSeparator || saltSeparator.length > 16)
    throw new Error(
      "authtempo legacy-hashes: firebase.saltSeparator must be base64 of 0 to 16 bytes",
    );
  return { signerKey, saltSeparator };
}

/** One full derive for a parsed hash. True on a match. The caller gates it and catches a throw. */
export async function verifyParsed(
  derives: Derives,
  plain: string,
  h: ParsedLegacyHash,
  firebase: { signerKey: Uint8Array; saltSeparator: Uint8Array } | null,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(plain);
  switch (h.format) {
    case "bcrypt":
      return derives.bcrypt(plain, h.stored);
    case "argon2id":
      return equalBytes(
        await derives.argon2id(bytes, h.salt, { m: h.m, t: h.t, p: h.p, dkLen: h.hash.length }),
        h.hash,
      );
    case "pbkdf2-sha256":
      return equalBytes(
        await derives.pbkdf2(bytes, h.salt, { c: h.i, dkLen: h.hash.length }),
        h.hash,
      );
    case "scrypt":
      return equalBytes(
        await derives.scrypt(bytes, h.salt, { N: 2 ** h.n, r: h.r, p: h.p, dkLen: h.hash.length }),
        h.hash,
      );
    case "firescrypt": {
      if (!firebase || firebase.signerKey.length !== h.hash.length) return false;
      return equalBytes(await firebaseHash(derives, bytes, h, firebase), h.hash);
    }
  }
}
