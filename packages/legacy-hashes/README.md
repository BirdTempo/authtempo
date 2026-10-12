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
derive holds up to 32 MiB.

## Cognito

Cognito exports no hash. That fact is unverified in an AWS primary source
(owner runbook item 6). The importer writes a marker, and core asks Cognito
at the first sign-in:

```ts
import { createCognitoLegacyVerify } from "@tempo-auth/legacy-hashes/cognito";

password: {
  legacyVerify: {
    verify: createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId,
      clientSecret, // only when the app client has a secret
      onFailure: (reason) => console.warn("cognito check failed:", reason),
    }),
    timeoutMs: 2000,
  },
}
```

- The app client must list `ALLOW_USER_PASSWORD_AUTH` in its explicit auth
  flows. Without it, every Cognito user fails to sign in, and `onFailure`
  gets `InvalidParameterException`.
- The check sends the email that the importer stored, in core's lower case,
  as `USERNAME`. It binds by email, not by the Cognito `sub`. The pool must
  accept the email as a user name or an alias.
- A pool with case-sensitive user names can refuse a lower-case address for a
  user stored as `Ada@Example.com`. Unverified whether the email alias follows
  that setting. Such a user must reset the password.
- Every Cognito challenge answers false: an MFA challenge, and
  `NEW_PASSWORD_REQUIRED`. tempo-auth has no second factor until plan 9f. A
  user with a challenge must reset the password.
- A password longer than core's policy (128 code points) never reaches
  Cognito. Such a user must reset the password.
- `onFailure` gets only the reason: the Cognito error type, or `timeout`,
  `network`, `malformed`, `challenge`. It never gets the email or the
  password. Every failure answers false, so without `onFailure` a wrong setup
  is silent.
- `onFailure` runs after the answer, on a 0 ms timer, and its errors are
  dropped. On a `timeout` the floor has passed, so core answers at once and
  the timer can run after the response. Workers can drop a timer after the
  response, so a `timeout` report can be lost.
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
