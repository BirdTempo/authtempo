---
"@authtempo/compat-better-auth": minor
---

Compat migration 0013 serves core's schema version 16. It adds `taProved` to Better Auth's `session` table, NOT NULL with the default false. Then it sets true on each session whose user has a verified address. A placeholder address of Better Auth counts as no address. A session of a user with no address, or with an unverified address, reads false. That user signs in again for verified powers.

Apply 0013 before you deploy core at version 16. Tables with other names take the text of the new export `compatMigration0013Sql`.
