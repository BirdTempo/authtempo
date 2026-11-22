---
title: Set up Okta for an SSO setup link
description: The steps in Okta for the IT admin of a customer, read from the Okta docs on 2026-11-23.
type: how-to
sources:
  - packages/core/src/sso/guides/okta.ts
  - packages/core/src/sso/guides/index.ts
---

**For:** the IT admin of a customer who sets up SSO in Okta through a setup link.

**What it does:** this page gives the steps in Okta for SAML and OIDC. It is the guide that the setup page shows. The guide was read from the Okta docs on 2026-11-23.

## Before you start

- A setup link from the owner of the organization. Read [Set up SSO with a setup link](/docs/guides/sso-setup-link/) for the steps of the link.

## What was checked

Checked on: 2026-11-23. A person read the Okta docs on that day. Okta can change its admin pages after that day. The release check of authtempo fails when a guide is older than 180 days.

No label in this guide was checked on a real tenant. A step with an Unconfirmed mark is a step whose label the docs do not confirm. Check that label in your own tenant before you rely on it.

## The labels in Okta

| Value | Label |
| --- | --- |
| ACS URL | "Single sign-on URL" |
| SP entity ID | "Audience URI (SP Entity ID)" |
| redirect URI | "Sign-in redirect URIs" |
| SCIM base URL | "SCIM connector base URL" |
| SCIM token | "Authorization" |

## Steps

1. In the Admin Console, go to "Applications and Resources > Applications".
2. Click "Create App Integration".
3. Select "Classic experience".
4. For SAML, select "SAML 2.0" as the "Sign-in method".
5. For SAML, enter the ACS URL in "Single sign-on URL". The setup page shows the ACS URL.
6. For SAML, enter the entity ID in "Audience URI (SP Entity ID)". The setup page shows the SP entity ID.
7. For SAML, set "Name ID format" to the persistent format. **Unconfirmed:** The docs do not list the options of "Name ID format".
8. For SAML, in "Attribute Statements (optional)", add an attribute with the "Name" email.
9. For SAML, enter user.email in the "Value" of the email attribute.
10. For SAML, on the "Sign On" tab, click "View SAML setup instructions".
11. For SAML, copy the values of "Metadata details" to the setup page.
12. For OIDC, select "OIDC - OpenID Connect" as the "Sign-in method".
13. For OIDC, select "Web Application" as the type of app.
14. For OIDC, enter the redirect URI in "Sign-in redirect URIs". The setup page shows the redirect URI.
15. For OIDC, copy the "Client ID" and the "Client secret" to the setup page.
16. For OIDC, enter the base URL of your Okta org as the issuer on the setup page.
17. Assign the app integration to the users who sign in.
18. For SCIM, on the "General" tab, select "SCIM" in the "Provisioning" field.
19. For SCIM, on the "Provisioning" tab, enter the SCIM base URL in "SCIM connector base URL". The setup page shows the SCIM base URL.
20. For SCIM, set "Authentication Mode" to "HTTP Header".
21. For SCIM, paste the SCIM token in "Authorization". The setup page shows the SCIM token one time. **Unconfirmed:** The docs do not say if Okta adds "Bearer " to this field.

## Start a sign-in from the app tile

For SAML, set "Do not display application icon to users" on the SAML app. Then add a Bookmark App with the URL `/sso/<id>/start`. For OIDC, set "Login initiated by" to "Either Okta or App". Set "Initiate login URI" to `/sso/<id>/start`. In "Login flow", choose the redirect option, not "Send ID Token directly to app (Okta Simplified)". Core refuses an ID token that it did not request. The docs do not give the label of the redirect option.

**Unconfirmed:** The docs name the "Login flow" choice, but they do not give the label of the option that redirects to "Initiate login URI".

## Directory sync with SCIM

Okta sends SCIM from a SAML integration of the Classic experience. The docs say that Okta sends no SCIM from an OIDC integration of the Classic experience. The token goes in the "Authorization" field of the "HTTP Header" mode. Core reads only "Authorization: Bearer `<token>`". The docs do not say if Okta adds "Bearer " to the field.

## If it fails

- A failed test run names the step that failed on the setup page. Read that step, then check the label in your tenant.
- A link ends at its time, at a revoke, and at an activation. Ask the owner of the organization for a new link.

## Next

- [Set up SSO with a setup link](/docs/guides/sso-setup-link/)
- [Setup link reference](/docs/reference/sso-setup/)
