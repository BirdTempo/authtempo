---
"@authtempo/core": minor
---

Add the route `GET /organizations/audit`. A member with the permission `audit:read` reads the audit rows of the organization, oldest first. The owner of the `ranks` form has the permission. A role of the `roles` form has it only when the app lists it. The query takes `organizationId`, `after`, `limit`, `action`, `from`, and `to`. The route takes a session only, so an organization token gets 401. Each row shows the actor as `member`, `platform`, `scim`, or `app`. Only a member row shows the IP and the user agent. A row from before schema version 18 is not in the answer. `GET /operator/audit` and `auth.api.operator.audit.list` now take `organizationId`.
