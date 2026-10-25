import { type OidcProvider, type RedirectOverride, stringClaim } from "./provider.js";

export interface GoogleConfig extends RedirectOverride {
  clientId: string;
  clientSecret: string;
  /**
   * The other client ids that an ID token of the ID-token route may name
   * in `aud`, such as an Android or an iOS client id (plan 12i Task 10).
   * 1 to 10 entries. The redirect flow takes `clientId` only.
   */
  audiences?: string[];
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
    // The app gives `providerNonce` to `google.accounts.id.initialize`
    // (ruling 37 I1). Google's reference calls the nonce an opaque string
    // (js-reference, "Last updated 2026-09-01 UTC", read 2026-10-25).
    idToken: { audiences: c.audiences ?? [] },
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
