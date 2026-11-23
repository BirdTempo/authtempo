import type { IdpGuide } from "./index.js";

/**
 * Any SAML 2.0 IdP. No provider has these labels, so they are the names of
 * the standards, read on 2026-11-23:
 * - SAML metadata (AssertionConsumerService, entityID):
 *   https://docs.oasis-open.org/security/saml/v2.0/saml-metadata-2.0-os.pdf
 * - Unsolicited Responses, section 4.1.5:
 *   https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf
 * - SCIM base URI and bearer tokens: https://www.rfc-editor.org/rfc/rfc7644.html
 */
export const genericSaml: IdpGuide = {
  id: "generic-saml",
  name: "Generic SAML 2.0",
  kinds: ["saml"],
  checkedOn: "2026-11-23",
  fields: {
    acsUrl: "Assertion Consumer Service (ACS) URL",
    entityId: "SP entity ID (Audience)",
    redirectUri: "",
    scimBaseUrl: "SCIM base URL",
    scimToken: "Bearer token",
  },
  steps: [
    { text: "Create a SAML 2.0 app in your IdP." },
    {
      text: 'Enter the ACS URL in "Assertion Consumer Service (ACS) URL" for HTTP-POST.',
      value: "acsUrl",
    },
    { text: 'Enter the entity ID in "SP entity ID (Audience)".', value: "entityId" },
    { text: "If your IdP reads SP metadata, give it the entity ID URL as the metadata URL." },
    { text: "Send a persistent NameID, and send the address in an attribute with the name email." },
    { text: "Sign the assertion or the response." },
    { text: "Copy the IdP metadata XML to the setup page." },
    { text: 'For SCIM, enter the SCIM base URL in "SCIM base URL".', value: "scimBaseUrl" },
    {
      text: 'For SCIM, send the SCIM token as the "Bearer token" in the Authorization header.',
      value: "scimToken",
    },
  ],
  launch:
    "Make the tile of your IdP open /sso/<id>/start. " +
    "Core refuses an unsolicited Response (SAML profiles, section 4.1.5). " +
    "If your IdP has no tile that opens a URL, users start at the sign-in page of the app.",
  directory: "Any SCIM 2.0 client (RFC 7644) that sends a bearer token.",
};
