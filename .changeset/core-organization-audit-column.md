---
"@authtempo/core": minor
---

Each SSO and SCIM audit row now names its organization in the column `organizationId`. The rows of a connection, a domain, a setup link, a test run, a SCIM token, and a SCIM user or group get it. `data.organizationId` stays in each row. A row of a platform operator holds `data.platform: true`. The override `enforceOff` names the organization too. An operator act on a user names no organization. The first hand back of a setup link now writes one `sso_setup_link_ready` audit row. A second hand back writes none.
