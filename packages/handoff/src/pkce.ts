// Moved to @authtempo/client/oauth (plan 11d). Re-exported for one release, so no import breaks.
export {
  base64Url,
  makePkce,
  type PkceCrypto as HandoffCrypto,
  webCrypto,
} from "@authtempo/client/oauth";
