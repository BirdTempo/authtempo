# The supplier advisory record

This file is a record, and it is append-only (spec 33 items 3 and 7). Each advisory that the owner reads is one entry: a runtime dependency of a released package, or Better Auth in the range of the compat package. A new entry goes at the end. Do not edit an old entry. A correction is a new entry that names the old one. `check-records` fails when the text at the merge base of `main` is not the start of this file.

Each entry states the advisory, the dates of each read, the text that the owner read, whether the advisory affects authtempo and why, and the fix for an app.

## 2026-10-14: Better Auth 1.7.7, a magic link takeover

- Advisory: GHSA-965c-763c-88jm. VulnCheck gives it CVE-2026-110862.
- Read: 2026-10-14 in the Better Auth changelog (v1.7.7, 2026-09-30). Read again on 2026-10-21 in the GitHub advisory and the VulnCheck advisory.
- Text read on 2026-10-21: "better-auth: OAuth state can be used as a Magic Link to sign in as another user". Affected: `better-auth` from 1.4.0-beta.18 to below 1.7.7. Fixed in 1.7.7, published 2026-09-30. Severity: critical, CVSS 3.1 9.1 (GitHub), CVSS 4.0 9.3 (VulnCheck). Weakness: CWE-287. The flaw: Better Auth accepts the state value of an OAuth sign-in as a magic link token. An attacker who knows an address gets a session for that account. When no account exists, the attacker gets a new account with a verified email.
- Affects authtempo: no. Core reads a verification row by its hash and its purpose. The magic link verify consumes only a row with the purpose `magic-link` (`packages/core/src/engine/magic-link.ts`, line 94, and `packages/core/src/engine/verification.ts`, line 36). So the state of a social sign-in never opens a magic link session. Core spends a magic link token once, by one conditional update (spec 8.2 item 4). The compat package runs no Better Auth code.
- The fix for an app on Better Auth: upgrade to 1.7.7 or later before the move (spec 23 item 12).

## 2026-10-14: CVE-2026-67327, an account hijack before the account exists

- Advisory: CVE-2026-67327, GitHub advisory GHSA-qq9h-g4jm-xgf3.
- Read: 2026-10-14 by a search for the 1.7.7 fix. Read again on 2026-10-21 in the GitHub advisory and the OSV record.
- Text read on 2026-10-21: "better-auth: Attacker's password keeps working after magic link or email OTP sign-in". Affected: `better-auth` from 1.1.3 to below 1.6.22, and from 1.7.0-beta.0 to below 1.7.0-beta.10, with the magic link or email OTP plugin and an open email and password sign-up. Fixed in 1.6.22 and 1.7.0-beta.10. Severity: high, CVSS 3.1 8.3 (GitHub), CVSS 4.0 8.7 (OSV). Weakness: CWE-287 and CWE-345. The flaw: an attacker signs up with the address of a victim and a password of the attacker. The account stays unverified. The magic link or email OTP sign-in of the victim then marks the email verified, and the password of the attacker stays valid.
- Affects authtempo: no. The claim rule of spec 8.2 item 5 runs when a magic link or an email code proves the address of an unverified user. It deletes each password row, each session, each other identity, and each passkey of that user (`claimEmail` in `packages/core/src/engine/users.ts`, lines 157 to 176). So no password of the claimant stays. The compat package runs no Better Auth code.
- The fix for an app on Better Auth: upgrade to 1.7.7 or later before the move (spec 23 item 12). 1.7.7 is above both fixed versions.
