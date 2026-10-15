import { createVerifier, type VerifierOptions } from "@authtempo/verify";

/**
 * The check of the other server, with @authtempo/verify. It reads the key set
 * of the API, keeps it for its max-age, and checks the signature, iss, aud,
 * exp, and the header typ "JWT", which refuses an OAuth access token.
 */
export function createJwtVerifier(fetch?: VerifierOptions["fetch"]) {
  return createVerifier({
    issuer: "https://api.example.com/auth",
    audience: "https://files.example.com",
    ...(fetch ? { fetch } : {}),
  });
}
