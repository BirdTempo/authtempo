import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createJwtAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    // JWT minting is on by default. `jwtMint: false` removes /jwks, /token, and api.jwt.
    jwtMint: {
      // EdDSA (Ed25519) is the default. ES256 is the other choice.
      alg: "EdDSA",
      // The server that takes the token. The default is baseURL.
      audience: "https://files.example.com",
      // The life of a token, 1 to 60 minutes. A sign-out does not end it.
      ttlMinutes: 10,
      // The app's own claims. Core sets the reserved claims itself.
      claims: () => ({ plan: "free" }),
    },
  });
}
