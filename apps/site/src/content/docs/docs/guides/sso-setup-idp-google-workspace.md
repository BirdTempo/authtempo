---
title: Set up Google Workspace for an SSO setup link
description: The steps in Google Workspace for the IT admin of a customer, read from the Google Workspace docs on 2026-11-23.
type: how-to
sources:
  - packages/core/src/sso/guides/google-workspace.ts
  - packages/core/src/sso/guides/index.ts
---

**For:** the IT admin of a customer who sets up SSO in Google Workspace through a setup link.

**What it does:** this page gives the steps in Google Workspace for SAML. It is the guide that the setup page shows. The guide was read from the Google Workspace docs on 2026-11-23.

## Before you start

- A setup link from the owner of the organization. Read [Set up SSO with a setup link](/docs/guides/sso-setup-link/) for the steps of the link.

## What was checked

Checked on: 2026-11-23. A person read the Google Workspace docs on that day. Google Workspace can change its admin pages after that day. The release check of authtempo fails when a guide is older than 180 days.

No label in this guide was checked on a real tenant. A step with an Unconfirmed mark is a step whose label the docs do not confirm. Check that label in your own tenant before you rely on it.

## The labels in Google Workspace

| Value | Label |
| --- | --- |
| ACS URL | "ACS URL" |
| SP entity ID | "Entity ID" |
| redirect URI | none, Google Workspace has no field for it |
| SCIM base URL | "Endpoint URL" |
| SCIM token | "Access token" |

## Steps

1. At admin.google.com, go to "Apps > Web and mobile apps".
2. Click "Add App > Add custom SAML app".
3. Enter the app name, then click "Continue".
4. On "Google Identity Provider details", download the provider metadata for the setup page.
5. Click "Continue".
6. In "Service Provider Details", enter the ACS URL in "ACS URL". The setup page shows the ACS URL.
7. Enter the entity ID in "Entity ID". The setup page shows the SP entity ID.
8. Keep "Start URL" empty.
9. Set "Name ID format" to the persistent format. **Unconfirmed:** The docs do not give the label of the persistent option.
10. Click "Continue".
11. Click "Add mapping", and select the primary email in "Google Directory attributes".
12. Enter email as the name of the attribute in "App attributes".
13. Click "Finish".
14. In "User access", turn the app on for the users who sign in.
15. For SCIM, under "Autoprovisioning", click "Configure auto-provisioning".
16. For SCIM, paste the SCIM token in "Access token". The setup page shows the SCIM token one time.
17. For SCIM, enter the SCIM base URL in "Endpoint URL". The setup page shows the SCIM base URL.
18. For SCIM, set the "Autoprovisioning" toggle to "Active".

## Start a sign-in from the app tile

Gap: the docs show no way for the app launcher to open `/sso/<id>/start`. "Start URL" only sets the RelayState. The docs test a tile with a provider-initiated sign-in, and core refuses an unsolicited Response. Users start at the sign-in page of the app.

## Directory sync with SCIM

Google sends SCIM to a custom SAML app only through a custom SCIM profile. This is a beta for a limited number of participants. Google takes a bearer token only.

## If it fails

- A failed test run names the step that failed on the setup page. Read that step, then check the label in your tenant.
- A link ends at its time, at a revoke, and at an activation. Ask the owner of the organization for a new link.

## Next

- [Set up SSO with a setup link](/docs/guides/sso-setup-link/)
- [Setup link reference](/docs/reference/sso-setup/)
