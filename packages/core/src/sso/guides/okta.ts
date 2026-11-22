import type { IdpGuide } from "./index.js";

/**
 * Okta (Identity Engine). Each label comes from the Okta docs, read on
 * 2026-11-23:
 * - SAML: https://help.okta.com/oie/en-us/content/topics/apps/apps_app_integration_wizard_saml.htm
 *   and its field reference .../apps/aiw-saml-reference.htm
 * - IdP values: .../apps/manage-signing-certificates.htm
 * - OIDC: .../apps/apps_app_integration_wizard_oidc.htm
 * - Issuer: https://developer.okta.com/docs/concepts/auth-servers/
 * - SCIM: .../apps/apps_app_integration_wizard_scim.htm
 * - Tile: .../apps/apps_bookmark_app.htm
 */
export const okta: IdpGuide = {
  id: "okta",
  name: "Okta",
  kinds: ["saml", "oidc"],
  checkedOn: "2026-11-23",
  fields: {
    acsUrl: "Single sign-on URL",
    entityId: "Audience URI (SP Entity ID)",
    redirectUri: "Sign-in redirect URIs",
    scimBaseUrl: "SCIM connector base URL",
    scimToken: "Authorization",
  },
  steps: [
    { text: 'In the Admin Console, go to "Applications and Resources > Applications".' },
    { text: 'Click "Create App Integration".' },
    { text: 'Select "Classic experience".' },
    { text: 'For SAML, select "SAML 2.0" as the "Sign-in method".' },
    { text: 'For SAML, enter the ACS URL in "Single sign-on URL".', value: "acsUrl" },
    { text: 'For SAML, enter the entity ID in "Audience URI (SP Entity ID)".', value: "entityId" },
    { text: 'For SAML, on the "Sign On" tab, click "View SAML setup instructions".' },
    { text: 'For SAML, copy the values of "Metadata details" to the setup page.' },
    { text: 'For OIDC, select "OIDC - OpenID Connect" as the "Sign-in method".' },
    { text: 'For OIDC, select "Web Application" as the type of app.' },
    {
      text: 'For OIDC, enter the redirect URI in "Sign-in redirect URIs".',
      value: "redirectUri",
    },
    { text: 'For OIDC, copy the "Client ID" and the "Client secret" to the setup page.' },
    { text: "For OIDC, enter the base URL of your Okta org as the issuer on the setup page." },
    { text: "Assign the app integration to the users who sign in." },
    { text: 'For SCIM, on the "General" tab, select "SCIM" in the "Provisioning" field.' },
    {
      text: 'For SCIM, on the "Provisioning" tab, enter the SCIM base URL in "SCIM connector base URL".',
      value: "scimBaseUrl",
    },
    { text: 'For SCIM, set "Authentication Mode" to "HTTP Header".' },
    { text: 'For SCIM, paste the SCIM token in "Authorization".', value: "scimToken" },
  ],
  launch:
    'For SAML, set "Do not display application icon to users" on the SAML app. ' +
    "Then add a Bookmark App with the URL /sso/<id>/start. " +
    'For OIDC, set "Login initiated by" to "Either Okta or App". ' +
    'Set "Initiate login URI" to /sso/<id>/start. ' +
    'Do not use "Send ID Token directly to app (Okta Simplified)": core refuses a token that it did not request.',
  directory:
    "Okta sends SCIM from a SAML integration of the Classic experience. " +
    "It sends no SCIM from an OIDC integration of the Classic experience. " +
    'The token goes in the "Authorization" field of the "HTTP Header" mode.',
};
