import type { Observer } from "../observe/observer.js";

/**
 * The app secrets by version (plan 12b, spec 22). The first entry is the
 * current version: every new seal and every new keyed hash uses it. A read
 * opens a value only under the version that its row names, and never tries
 * a second version. So a database with two versions in it has no trial
 * decryption, and a wrong version answers as a wrong secret did before.
 */

export interface SecretVersion {
  /** An integer from 1 to 999999. A row of a database from before plan 12b reads as version 1. */
  version: number;
  /** At least 32 characters. The current value needs an estimate of 100 bits or more. */
  value: string;
}

export interface Keyring {
  readonly current: number;
  /** Every configured version, the current one first. */
  readonly versions: readonly number[];
  /** The value of `version`, or null when the config does not hold it. */
  valueOf(version: number): string | null;
}

/** Six digits keep the column and the log line short. */
export const SECRET_VERSION_MAX = 999_999;
/**
 * Under this estimate `createAuth` refuses the current secret (spec 9, plan 12b).
 * A refusal at 120 bits stops about one correct `openssl rand -hex 16` secret in
 * three (P = 0.32), and at 100 bits about one in 370,000 (P = 2.7e-6), as the
 * design computed on 2026-10-14 from the occupancy distribution.
 */
export const ENTROPY_REFUSE_BITS = 100;
/** Under this estimate `createAuth` writes one warning line. Better Auth 1.7.2 warns under 120 with the same formula. */
export const ENTROPY_WARN_BITS = 120;

/** `entries` passed the config checks: the versions and the values are distinct, and one entry at least exists. */
export function createKeyring(entries: readonly SecretVersion[]): Keyring {
  const first = entries[0];
  if (!first) throw new Error("authtempo: a keyring needs one secret");
  const byVersion = new Map(entries.map((e) => [e.version, e.value]));
  return Object.freeze({
    current: first.version,
    versions: Object.freeze(entries.map((e) => e.version)),
    valueOf: (version: number) => byVersion.get(version) ?? null,
  });
}

/** The value that seals and keys every new value. */
export function currentSecret(keyring: Keyring): string {
  const value = keyring.valueOf(keyring.current);
  if (value === null) throw new Error("authtempo: the current secret version has no value");
  return value;
}

/**
 * The value of the version that a row names, or null with one log line. A
 * sealed value under a version that the config does not hold opens to
 * nothing, as a wrong secret does.
 */
export function secretFor(
  observe: Observer,
  keyring: Keyring,
  version: number,
  rowId: string,
): string | null {
  const value = keyring.valueOf(version);
  // The version and the row id only. Never a value, a hash, or a code.
  if (value === null) observe.emit({ name: "secret.unknown_version", version, rowId });
  return value;
}

/**
 * The key of a keyed hash compare. For a version that the config does not
 * hold it answers the current value and `known: false`, with one log line.
 * The caller runs one HMAC either way and counts the compare only when
 * `known` is true, so the time tells nothing.
 */
export function hashSecretFor(
  observe: Observer,
  keyring: Keyring,
  version: number,
  rowId: string,
): { secret: string; known: boolean } {
  const value = secretFor(observe, keyring, version, rowId);
  return value === null
    ? { secret: currentSecret(keyring), known: false }
    : { secret: value, known: true };
}

/**
 * The estimate of a secret's entropy in bits: its length times log2 of its
 * distinct characters, both in code points. It catches a repeated character
 * and a short alphabet. It does not catch a pattern: "0123456789abcdef"
 * twice gives 128 bits.
 */
export function entropyBits(value: string): number {
  const chars = [...value];
  return chars.length * Math.log2(new Set(chars).size || 1);
}
