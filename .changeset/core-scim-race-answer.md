---
"@authtempo/core": patch
---

A SCIM write that loses a race answers 409 in the SCIM error message with no `scimType`. The `detail` is "Another request changed this user at the same time. Send the request again." Before, the `detail` was the bare code `conflict`. On a store with a query limit per invocation, such as D1, a SCIM create can lose a claim race to another proof. An account delete during the write, or a lost lock of the user row, gives the same answer on any store. A resend can pass, so the directory sends the same request again. A value in use, such as the `userName` of another User, still answers 409 `uniqueness`.

Before, a SCIM write at the member limit answered the bare code `member_limit` as its `detail`. The new `detail` is "The organization is at its member limit."
