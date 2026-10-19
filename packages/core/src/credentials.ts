/**
 * The credential facts for an SDK (plan 11d, spec 20): the token prefixes,
 * the JWT `typ` values, the cookie names and their rule, the bearer and
 * cookie rule, the compact JWS check on Web Crypto, the DPoP proof check (plan 12e), and the resource rules. A resource server
 * verifies with this code, so no supplier holds the check.
 */
export {
  ACCESS_TOKEN_TYPE,
  API_TOKEN_PREFIX,
  DEFAULT_COOKIE_NAME,
  LEGACY_COOKIE_NAME,
  readBearer,
  readSessionToken,
  SESSION_JWT_TYPE,
  SESSION_TOKEN_PREFIX,
  type SessionCookieNames,
  sessionCookieNames,
} from "./primitives/credentials.js";
export {
  checkDpopProof,
  DPOP_TYP,
  type DpopBinding,
  type DpopCheck,
  type DpopCheckInput,
} from "./primitives/dpop.js";
export { FOREIGN_ALGS, type ForeignAlg } from "./primitives/foreign-jwk.js";
export {
  type DecodedJws,
  decodeJws,
  isPublicJwk,
  JWK_PRIVATE_MEMBERS,
  JWKS_RETIRED_MAX,
  JWS_ALGS,
  JWS_RE,
  type JwsAlg,
  type PublicJwk,
  verifyJws,
} from "./primitives/jwk.js";
export { isResourceUrl, resourceOf } from "./primitives/resource.js";
