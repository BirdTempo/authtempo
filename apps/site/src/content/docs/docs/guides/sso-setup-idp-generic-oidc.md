---
title: Set up Generic OpenID Connect for an SSO setup link
description: The steps in Generic OpenID Connect for the IT admin of a customer, read from the Generic OpenID Connect docs on 2026-11-23.
type: how-to
sources:
  - packages/core/src/sso/guides/generic-oidc.ts
  - packages/core/src/sso/guides/index.ts
---

**For:** the IT admin of a customer who sets up SSO in Generic OpenID Connect through a setup link.

**What it does:** this page gives the steps in Generic OpenID Connect for OIDC. It is the guide that the setup page shows. The guide was read from the Generic OpenID Connect docs on 2026-11-23.

## Before you start

- A setup link from the owner of the organization. Read [Set up SSO with a setup link](/docs/guides/sso-setup-link/) for the steps of the link.

## What was checked

Checked on: 2026-11-23. A person read the Generic OpenID Connect docs on that day. Generic OpenID Connect can change its admin pages after that day. The release check of authtempo fails when a guide is older than 180 days.

No label in this guide was checked on a real tenant. A step with an Unconfirmed mark is a step whose label the docs do not confirm. Check that label in your own tenant before you rely on it.

## The labels in Generic OpenID Connect

| Value | Label |
| --- | --- |
| ACS URL | none, Generic OpenID Connect has no field for it |
| SP entity ID | none, Generic OpenID Connect has no field for it |
| redirect URI | "Redirect URI (redirect_uri)" |
| SCIM base URL | "SCIM base URL" |
| SCIM token | "Bearer token" |

## Steps

1. Create a confidential web client in your OpenID Provider.
2. Enter the redirect URI in "Redirect URI (redirect_uri)". The setup page shows the redirect URI.
3. Allow the authorization code flow for the client.
4. Make sure that the ID token holds the "email" claim.
5. Copy the issuer URL, the client ID, and the client secret to the setup page.
6. For SCIM, enter the SCIM base URL in "SCIM base URL". The setup page shows the SCIM base URL.
7. For SCIM, send the SCIM token as the "Bearer token" in the Authorization header. The setup page shows the SCIM token one time.

## Start a sign-in from the app tile

Set the sign-in initiation endpoint (initiate_login_uri, OpenID Connect Core section 4) to `/sso/<id>/start`. Core takes a GET there, not a POST. If your provider has no such field, users start at the sign-in page of the app.

## Directory sync with SCIM

Any SCIM 2.0 client (RFC 7644) that sends a bearer token.

## If it fails

- A failed test run names the step that failed on the setup page. Read that step, then check the label in your tenant.
- A link ends at its time, at a revoke, and at an activation. Ask the owner of the organization for a new link.

## Next

- [Set up SSO with a setup link](/docs/guides/sso-setup-link/)
- [Setup link reference](/docs/reference/sso-setup/)
