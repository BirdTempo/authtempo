# Sources of the Entra ID fixtures

Each file is one request of a Microsoft Learn page, read on 2026-10-22 with HTTP 200. A file holds `method`, `path`, `headers`, and `body`. The path drops the base of the page (`https://.../scim`, `~/scim`) and the text `HTTP/1.1`. The headers drop `Authorization`: the test sends its own SCIM token. A `path` of null means that the page gives the body only; the test sends it to the resource of its flow. The ids of the page stay as the page gives them; the test maps them to the ids that the server answers.

Page D: "Tutorial: Develop and plan provisioning for a SCIM endpoint in Microsoft Entra ID", https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups, fetched 2026-10-22T14:47:53Z, last updated 2026-09-15.

Page K: "Known issues and resolutions with SCIM 2.0 protocol compliance of the Microsoft Entra user provisioning service", https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility, fetched 2026-10-22T14:47:54Z, last updated 2025-08-25.

| File | Page | Section |
| --- | --- | --- |
| 01-create-user.json | D | User Operations, Create User |
| 02-get-user.json | D | User Operations, Get User |
| 03-get-user-not-found.json | D | User Operations, Get User (User not found) |
| 04-get-user-by-query.json | D | User Operations, Get User by query |
| 05-get-user-by-query-zero.json | D | User Operations, Get User by query - Zero results |
| 06-update-user-multi-valued.json | D | User Operations, Update User [Multi-valued properties] |
| 07-update-user-single-valued.json | D | User Operations, Update User [Single-valued properties] |
| 08-disable-user.json | D | Disable User |
| 09-delete-user.json | D | User Operations, Delete User |
| 10-create-group.json | D | Group Operations, Create Group |
| 11-get-group.json | D | Group Operations, Get Group |
| 12-get-group-by-display-name.json | D | Group Operations, Get Group by displayName |
| 13-update-group-name.json | D | Group Operations, Update Group [Non-member attributes] |
| 14-update-group-add-members.json | D | Update Group [Add Members] |
| 15-update-group-remove-members.json | D | Group Operations, Update Group [Remove Members] |
| 16-delete-group.json | D | Group Operations, Delete Group |
| 17-discover-schema.json | D | Schema discovery, Discover schema |
| 20-known-disable-user-without-flag.json | K | Flags to alter the SCIM behavior, requests made to disable users, without feature flag |
| 21-known-disable-user-with-flag.json | K | the same, with feature flag |
| 22-known-add-attribute-without-flag.json | K | requests made to add a single-value string attribute, without feature flag |
| 23-known-add-attribute-with-flag.json | K | the same, with feature flag |
| 24-known-replace-attributes-without-flag.json | K | requests to replace multiple attributes, without feature flag |
| 25-known-replace-attributes-with-flag.json | K | the same, with feature flag |
| 26-known-remove-member-without-flag.json | K | requests made to remove a group member, without feature flag |
| 27-known-remove-member-with-flag.json | K | the same, with feature flag |
| 30-example-1-query-user.json | D | Handling provisioning and deprovisioning of users, Example 1 |
| 31-example-2-provision-user.json | D | the same section, Example 2 |
| 32-example-3-get-user.json | D | the same section, Example 3 |
| 33-example-5-update-user.json | D | the same section, Example 5 |
| 34-example-6-delete-user.json | D | the same section, Example 6 |

Page D gives no request text for Example 4 (the manager check) and none for the member check of a group. It gives only the parsed parameters of Example 4. So no file holds them.
