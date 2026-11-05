---
"@authtempo/compat-better-auth": minor
---

Compat migration 0013 serves core's schema version 16. It adds `taProved` to Better Auth's `session` table, NOT NULL with the default false. Then it sets true on each session whose user has a verified address. A placeholder address of Better Auth counts as no address. A session of a user with no address, or with an unverified address, reads false. A user with no address signs in again for verified powers. A user with an unverified address proves it first. The fill also sets true on a session that Better Auth made before the proof of the address. Better Auth 1.7.2 and 1.7.7, read 2026-11-04, end no session when the email verification link proves an address. So the fill makes no session stronger than before.

Apply 0013 before you deploy core at version 16. After 0013, a session that a Worker of core 15 writes for a verified user ends at its next use, so the person signs in again. Tables with other names take the text of the new export `compatMigration0013Sql`.
