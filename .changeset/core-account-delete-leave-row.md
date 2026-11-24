---
"@authtempo/core": minor
---

A self account delete (`POST /user/delete` and the mailed confirm) now writes one `organization_member_remove` audit row in each organization that the user leaves. The owner of the organization sees it in the organization audit. The row holds the role, `self: true`, and `accountDelete: true` in `data`. It holds no IP and no user agent. An organization that goes with the account and the platform organization get no row. An operator delete of a user writes no such row. The rows go in the same transaction as the delete, so an insert that fails keeps the user and the member rows. On D1 one insert writes all the rows, and it costs 1 query of the 50 of one invocation. So with a solo organization, the self delete and the mailed confirm each take 2 organizations that the user owns with another owner. With no solo organization, each takes 5. The limits of a secret and of a platform operator do not change.
