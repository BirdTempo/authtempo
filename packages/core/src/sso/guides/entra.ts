import type { IdpGuide } from "./index.js";

/**
 * Microsoft Entra ID. Each label comes from Microsoft Learn, read on
 * 2026-11-23:
 * - SAML: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso
 * - Certificate and tile: https://learn.microsoft.com/en-us/entra/identity/saas-apps/slack-tutorial
 *   and .../enterprise-apps/tutorial-manage-certificates-for-federated-single-sign-on
 * - OIDC: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app,
 *   .../identity-platform/how-to-add-redirect-uri, .../identity-platform/how-to-add-credentials
 * - Issuer: https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
 * - Homepage URL: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/application-properties
 * - SCIM: https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups
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
    { text: "Assign the users who sign in to the enterprise application." },
    { text: 'For SCIM, in "Enterprise apps", select the application, then "Provisioning".' },
    { text: 'For SCIM, select "New configuration".' },
    { text: 'For SCIM, enter the SCIM base URL in "Tenant URL".', value: "scimBaseUrl" },
    { text: 'For SCIM, paste the SCIM token in "Secret Token".', value: "scimToken" },
    { text: 'For SCIM, select "Test Connection".' },
  ],
  launch:
    'For SAML, enter /sso/<id>/start in "Sign on URL" of "Basic SAML Configuration". ' +
    "The My Apps tile then opens that URL. " +
    'For OIDC, set the "Homepage URL" of the application object to /sso/<id>/start. ' +
    "My Apps opens the Homepage URL. " +
    "The docs do not name the page of the app registration that holds this field.",
  directory:
    'Entra sends SCIM with a long-lived bearer token in "Secret Token". ' +
    "The docs list this token as supported for non-gallery apps. " +
    "The SCIM steps of the docs also show an OAuth client credentials grant, which core does not take.",
};
