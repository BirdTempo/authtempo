---
"@authtempo/core": patch
---

A SCIM write that stops with the code `conflict` answers 409 in the SCIM error message with no `scimType`. The `detail` is "Another request changed this resource at the same time. Send the request again." Before, the `detail` was the bare code `conflict`. A lost claim, an account delete of the user during the write, and a lost lock of the user row stop with this code. On a store with a query limit per invocation, such as D1, a SCIM create can lose a claim race to another proof. A resend can pass, so the directory sends the same request again. A write that loses each of its rounds keeps its own `detail`. A value in use, such as the `userName` of another User, still answers 409 `uniqueness`.

Before, a SCIM write at the member limit answered the bare code `member_limit` as its `detail`. The new `detail` is "The organization is at its member limit."
