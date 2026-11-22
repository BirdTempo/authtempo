---
title: Set up Generic SAML 2.0 for an SSO setup link
description: The steps in Generic SAML 2.0 for the IT admin of a customer, read from the Generic SAML 2.0 docs on 2026-11-23.
type: how-to
sources:
  - packages/core/src/sso/guides/generic-saml.ts
  - packages/core/src/sso/guides/index.ts
---

**For:** the IT admin of a customer who sets up SSO in Generic SAML 2.0 through a setup link.

**What it does:** this page gives the steps in Generic SAML 2.0 for SAML. It is the guide that the setup page shows. The guide was read from the Generic SAML 2.0 docs on 2026-11-23.

## Before you start

- A setup link from the owner of the organization. Read [Set up SSO with a setup link](/docs/guides/sso-setup-link/) for the steps of the link.

## What was checked

Checked on: 2026-11-23. A person read the Generic SAML 2.0 docs on that day. Generic SAML 2.0 can change its admin pages after that day. The release check of authtempo fails when a guide is older than 180 days.

No label in this guide was checked on a real tenant. A step with an Unconfirmed mark is a step whose label the docs do not confirm. Check that label in your own tenant before you rely on it.

## The labels in Generic SAML 2.0

| Value | Label |
| --- | --- |
| ACS URL | "Assertion Consumer Service (ACS) URL" |
| SP entity ID | "SP entity ID (Audience)" |
| redirect URI | none, Generic SAML 2.0 has no field for it |
| SCIM base URL | "SCIM base URL" |
| SCIM token | "Bearer token" |

## Steps

1. Create a SAML 2.0 app in your provider.
2. Enter the ACS URL in "Assertion Consumer Service (ACS) URL" for HTTP-POST. The setup page shows the ACS URL.
3. Enter the entity ID in "SP entity ID (Audience)". The setup page shows the SP entity ID.
4. If your provider reads SP metadata, give it the entity ID URL as the metadata URL.
5. Send a persistent NameID, and send the address in an attribute with the name email.
6. Sign the assertion or the response.
7. Copy the provider metadata XML to the setup page.
8. For SCIM, enter the SCIM base URL in "SCIM base URL". The setup page shows the SCIM base URL.
9. For SCIM, send the SCIM token as the "Bearer token" in the Authorization header. The setup page shows the SCIM token one time.

## Start a sign-in from the app tile

Make the tile of your provider open `/sso/<id>/start`. Core refuses an unsolicited Response (SAML profiles, section 4.1.5). If your provider has no tile that opens a URL, users start at the sign-in page of the app.

## Directory sync with SCIM

Any SCIM 2.0 client (RFC 7644) that sends a bearer token.

## If it fails

- A failed test run names the step that failed on the setup page. Read that step, then check the label in your tenant.
- A link ends at its time, at a revoke, and at an activation. Ask the owner of the organization for a new link.

## Next

- [Set up SSO with a setup link](/docs/guides/sso-setup-link/)
- [Setup link reference](/docs/reference/sso-setup/)
