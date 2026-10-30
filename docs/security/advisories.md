# The supplier advisory record

This file is a record, and it is append-only (spec 33 items 3 and 7). Each advisory that the owner reads is one entry. An advisory comes from a runtime dependency of a released package, or from Better Auth in the range of the compat package. A new entry goes at the end. Do not edit an old entry. A correction is a new entry that names the old one. `check-records` fails when the text at the merge base of `main` is not the start of this file.

Each entry states the advisory and the dates of each read. It quotes the text that the owner read, and it names the source of each quote and of each CVE id. It states whether the advisory affects authtempo and why, and it names the core tests that hold that answer. It also gives the fix for an app.

## 2026-10-14: Better Auth 1.7.7, a magic link takeover

- Advisory: GHSA-965c-763c-88jm.
- Read: 2026-10-14 in the Better Auth changelog (v1.7.7, 2026-09-30). Read again on 2026-10-21 at https://github.com/better-auth/better-auth/security/advisories/GHSA-965c-763c-88jm (the GitHub advisory).
- The CVE id: the GitHub advisory shows "No known CVE" (read 2026-10-21). On 2026-10-21 the NVD page and the VulnCheck page of a CVE id show no record without a script or a sign-in. So this entry gives no CVE id.
- Text of the GitHub advisory, read 2026-10-21: the title "better-auth: OAuth state can be used as a Magic Link to sign in as another user". Affected versions ">= 1.4.0-beta.18, < 1.7.7". Patched versions "1.7.7". Severity "Critical", CVSS 3.1 "9.1". Weakness "CWE-287". Published "Sep 30, 2026".
- The flaw, from the GitHub advisory: Better Auth accepts the state value of an OAuth sign-in as a magic link token. An attacker who knows an address gets a session for that account. When no account exists and the magic link sign-up is on, the attacker gets a new account with a verified email.
- Affects authtempo: no. Core reads a verification row by its hash and its purpose (`packages/core/src/engine/verification.ts`, line 36). The magic link verify consumes only a row with the purpose `magic-link` (`packages/core/src/engine/magic-link.ts`, line 94). So the state of a social sign-in never opens a magic link session. Core spends a magic link token once, by one conditional update (spec 8.2 item 4). The compat package runs no Better Auth code.
- The test that holds the answer: "does not consume the state of a social sign-in as a magic link (GHSA-965c-763c-88jm)" in `packages/core/test/verification-purpose.test.ts`. It fails when line 36 of `verification.ts` is deleted.
- The fix for an app on Better Auth: upgrade to 1.7.7 or later before the move (spec 23 item 12).

## 2026-10-14: GHSA-qq9h-g4jm-xgf3, an account hijack before the account exists

- Advisory: GHSA-qq9h-g4jm-xgf3.
- Read: 2026-10-14 by a search for the 1.7.7 fix. Read again on 2026-10-21 at https://github.com/advisories/GHSA-qq9h-g4jm-xgf3 (the GitHub advisory).
- The CVE id: the GitHub advisory shows "No known CVE" (read 2026-10-21). An earlier draft of this entry gave a CVE id with no source that the owner can name. So this entry gives no CVE id.
- Text of the GitHub advisory, read 2026-10-21: the title "Better Auth: Account takeover via pre-account hijacking on magic-link and email-OTP sign-in". Affected versions ">= 1.1.3, < 1.6.22" and ">= 1.7.0-beta.0, < 1.7.0-beta.10". Patched versions "1.6.22" and "1.7.0-beta.10". Severity "High", CVSS 3.1 "8.3". Weaknesses "CWE-287" and "CWE-345". Published "Jun 26, 2026".
- The preconditions, from the GitHub advisory: the magic link or email OTP plugin is on, and email and password sign-up is open.
- The flaw, from the GitHub advisory: an attacker signs up with the address of a victim and a password of the attacker. The account stays unverified. The magic link or email OTP sign-in of the victim then marks the email verified. The password of the attacker stays valid.
- Affects authtempo: no. The claim rule of spec 8.2 item 5 runs when a magic link or an email code proves the address of an unverified user. It deletes each password row, each session, each other identity, and each passkey of that user (`claimEmail` in `packages/core/src/engine/users.ts`, lines 157 to 176). So no password of the claimant stays. The compat package runs no Better Auth code.
- The tests that hold the answer, in `packages/core/test/`: "applies the claim rule: an unverified claimant's session and password go, and the proof opens a session (Review Focus 3)" (`email-otp.test.ts`). Also "loses the old password when the mailbox owner claims an unverified import" (`password-legacy.test.ts`). Also "fires afterEnd with claim once per claimant session when a magic link proves the address" (`session-hooks.test.ts`).
- The fix for an app on Better Auth: upgrade to 1.7.7 or later before the move (spec 23 item 12). Version 1.7.7 is above both patched versions.

## 2026-10-30: zod below 4.6.6, memory on an oversized constrained collection

- Advisory: GHSA-mrhx-c7xc-m3w5.
- Read: 2026-10-30 at https://api.osv.dev/v1/vulns/GHSA-mrhx-c7xc-m3w5 (the OSV record).
- The CVE id: the OSV record gives the alias CVE-2023-54404 (read 2026-10-30). This entry names no other source for it.
- Text of the OSV record, read 2026-10-30: the summary "Zod can exhaust memory while validating oversized constrained collections". The affected range is introduced "0", fixed "4.6.6". Severity "HIGH", CVSS 3.1 "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H". Weakness "CWE-770". Published 2026-10-01.
- The package: `zod`, a runtime dependency of `@authtempo/core` and `@authtempo/mcp`. The range: every version below 4.6.6. The fix version: 4.6.6.
- The flaw, from a read of the zod code on 2026-10-30: below 4.6.6, zod reads each element of a collection before it checks the size. So a long array against a small `max` makes one issue for each element. Version 4.6.6 checks the size first (`capSize` in `v4/core/schemas.js`).
- Affects authtempo: yes, before the fix. No release had it, because every package is still 0.0.0. The tree before commit 21b5defb took zod 4.6.5. Fourteen routes parse a body with zod that holds a collection with a size check. Three are the passkey options routes (`hints`). One is `POST /organizations/invite` (`teamIds`). Seven take a statement set (`permissions`). Two are the SSO connection writes (`mfa` lists and `certificates`). The last is `POST /scim/tokens/create` (`scopes`). Core read each body with no cap.
- The measure that shows it: 2026-10-30, node v26.10.0, load about 17. A body of 9 888 936 bytes gave `teamIds` 1 000 000 items against a `max` of 20. zod 4.6.5 made 1 000 001 issues in 416 ms, with about 498 MB more heap. zod 4.6.6 made 1 issue in 1 ms, with no heap growth.
- The fix in authtempo has two parts. Core and the MCP server take zod 4.6.6 (commit 21b5defb). Core also owns a request body cap: `REQUEST_BODY_MAX` in `packages/core/src/http/body-cap.ts`, 8 388 608 bytes. A stream read stops at the cap before any parse, and a longer body answers 413 `body_too_large`.
- The largest collection that the cap allows: 4 194 267 elements, each `0` and a comma, in a body of exactly 8 388 608 bytes. The measure ran on 2026-10-30 with node v26.10.0 at a load of about 6.5, against the `teamIds` schema. zod 4.6.6 made 1 issue in 1 ms, and the parsed body took about 34 MB of heap. zod 4.6.5 made 4 194 268 issues in 936 ms, with about 2 GB of heap. So the cap alone does not bound zod below 4.6.6. The cap bounds the parse, and zod 4.6.6 bounds the validation.
- The tests that hold the answer are in `packages/core/test/body-cap.test.ts`. They are "answers 413 to the 9.9 MB probe of teamIds at POST /organizations/invite and writes no row", "refuses a body one byte over the cap and parses nothing", "reads a body of exactly the cap", "refuses a body over the cap whose content-length is false", and "refuses a streamed body over the cap that has no content-length". The check `check-osv` of `scripts/release` fails on a known advisory of a runtime dependency.
- The fix for an app: take an authtempo release with zod 4.6.6 or later. An app that validates its own input with zod also takes zod 4.6.6 or later.
