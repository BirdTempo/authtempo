# Sources of the Okta fixtures

Each file is one request of the Okta page "Okta and SCIM Version 2.0" (the SCIM 2.0 protocol reference), https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/, fetched 2026-10-22T14:47:54Z with HTTP 200, last updated 2026-09-18. A file holds `method`, `path`, `headers`, and `body`. The path drops the base `/scim/v2` and the text `HTTP/1.1`. The headers drop `Authorization`: the test sends its own SCIM token. The ids of the page stay as the page gives them; the test maps them to the ids that the server answers.

The pages "Build your SCIM API service" and "Build a SCIM provisioning integration overview" (developer.okta.com, fetched 2026-10-22T14:47:56Z and 14:48:09Z, HTTP 200) give no request example.

| File | Section |
| --- | --- |
| 01-list-users-at-setup.json | SCIM user operations, Create users (the first request after the save) |
| 02-list-groups-at-setup.json | the same (the second request, with Import Groups on) |
| 03-find-user.json | Create users, Determine if the user already exists |
| 04-create-user.json | Create users, Create the user (the first request) |
| 05-create-user-custom-attributes.json | Create users, Create the user (the request with custom attributes) |
| 06-list-users.json | Retrieve users |
| 07-get-user.json | Retrieve a specific user |
| 08-replace-user.json | Update a specific user (PUT), Update the user |
| 09-deactivate-user.json | Update a specific user (PATCH) |
| 10-create-group.json | SCIM group operations, Create groups |
| 11-list-groups.json | Retrieve groups (the page request) |
| 12-find-group.json | Retrieve groups (the request with a displayName filter) |
| 13-get-group.json | Retrieve specific groups |
| 14-rename-group-patch.json | Update a specific group name, PATCH method request |
| 15-rename-group-put.json | Update a specific group name, PUT method request |
| 16-update-members-patch.json | Update specific group membership (the PATCH request) |
| 17-update-members-put.json | Update specific group membership (the PUT request) |
| 18-replace-members-patch.json | Update specific group membership (the replace of the full membership) |
| 19-delete-group.json | Delete a specific group |

Okta sends no DELETE of a User ("Delete users"): a deactivate is a PATCH or a PUT of `active` false.
