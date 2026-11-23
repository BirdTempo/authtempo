---
"@authtempo/client": minor
---

Add `client.organizations.audit.list` and `client.organizations.audit.export`. The list reads one page of `GET /organizations/audit` and answers `{ rows, next }`. Pass `next` as `after` to read the page after it. The export is an async iterator over every row of the query. It reads one page of 100 rows for each request and holds one page at a time. A caller that stops early sends no more requests. A failed page throws its `ClientFailure` after the rows of the pages before it. The new types are `OrganizationAuditView` and `OrganizationAuditQuery`.

`client.sso.connections.list` now answers `SsoConnectionListedJSON[]`: each connection with its `status`, as `GET /sso/connections` answers it.
