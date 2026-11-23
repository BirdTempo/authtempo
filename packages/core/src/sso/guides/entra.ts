import type { IdpGuide } from "./index.js";

/**
 * Microsoft Entra ID. Each label comes from Microsoft Learn, read on
 * 2026-11-23:
 * - SAML: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso
 * - SAML claims ("Attributes & Claims", "Choose name identifier format", "Persistent",
 *   "Add new claim", "Namespace", user.mail):
 *   https://learn.microsoft.com/en-us/entra/identity-platform/saml-claims-customization
 * - Certificate and tile: https://learn.microsoft.com/en-us/entra/identity/saas-apps/slack-tutorial
 *   and https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/tutorial-manage-certificates-for-federated-single-sign-on
 * - OIDC: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app,
 *   https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri,
 *   https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials
 * - The email claim ("Token configuration", "Add optional claim"):
 *   https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims and
 *   https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
 *   The second page says that an app "can request the email claim for managed users ... using the
 *   email optional claim", or the email scope. Core asks for the scope "openid email profile".
 * - Issuer: https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
 * - Homepage URL: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/application-properties
 * - SCIM: https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups
 *   Its table says of a long-lived bearer token: "Supported for existing apps and non-gallery apps.
 *   Not supported for new apps." It names the "Secret Token" field for that token. Its steps under
 *   "+ New configuration" show only the OAuth client credentials grant.
 */
export const entra: IdpGuide = {
  id: "entra",
  name: "Microsoft Entra ID",
  kinds: ["saml", "oidc"],
  checkedOn: "2026-11-23",
  fields: {
    acsUrl: "Reply URL (Assertion Consumer Service URL)",
    entityId: "Identifier (Entity ID)",
    redirectUri: "Redirect URI",
    scimBaseUrl: "Tenant URL",
    scimToken: "Secret Token",
  },
  steps: [
    { text: 'For SAML, browse to "Entra ID > Enterprise apps > All applications".' },
    { text: 'For SAML, select "New application > Create your own application".' },
    {
      text: 'For SAML, choose "integrate any other application you don\'t find in the gallery".',
    },
    { text: 'For SAML, in the "Manage" section, select "Single sign-on".' },
    { text: 'For SAML, select "SAML".' },
    { text: 'For SAML, select "Edit" in the "Basic SAML Configuration" section.' },
    { text: 'For SAML, enter the entity ID in "Identifier (Entity ID)".', value: "entityId" },
    {
      text: 'For SAML, enter the ACS URL in "Reply URL (Assertion Consumer Service URL)".',
      value: "acsUrl",
    },
    { text: 'For SAML, select "Edit" in the "Attributes & Claims" section.' },
    {
      text: 'For SAML, open the name identifier claim, and select "Persistent" in "Choose name identifier format".',
    },
    { text: 'For SAML, select "Add new claim", and enter email as the name of the claim.' },
    { text: 'For SAML, keep "Namespace" empty, and select user.mail as the source attribute.' },
    { text: 'For SAML, download "Certificate (Base64)" from the "SAML Certificates" section.' },
    {
      text: 'For SAML, copy "Login URL", "Microsoft Entra Identifier", and the certificate to the setup page.',
    },
    { text: 'For OIDC, browse to "Entra ID > App registrations".' },
    { text: 'For OIDC, select "New registration".' },
    {
      text: 'For OIDC, under "Supported account types", select "Single tenant only - <your tenant>".',
    },
    { text: 'For OIDC, under "Manage", select "Authentication".' },
    { text: 'For OIDC, select "Add Redirect URI", then the "Web" platform.' },
    { text: 'For OIDC, enter the redirect URI in "Redirect URI".', value: "redirectUri" },
    {
      text: 'For OIDC, select "Certificates & secrets > Client secrets > New client secret".',
    },
    {
      text: 'For OIDC, copy the "Application (client) ID" and the secret value to the setup page.',
    },
    {
      text: "For OIDC, enter https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0 as the issuer.",
    },
    { text: 'For OIDC, under "Manage", select "Token configuration".' },
    {
      text: 'For OIDC, select "Add optional claim", select the ID token type, then select email.',
    },
    {
      text: "For OIDC, make sure that each user who signs in has an email address in Entra.",
      // Unconfirmed: check on a real tenant (Task 15).
      unconfirmed: "The docs do not say what the claim holds for a user with no address.",
    },
    { text: "Assign the users who sign in to the enterprise application." },
    { text: 'For SCIM, in "Enterprise apps", select the application, then "Provisioning".' },
    { text: 'For SCIM, select "New configuration".' },
    { text: 'For SCIM, enter the SCIM base URL in "Tenant URL".', value: "scimBaseUrl" },
    {
      text: "For SCIM, choose the long-lived bearer token as the method of authentication.",
      // Unconfirmed: check on a real tenant (Task 15).
      unconfirmed: 'The docs do not show how "New configuration" offers this method.',
    },
    {
      text: 'For SCIM, paste the SCIM token in "Secret Token".',
      value: "scimToken",
      // Unconfirmed: check on a real tenant (Task 15).
      unconfirmed: 'The docs name "Secret Token", but not its place in "New configuration".',
    },
    { text: 'For SCIM, select "Test Connection".' },
  ],
  // Unconfirmed: check on a real tenant (Task 15).
  launchUnconfirmed: 'The docs do not name the page that holds "Homepage URL".',
  launch:
    'For SAML, enter /sso/<id>/start in "Sign on URL" of "Basic SAML Configuration". ' +
    "The My Apps tile then opens that URL. " +
    'For OIDC, set the "Homepage URL" of the application object to /sso/<id>/start. ' +
    "My Apps opens the Homepage URL. " +
    "The docs do not name the page of the app registration that holds this field.",
  directory:
    'Entra sends SCIM with a long-lived bearer token in "Secret Token". ' +
    'The docs say of this token: "Supported for existing apps and non-gallery apps. Not supported for new apps." ' +
    "The steps of the docs show only an OAuth client credentials grant, which core does not take. " +
    "Gap: the docs do not show where a new configuration offers the bearer token.",
};
