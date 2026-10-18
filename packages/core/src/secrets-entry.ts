// The entry `@authtempo/core/secrets` (plan 11c2): the rules of the app
// secret for the CLI, outside the main entry, as
// `@authtempo/core/operator-secret` is. `authtempo secret` refuses a value
// that `createAuth` would warn on, from this one source.

export { REWRAP_LIMIT } from "./engine/secrets.js";
export {
  ENTROPY_REFUSE_BITS,
  ENTROPY_WARN_BITS,
  entropyBits,
  SECRET_VERSION_MAX,
} from "./primitives/keyring.js";
