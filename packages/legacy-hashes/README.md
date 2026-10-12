# @tempo-auth/legacy-hashes

Password hashes from another auth provider, verified at sign-in and rewritten
as PBKDF2 on the first right sign-in (spec 17.2). Chain it before core's seam:

```ts
import { createPbkdf2PasswordHash } from "@tempo-auth/core";
import { createLegacyPasswordHash } from "@tempo-auth/legacy-hashes";

const hash = createLegacyPasswordHash({
  formats: ["bcrypt"], // only what your import brought; give the importer the same --formats
  next: createPbkdf2PasswordHash(),
});
createAuth({ ..., password: { hash } });
```

| Format | Stored form | From |
| --- | --- | --- |
| `bcrypt` | `$2a$` or `$2b$`, cost 4 to 12 | Supabase, Clerk, Auth0, an Auth.js app's own password column |
| `argon2id` | `$argon2id$v=19$m=..,t=..,p=..$salt$hash` | Supabase |
| `pbkdf2-sha256` | `$pbkdf2-sha256$i=..,l=..$salt$hash` | Ory, Keycloak exports (after a rewrite to this form) |
| `scrypt` | `$scrypt$n=<log2 N>,r=..,p=..$salt$hash` | Ory exports (rewrite Ory's `ln=N` as `n=log2 N`) |
| `firescrypt` | `$firescrypt$n=<mem_cost>,r=<rounds>,p=1$salt$hash` | Firebase; pass `firebase: { signerKey, saltSeparator }` from the console |

Base64 segments are standard base64, with or without padding. Salts and
hashes are 4 to 64 and 16 to 64 bytes (Argon2id salts at least 8). A string
outside a bound does not parse. No reader of `@tempo-auth/import` writes the
`pbkdf2-sha256` or `scrypt` form; a custom source or an app's own column can.

`firebase.signerKey` is base64 of 16 to 64 bytes and `firebase.saltSeparator`
is base64 of 0 to 16 bytes. Another value stops the seam at construction.
`firescrypt` in `formats` without `firebase` also stops it.

- A row in a format you did not list costs what a wrong password costs, and
  never signs in. List only the formats your import brought.
- A bcrypt match on a password longer than 72 bytes signs in but keeps the
  bcrypt row (`rehash: false`). bcrypt reads only the first 72 bytes, so a
  rehash would store the text typed this time, tail errors included. The
  row moves to PBKDF2 on the first sign-in with a password of at most 72
  bytes, or at a reset.
- A legacy row verifies slower than PBKDF2 until its first right sign-in, so
  the response time tells an address that is not yet migrated.
- One bcrypt cost-10 verify is about 50 ms of CPU on an Apple M5 Max
  (research, 2026-10-11). A deployment needs Workers Paid. The time on a
  deployed Worker is not measured yet (owner runbook item 7 in the plan
  index).
- The password goes to the derive as raw UTF-8 bytes, with no Unicode
  normalization, because the sources hash the raw bytes.

## The gate

At most two derives of any legacy format run at once per isolate; the rest
wait in order, and the gate never refuses. The gate is core's `deriveGate`
(plan 9b2): one gate per isolate, which every seam of this package and the
Better Auth seam of `@tempo-auth/compat-better-auth` share. An app that chains
both seams still runs at most two derives at once. One Argon2id or scrypt
derive holds up to 32 MiB. The share holds only with one copy of
`@tempo-auth/core` in the app: a second copy has a second gate, and a chain
can then run four derives. This package and the compatibility package
declare core as a peer dependency, so a package manager warns on a version
that does not match. Keep one version of core.

## Cognito

Cognito exports no hash. That fact is unverified in an AWS primary source
(owner runbook item 6). The importer writes a marker, and core asks Cognito
at the first sign-in:

```ts
import { createCognitoLegacyVerify } from "@tempo-auth/legacy-hashes/cognito";
import { waitUntil } from "cloudflare:workers";

password: {
  legacyVerify: {
    verify: createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId,
      clientSecret, // only when the app client has a secret
      waitUntil, // keeps the failure line and a timed-out request alive after the response
    }),
    timeoutMs: 2000,
  },
}
```

- The app client must list `ALLOW_USER_PASSWORD_AUTH` in its explicit auth
  flows. Without it, every Cognito user fails to sign in, and `onFailure`
  gets `InvalidParameterException`.
- The check sends the email that the importer stored, in core's lower case,
  as `USERNAME`. It binds by email, never by the Cognito `sub`. The pool must
  accept the email as a user name or an alias. A pool that does not fails
  every imported user: Cognito answers `NotAuthorizedException` when the app
  client sets `PreventUserExistenceErrors` to `ENABLED`, and
  `UserNotFoundException` when it is `LEGACY` (AWS docs, read 2026-10-12).
  Without an `onFailure` of your own, each such failure writes the default
  line below.
- A pool with case-sensitive user names can refuse a lower-case address for a
  user stored as `Ada@Example.com`. Unverified whether the email alias follows
  that setting. Such a user must reset the password.
- Every Cognito challenge answers false: an MFA challenge, and
  `NEW_PASSWORD_REQUIRED`. tempo-auth has no second factor until plan 9f. A
  user with a challenge must reset the password.
- A password longer than core's policy (128 code points) never reaches
  Cognito. Such a user must reset the password.
- Every failure answers false, and each one calls `onFailure` once with only
  the reason: the Cognito error type, or `timeout`, `network`, `malformed`,
  `challenge`. It never gets the email or the password. The default writes
  one line, `tempo-auth: cognito legacy verify failed <reason>`, with
  `console.error`. An `onFailure` of your own replaces that line.
- `onFailure` runs after the answer, on a 0 ms timer, and its errors are
  dropped. Workers can drop a timer after the response, so pass `waitUntil`:
  `waitUntil` from `cloudflare:workers`, or `ctx.waitUntil.bind(ctx)` when
  the app builds its config per request. The check gives it each failure
  call and, on a `timeout`, the Cognito request that is still in flight.
- `timeoutMs` is 100 to 30000, default 5000. While `legacyVerify` is set,
  every failed password sign-in waits until `timeoutMs` after its check
  began. So a migrated and an unmigrated address look the same. Set it longer
  than the seam's dummy verify plus Cognito's round trip; else every check
  times out. Cognito gets
  `timeoutMs` minus core's lookup time. Set a low `timeoutMs`; remove
  `legacyVerify` when the migration ends.
- After the import, sign in once with a known Cognito user before the
  cut-over (owner runbook). A wrong client or pool setting fails every user.

## Licenses

bcryptjs 3.0.3 is BSD-3-Clause. @noble/hashes 2.4.0 is MIT. See `NOTICE`.
A Worker needs no `nodejs_compat`: `node proof/no-node.mjs` proves it.
