import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

/** The key set of the API. jose keeps the keys in a cache and reads them again for a new kid. */
const JWKS = createRemoteJWKSet(new URL("https://api.example.com/auth/jwks"));

/**
 * The check of the other server. `typ: "JWT"` refuses an OAuth access token,
 * which the same key signs with `typ: "at+jwt"`.
 */
export async function verifySessionJwt(token: string, jwks: JWTVerifyGetKey = JWKS) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://api.example.com/auth",
    audience: "https://files.example.com",
    typ: "JWT",
  });
  return payload;
}
