---
"@authtempo/core": minor
---

Store the certificate end and the status of each SSO connection. A SAML connection now keeps `certificateEndsAt`, the latest `notAfter` of its certificates. An OIDC connection keeps null. A new certificate set clears `expiryStage` and sets a new `expiryNoticeAt`. A draft gets its notice date when the activation writes the connection.

A SCIM token with an end and a setup link get their first notice date at create. A row from before version 18 gets its dates at its first sign-in or SCIM call.

The `status` of each connection in `GET /sso/connections` now holds the stored values: `lastSuccessAt`, `lastFailureAt`, `lastFailureStep`, `certificateEndsAt`, and `expiryStage`. A sign-in writes each time at most once an hour. A test run writes no status. A status write that fails does not stop the sign-in. It emits the new event `sso.status_write_failed`.

The events `sso.failed`, `sso.denied`, and `sso.refused` now name `organizationId` when the connection is known. Their default log lines do not change. The setup page shows the certificate end of a SAML draft.
