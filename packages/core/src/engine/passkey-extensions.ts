import type { ResolvedPasskey } from "../config.js";
import { fromBase64Url } from "../primitives/crypto.js";
import { fail, ok, type Result } from "../result.js";

/**
 * The passkey extensions PRF, `largeBlob`, and `credProps` (plan 12i Task
 * 21, spec 32 item 21). The client extension outputs are not signed by the
 * authenticator. So the stored flags are advice for the app's own client,
 * and no check of core reads them. A PRF output and a large blob stay in
 * the browser: each verify drops them before any read, store, or log.
 */

/**
 * The extensions of one sign-in, from the body of the options request. Each
 * PRF salt is the base64url of 32 bytes. The browser hashes each salt with
 * a fixed context before the authenticator sees it, and the output also
 * depends on a secret of the credential. So one salt for every user gives
 * each credential its own output, and a salt need not be secret.
 */
export interface PasskeySignInExtensions {
  prf?: { first: string; second?: string | undefined } | undefined;
  largeBlob?: { read: true } | undefined;
}

/** The flags of a passkey row that the registration outputs give. */
export interface ExtensionFlags {
  discoverable: boolean | null;
  prf: boolean;
  largeBlob: boolean;
}

/** The bytes of a PRF salt (plan 12i). */
const PRF_SALT_BYTES = 32;
/** 32 bytes in base64url with no padding: 43 characters. */
const PRF_SALT = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prfSalt(text: unknown): text is string {
  return (
    typeof text === "string" && PRF_SALT.test(text) && fromBase64Url(text).length === PRF_SALT_BYTES
  );
}

/**
 * The `extensions` of the registration options: only what the config asks
 * for. Null when it asks for none. Core never asks for a large blob write.
 */
export function registrationExtensions(rp: ResolvedPasskey): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (rp.extensions.credProps) out.credProps = true;
  if (rp.extensions.prf) out.prf = {};
  if (rp.extensions.largeBlob !== false) out.largeBlob = { support: rp.extensions.largeBlob };
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * The `extensions` of the sign-in options, from the request (plan 12i). A
 * salt that is not 32 bytes, or an extension that the config does not turn
 * on, answers `invalid_body`. Null when the request asks for none.
 */
export function signInExtensions(
  rp: ResolvedPasskey,
  input: PasskeySignInExtensions | undefined,
): Result<Record<string, unknown> | null> {
  if (input === undefined) return ok(null);
  const out: Record<string, unknown> = {};
  if (input.prf !== undefined) {
    if (!isRecord(input.prf)) return fail("invalid_body");
    const { first, second } = input.prf;
    if (!rp.extensions.prf || !prfSalt(first)) return fail("invalid_body");
    if (second !== undefined && !prfSalt(second)) return fail("invalid_body");
    out.prf = { eval: second === undefined ? { first } : { first, second } };
  }
  if (input.largeBlob !== undefined) {
    if (rp.extensions.largeBlob === false || !isRecord(input.largeBlob))
      return fail("invalid_body");
    if (input.largeBlob.read !== true) return fail("invalid_body");
    out.largeBlob = { read: true };
  }
  return ok(Object.keys(out).length === 0 ? null : out);
}

/**
 * The options with core's `extensions` in place of the seam's. The library
 * asks for `credProps` by itself, so core writes the key, as it writes
 * `hints`: a replacement library cannot ask for more or less. Its type has
 * no `largeBlob`, and it writes a PRF salt as bytes, not as base64url
 * (@simplewebauthn/server 14.0.3, read 2026-10-24).
 */
export function withExtensions<T extends object>(
  options: T,
  extensions: Record<string, unknown> | null,
): T {
  const { extensions: _seam, ...rest } = options as T & { extensions?: unknown };
  return (extensions === null ? rest : { ...rest, extensions }) as T;
}

/**
 * The client extension outputs that core keeps, by shape: the boolean of
 * `credProps.rk`, `prf.enabled`, `largeBlob.supported`, and
 * `largeBlob.written`, and nothing else. So `prf.results` and
 * `largeBlob.blob` never pass, and the kept part has a fixed size.
 */
function keptOutputs(results: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(results)) return out;
  const { credProps, prf, largeBlob } = results;
  if (isRecord(credProps) && typeof credProps.rk === "boolean")
    out.credProps = { rk: credProps.rk };
  if (isRecord(prf) && typeof prf.enabled === "boolean") out.prf = { enabled: prf.enabled };
  if (isRecord(largeBlob)) {
    const kept: Record<string, boolean> = {};
    if (typeof largeBlob.supported === "boolean") kept.supported = largeBlob.supported;
    if (typeof largeBlob.written === "boolean") kept.written = largeBlob.written;
    if (Object.keys(kept).length > 0) out.largeBlob = kept;
  }
  return out;
}

/**
 * A copy of a ceremony response with only the kept outputs in
 * `clientExtensionResults`. Each verify calls it first, so no read, store,
 * or log of core sees a PRF output or a large blob.
 */
export function withoutSecretOutputs(response: unknown): unknown {
  if (!isRecord(response)) return response;
  return { ...response, clientExtensionResults: keptOutputs(response.clientExtensionResults) };
}

/**
 * The flags of a new passkey row, from the outputs of a response that
 * `withoutSecretOutputs` made. An extension that the config did not ask for
 * gives no flag, whatever the client claims.
 */
export function storedFlags(rp: ResolvedPasskey, response: unknown): ExtensionFlags {
  const results = isRecord(response) ? response.clientExtensionResults : undefined;
  const outputs = isRecord(results) ? results : {};
  const credProps = outputs.credProps as { rk?: boolean } | undefined;
  const prf = outputs.prf as { enabled?: boolean } | undefined;
  const largeBlob = outputs.largeBlob as { supported?: boolean } | undefined;
  return {
    discoverable: rp.extensions.credProps ? (credProps?.rk ?? null) : null,
    prf: rp.extensions.prf && prf?.enabled === true,
    largeBlob: rp.extensions.largeBlob !== false && largeBlob?.supported === true,
  };
}
