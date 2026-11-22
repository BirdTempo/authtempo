---
title: Set up Microsoft Entra ID for an SSO setup link
description: The steps in Microsoft Entra ID for the IT admin of a customer, read from the Microsoft Entra ID docs on 2026-11-23.
type: how-to
sources:
  - packages/core/src/sso/guides/entra.ts
  - packages/core/src/sso/guides/index.ts
---

**For:** the IT admin of a customer who sets up SSO in Microsoft Entra ID through a setup link.

**What it does:** this page gives the steps in Microsoft Entra ID for SAML and OIDC. It is the guide that the setup page shows. The guide was read from the Microsoft Entra ID docs on 2026-11-23.

## Before you start

- A setup link from the owner of the organization. Read [Set up SSO with a setup link](/docs/guides/sso-setup-link/) for the steps of the link.

## What was checked

Checked on: 2026-11-23. A person read the Microsoft Entra ID docs on that day. Microsoft Entra ID can change its admin pages after that day. The release check of authtempo fails when a guide is older than 180 days.

No label in this guide was checked on a real tenant. A step with an Unconfirmed mark is a step whose label the docs do not confirm. Check that label in your own tenant before you rely on it.

## The labels in Microsoft Entra ID

| Value | Label |
| --- | --- |
| ACS URL | "Reply URL (Assertion Consumer Service URL)" |
| SP entity ID | "Identifier (Entity ID)" |
| redirect URI | "Redirect URI" |
| SCIM base URL | "Tenant URL" |
| SCIM token | "Secret Token" |

## Steps

1. For SAML, browse to "Entra ID > Enterprise apps > All applications".
2. For SAML, select "New application > Create your own application".
3. For SAML, choose "integrate any other application you don't find in the gallery".
4. For SAML, in the "Manage" section, select "Single sign-on".
5. For SAML, select "SAML".
6. For SAML, select "Edit" in the "Basic SAML Configuration" section.
7. For SAML, enter the entity ID in "Identifier (Entity ID)". The setup page shows the SP entity ID.
8. For SAML, enter the ACS URL in "Reply URL (Assertion Consumer Service URL)". The setup page shows the ACS URL.
9. For SAML, select "Edit" in the "Attributes & Claims" section.
10. For SAML, open the name identifier claim, and select "Persistent" in "Choose name identifier format".
11. For SAML, select "Add new claim", and enter email as the name of the claim.
12. For SAML, keep "Namespace" empty, and select user.mail as the source attribute.
13. For SAML, download "Certificate (Base64)" from the "SAML Certificates" section.
14. For SAML, copy "Login URL", "Microsoft Entra Identifier", and the certificate to the setup page.
15. For OIDC, browse to "Entra ID > App registrations".
16. For OIDC, select "New registration".
17. For OIDC, under "Supported account types", select "Single tenant only - `<your tenant>`".
18. For OIDC, under "Manage", select "Authentication".
19. For OIDC, select "Add Redirect URI", then the "Web" platform.
20. For OIDC, enter the redirect URI in "Redirect URI". The setup page shows the redirect URI.
21. For OIDC, select "Certificates & secrets > Client secrets > New client secret".
22. For OIDC, copy the "Application (client) ID" and the secret value to the setup page.
23. For OIDC, enter `https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0` as the issuer.
24. For OIDC, under "Manage", select "Token configuration".
25. For OIDC, select "Add optional claim", select the ID token type, then select email.
26. For OIDC, make sure that each user who signs in has an email address in Entra. **Unconfirmed:** The docs do not say what the claim holds for a user with no address.
27. Assign the users who sign in to the enterprise application.
28. For SCIM, in "Enterprise apps", select the application, then "Provisioning".
29. For SCIM, select "New configuration".
30. For SCIM, enter the SCIM base URL in "Tenant URL". The setup page shows the SCIM base URL.
31. For SCIM, choose the long-lived bearer token as the method of authentication. **Unconfirmed:** The docs do not show how "New configuration" offers this method.
32. For SCIM, paste the SCIM token in "Secret Token". The setup page shows the SCIM token one time. **Unconfirmed:** The docs name "Secret Token", but not its place in "New configuration".
33. For SCIM, select "Test Connection".

## Start a sign-in from the app tile

For SAML, enter `/sso/<id>/start` in "Sign on URL" of "Basic SAML Configuration". The My Apps tile then opens that URL. For OIDC, set the "Homepage URL" of the application object to `/sso/<id>/start`. My Apps opens the Homepage URL. The docs do not name the page of the app registration that holds this field.

**Unconfirmed:** The docs do not name the page that holds "Homepage URL".

## Directory sync with SCIM

Entra sends SCIM with a long-lived bearer token in "Secret Token". The docs say of this token: "Supported for existing apps and non-gallery apps. Not supported for new apps." The steps of the docs show only an OAuth client credentials grant, which core does not take. Gap: the docs do not show where a new configuration offers the bearer token.

## If it fails

- A failed test run names the step that failed on the setup page. Read that step, then check the label in your tenant.
- A link ends at its time, at a revoke, and at an activation. Ask the owner of the organization for a new link.

## Next

- [Set up SSO with a setup link](/docs/guides/sso-setup-link/)
- [Setup link reference](/docs/reference/sso-setup/)
