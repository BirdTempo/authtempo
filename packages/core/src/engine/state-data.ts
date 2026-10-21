import type { ResolvedConfig } from "../config.js";
import { openSealed, seal } from "../primitives/aead.js";
import { currentSecret, secretFor } from "../primitives/keyring.js";
import { fail, ok, type Result } from "../result.js";

/**
 * The sealed app payload of a social flow (plan 12i Task 19). The state row
 * holds it, and a challenge row holds it again when the callback answers a
 * challenge, so `session.afterCreate` gets it at the challenge verify. Each
 * row seals it under its own id as AAD, so a payload copied to another row
 * does not open.
 */

/** The `info` of the payload's key: one app secret gives one key per use. */
const STATE_DATA_INFO = "authtempo oauth-state-data";

/** The payload sealed under the current secret version, with that version. */
export async function sealStateData(
  config: ResolvedConfig,
  plain: Uint8Array,
  rowId: string,
): Promise<{ sealed: string; version: number }> {
  return {
    sealed: await seal(currentSecret(config.keyring), STATE_DATA_INFO, plain, rowId),
    version: config.keyring.current,
  };
}

/**
 * An opened payload: the value for the hooks, and the UTF-8 JSON bytes that
 * the start checked. A challenge seals these bytes, not a new form of the
 * value, so both hooks parse the same text: `{"n":1e400}` gives `Infinity`
 * at the callback and at the verify alike.
 */
export interface OpenedStateData {
  value: Record<string, unknown>;
  plain: Uint8Array;
}

/**
 * The payload of a row, or null when the row holds none. A payload under a
 * secret version that left the config, or one that does not open under this
 * row's id, answers `invalid_token`: the flow fails closed, and the person
 * starts again.
 */
export async function openStateData(
  config: ResolvedConfig,
  sealed: unknown,
  version: number,
  rowId: string,
): Promise<Result<OpenedStateData | null>> {
  if (sealed === undefined) return ok(null);
  if (typeof sealed !== "string") return fail("invalid_token");
  const secret = secretFor(config.observe, config.keyring, version, rowId);
  if (secret === null) return fail("invalid_token");
  const plain = await openSealed(secret, STATE_DATA_INFO, sealed, rowId);
  if (plain === null) return fail("invalid_token");
  // The start checked the rule, and the seal proves that these are its bytes.
  const value = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  return ok({ value, plain });
}
