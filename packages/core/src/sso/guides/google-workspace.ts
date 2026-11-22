import type { IdpGuide } from "./index.js";

/**
 * Google Workspace. Each label comes from the Google Workspace Admin Help,
 * read on 2026-11-23 (the page says "Last updated 2026-11-10 UTC"):
 * - SAML: https://knowledge.workspace.google.com/admin/apps/set-up-your-own-custom-saml-app
 *   (was https://support.google.com/a/answer/6087519)
 * - SCIM: https://knowledge.workspace.google.com/admin/users/advanced/automated-user-provisioning-with-custom-scim-profiles
 *   and .../admin/users/advanced/about-automated-user-provisioning
 *
 * No OIDC kind: a Google sign-in for an OIDC client is a Google Cloud
 * setup, not a Google Admin setup. This guide did not read those docs.
 */
export const googleWorkspace: IdpGuide = {
  id: "google-workspace",
  name: "Google Workspace",
  kinds: ["saml"],
  checkedOn: "2026-11-23",
  fields: {
    acsUrl: "ACS URL",
    entityId: "Entity ID",
    redirectUri: "",
    scimBaseUrl: "Endpoint URL",
    scimToken: "Access token",
  },
  steps: [
    { text: 'At admin.google.com, go to "Apps > Web and mobile apps".' },
    { text: 'Click "Add App > Add custom SAML app".' },
    { text: 'Enter the app name, then click "Continue".' },
    {
      text: 'On "Google Identity Provider details", download the IDP metadata for the setup page.',
    },
    { text: 'Click "Continue".' },
    { text: 'In "Service Provider Details", enter the ACS URL in "ACS URL".', value: "acsUrl" },
    { text: 'Enter the entity ID in "Entity ID".', value: "entityId" },
    { text: 'Keep "Start URL" empty.' },
    { text: 'Click "Continue", then click "Finish".' },
    { text: 'In "User access", turn the app on for the users who sign in.' },
    { text: 'For SCIM, under "Autoprovisioning", click "Configure auto-provisioning".' },
    { text: 'For SCIM, paste the SCIM token in "Access token".', value: "scimToken" },
    { text: 'For SCIM, enter the SCIM base URL in "Endpoint URL".', value: "scimBaseUrl" },
    { text: 'For SCIM, set the "Autoprovisioning" toggle to "Active".' },
  ],
  launch:
    "Gap: the docs show no way for the app launcher to open /sso/<id>/start. " +
    '"Start URL" only sets the RelayState. ' +
    "The docs test a tile with an IdP-initiated sign-in, and core refuses an unsolicited Response. " +
    "Users start at the sign-in page of the app.",
  directory:
    "Google sends SCIM to a custom SAML app only through a custom SCIM profile. " +
    "This is a beta for a limited number of participants. " +
    "Google takes a bearer token only.",
};
