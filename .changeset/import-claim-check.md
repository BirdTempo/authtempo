---
"@authtempo/import": patch
---

An import of a new unverified user now runs core's claim check after its password or identity write. A repair of an unverified user runs it before it activates the password. On D1 a claim deletes the claimant's rows before it marks the address verified. So the new user had no check, and the repair's check of the user row alone missed such a claim. When the check finds a claim, the import deletes the rows that it wrote. The record is then `partial` with `not repaired: claimed`. The password row of a new unverified user is pending until the check passes, as in a repair.

On D1 the import of a new unverified user sends five more queries with a password, and three more with an identity. A repair of an unverified user sends three more. A verified user sends none more.
