import { type OidcProvider, stringClaim } from "./provider.js";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/** Endpoints from Google's OpenID discovery document, checked 2026-10-09. */
export function googleProvider(c: GoogleConfig): OidcProvider {
  return {
    kind: "oidc",
    name: "google",
    label: "Continue with Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    // Google documents both forms of `iss`.
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    clientId: c.clientId,
    scope: "openid email profile",
    authorizeParams: {},
    callbackMethod: "GET",
    clientSecret: async () => c.clientSecret,
    profile(claims) {
      return {
        subject: stringClaim(claims, "sub") ?? "",
        email: stringClaim(claims, "email"),
        // Only the boolean counts. A string "true" is not the documented shape.
        emailVerified: claims.email_verified === true,
        name: stringClaim(claims, "name"),
        image: stringClaim(claims, "picture"),
      };
    },
  };
}
