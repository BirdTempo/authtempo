---
"@authtempo/core": patch
---

The expiry notice reads the owners of an organization of exactly 100 members in full. Before, the sweep wrote a false `notice.mail_failed` with a `RangeError` for such an organization. A member or invitation act in an impersonation now writes the operator as the actor, with `data.platform: true`. The organization audit shows such an act as `platform`, with no IP and no user agent. Before, it showed the IP and the user agent of the operator as an act of the member.
