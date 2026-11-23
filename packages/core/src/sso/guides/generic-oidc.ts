import type { IdpGuide } from "./index.js";

/**
 * Any OpenID Provider. No provider has these labels, so they are the names
 * of the standards, read on 2026-11-23:
 * - redirect_uri and Initiating Login from a Third Party, section 4:
 *   https://openid.net/specs/openid-connect-core-1_0.html
 * - initiate_login_uri: https://openid.net/specs/openid-connect-registration-1_0.html
 * - SCIM base URI and bearer tokens: https://www.rfc-editor.org/rfc/rfc7644.html
 */
export const genericOidc: IdpGuide = {
  id: "generic-oidc",
  name: "Generic OpenID Connect",
  kinds: ["oidc"],
  checkedOn: "2026-11-23",
  fields: {
    acsUrl: "",
    entityId: "",
    redirectUri: "Redirect URI (redirect_uri)",
    scimBaseUrl: "SCIM base URL",
    scimToken: "Bearer token",
  },
  steps: [
    { text: "Create a confidential web client in your OpenID Provider." },
    { text: 'Enter the redirect URI in "Redirect URI (redirect_uri)".', value: "redirectUri" },
    { text: "Allow the authorization code flow for the client." },
    { text: 'Make sure that the ID token holds the "email" claim.' },
    { text: "Copy the issuer URL, the client ID, and the client secret to the setup page." },
    { text: 'For SCIM, enter the SCIM base URL in "SCIM base URL".', value: "scimBaseUrl" },
    {
      text: 'For SCIM, send the SCIM token as the "Bearer token" in the Authorization header.',
      value: "scimToken",
    },
  ],
  launch:
    "Set the login initiation endpoint (initiate_login_uri, OpenID Connect Core section 4) to /sso/<id>/start. " +
    "Core takes a GET there, not a POST. " +
    "If your provider has no such field, users start at the sign-in page of the app.",
  directory: "Any SCIM 2.0 client (RFC 7644) that sends a bearer token.",
};
