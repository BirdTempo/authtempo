# @authtempo/core

```ts
import { createAuth, createMemoryAdapter } from "@authtempo/core";

const auth = createAuth({
  baseURL: "https://api.example.com",
  secret: env.AUTH_SECRET,                 // at least 32 characters, 100 bits or more
  trustedOrigins: ["https://app.example.com", "consumera://"],
  storage: createMemoryAdapter(),          // use a D1 or Postgres adapter in production
  mail: { send: async (m) => { /* your transport */ } },
});

// In your fetch handler:
if (url.pathname.startsWith("/auth/")) return auth.handle(request);
const s = await auth.session(request);     // { user, session } or null
```

Give `secret`, or `secrets` as a list of `{ version, value }` with the current version first. `secret` alone is version 1. A value has at least 32 characters.

The estimate of a secret is its length times log2 of its distinct characters. `createAuth` refuses a current secret under 100 bits and warns from 100 to 119 bits. The estimate does not catch a pattern. Make a secret with 32 random bytes: `openssl rand -base64 32`.

## Routes under `basePath` (default `/auth`)

| Method | Path | Body or query | Answer |
| --- | --- | --- | --- |
| POST | `/magic-link/request` | `{ email, next? }` | `{ sent: true }` always; 429 when rate limited; 400 on a bad body |
| GET | `/magic-link/verify` | `?token=` | 200 HTML confirm page with a form that posts the token; 302 to `/?auth_error=invalid_token` on a malformed token. No side effect, so a mail scanner burns nothing |
| POST | `/magic-link/verify` | form or JSON `token`, `trustDevice?` | form body: 302 to `appURL` plus `next` with the session cookie, or, for a user with the second factor on, 302 to the challenge page with no cookie, or 302 to `/?auth_error=<code>`; JSON body: 200 `{ user, session }` with the cookie, or 200 `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie (plan 12c), or the error as JSON |
| GET | `/social/google/start`, `/social/apple/start` | `?next=` | 302 to the provider with a binding cookie; 302 to `/?auth_error=rate_limited` when limited. A route exists only for a configured provider |
| GET | `/social/google/callback` | `?code&state` | 302 to `next` with the session cookie; for a user with the second factor on, 302 to the challenge page with no cookie (plan 12c); 302 to `/?auth_error=<code>` on failure |
| POST | `/social/apple/callback` | form `code, state, user?` from Apple | same as the Google callback. The Origin check is skipped here; the state row and the binding cookie bind the post |
| GET | `/social/<name>/start`, `/social/<name>/callback` | `?next=`; `?code&state` | the same answers as the Google routes, for `github`, `linkedin`, and each `social.oidc` and `social.oauth2` entry |
| GET | `/session` | cookie or `Authorization: Bearer` | `{ user, session }` or 401. With `session.deferRefresh` on, also `needsRefresh`, and no renewed cookie |
| POST | `/session/refresh` | cookie or bearer | `{ user, session }`, and the renewed cookie when the refresh was due; 401 (plan 12a) |
| POST | `/sign-out` | cookie or bearer | `{ ok: true }` and clears the cookie |
| POST | `/passkey/register/options` | session (fresh) | the creation options JSON for `navigator.credentials.create`; 401; 403 `email_unverified`, `session_not_fresh` |
| POST | `/passkey/register/verify` | session, `{ response, name? }` | `{ passkey }`; 400 `invalid_body`, `invalid_token`, `token_expired`, `passkey_failed`; 401; 403 `email_unverified`. A credential id that is already registered answers `passkey_failed`. A `name` that is blank after the trim, or that breaks the passkey name rule, is stored as no name (see "Passkeys") |
| POST | `/passkey/authenticate/options` | `{}` | the request options JSON for `navigator.credentials.get`; 429 `rate_limited` |
| POST | `/passkey/authenticate/verify` | `{ response }` | `{ user, session }` with the session cookie; 400 `invalid_body`, `invalid_token`, `token_expired`, `passkey_failed` (an unknown credential or a bad signature); 429 `rate_limited` |
| GET | `/passkeys` | session | `{ passkeys: [{ id, credentialId, name, deviceType, backedUp, createdAt }] }`; 401 |
| POST | `/passkeys/delete` | session (fresh), `{ id }` | `{ ok: true }`; 400 `invalid_body`; 401; 403 `session_not_fresh`; 404 `not_found`; 409 `last_credential` (the last way in, see "The last-credential guard"), `second_factor_last_method`, `conflict` |
| POST | `/passkeys/rename` | session, `{ id, name }` | `{ passkey }` in the shape of `GET /passkeys` (plan 12a). No fresh rule: a name is no way in. 400 `invalid_body` (a `name` that breaks the passkey name rule, or any other field); 401; 404 `not_found` (an unknown id, or an id of another user); 429 `rate_limited` |
| POST | `/password/sign-up` | `{ email, password, name? }` | `{ sent: true }` with no cookie for every address (`password.uniformSignUp`, the default); with `uniformSignUp: false`, `{ token, user, session }` with the cookie, or `{ user, verifyRequired: true }` with no cookie under `requireVerified` or `signUp: "invited"`; 400 `invalid_body`, `password_policy`, `password_breached`, `captcha_required`; 403 `sign_up_closed`, `captcha_failed`; 409 `email_taken`, `email_taken_unverified` (only with `uniformSignUp: false`); 429 `rate_limited`; 503 `breach_check_unavailable`, `captcha_unavailable`. The captcha codes come only with `captcha` (see "Captcha"). The user is unverified until the mail link is confirmed |
| POST | `/password/sign-in` | `{ email, password }` | `{ token, user, session }` with the cookie; 400 `invalid_body`; 401 `invalid_credentials`; 429 `rate_limited`; 404 without a `password` config |
| GET | `/password/verify` | `?token=` | 200 HTML confirm page; 302 to `/?auth_error=invalid_token` on a malformed token. No side effect, so a mail scanner burns nothing |
| POST | `/password/verify` | form or JSON `token` | form body: 302 to `appURL` with the cookie, or 302 to `/?auth_error=<code>`; JSON body: `{ verified: true }`, with the cookie when the address was unverified, or the error as JSON. `invalid_token` when the password row is gone; `token_expired` |
| POST | `/password/verify/resend` | `{ email }` | `{ sent: true }` always; 400 `invalid_body`; 429 `rate_limited`. A mail goes only to an unverified user with a password, and the earlier link of the address stops working |
| POST | `/password/reset/request` | `{ email, next? }` | `{ sent: true }` always; 429 `rate_limited`; 400 `invalid_body` |
| GET | `/password/reset` | `?token=` | 200 HTML form (`password.resetPage` replaces it); 302 to `/?auth_error=invalid_token` on a malformed token. No side effect |
| POST | `/password/reset` | form or JSON `token`, `password`, `trustDevice?` | form body: 302 to `next` with the cookie, or, for a user with the second factor on, 302 to the challenge page with no cookie, or back to the form on `password_policy`, `password_breached`, or `breach_check_unavailable`, or 302 to `/?auth_error=<code>`; JSON body: `{ token, user, session }` with the cookie, or `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie (plan 12c), or the error as JSON. `invalid_token`, `token_expired`, 429 `rate_limited`, 503 `breach_check_unavailable`. A reset that answers the challenge still sets the password and ends every session |
| POST | `/password/change` | session, `{ currentPassword?, newPassword }`; a fresh session for a first password and while the second factor is on | `{ ok: true }`; 400 `invalid_body`, `password_policy`, `password_breached`; 401 without a session; 401 `invalid_credentials` for a missing or wrong current password; 403 `email_unverified`, `session_not_fresh`; 409 `conflict`; 429 `rate_limited`; 503 `breach_check_unavailable` |
| POST | `/otp/request` | `{ email }` | `{ sent: true }` always; 400 `invalid_body`; 429 `rate_limited`. Mails a sign-in code |
| POST | `/otp/verify` | `{ email, code, trustDevice? }` | `{ token, user, session }` with the cookie, or, for a user with the second factor on, `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie (plan 12c); 400 `invalid_body`, `invalid_code` (a wrong, expired, spent, or unknown code), `too_many_attempts` (the code took `maxAttempts` wrong guesses: request a new one); 429 `rate_limited` |
| POST | `/otp/reset/request` | `{ email }` | `{ sent: true }` always; 400 `invalid_body`; 429 `rate_limited`. Mails a reset code. Only with a `password` config |
| POST | `/otp/reset` | `{ email, code, password, trustDevice? }` | `{ token, user, session }` with the cookie, or, for a user with the second factor on, `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie and the password set (plan 12c); 400 `invalid_body`, `invalid_code`, `too_many_attempts`, `password_policy` and `password_breached` (both spend the code); 429 `rate_limited`; 503 `breach_check_unavailable` (it spends the code too). Only with a `password` config |
| GET | `/handoff/start` | `?challenge=&redirect=` | 200 the sign-in page, or 302 to the confirm page when the browser already has a session; 400 `invalid_body`; 429 `rate_limited`. Only with a `handoff` config |
| GET | `/handoff/continue` | `?h=` | 200 the confirm page with a session, the sign-in page without one; 302 to `/?auth_error=<code>` for a spent or unknown id |
| POST | `/handoff/continue` | form `h`, Origin = baseURL | 302 to `<redirect>?code=`; 403 from any other origin; the sign-in page without a session |
| POST | `/handoff/redeem` | `{ code, verifier }` | `{ token, user, session }` as a bearer answer, no cookie; 400 `invalid_body`, `invalid_token`, `token_expired`; 429 `rate_limited` |
| POST | `/tokens` | session (fresh), `{ name, expiresInDays?, organizationId?, permissions?, metadata? }` | `{ token, apiToken }`, the clear token once; 400 `invalid_body` (also a set with an unknown name, a set with `organizations` off, or `metadata` over 4096 bytes); 401 without a session (a `tk_` bearer too); 403 `email_unverified`, `session_not_fresh`, `forbidden_rank` for a set wider than the user's set in the bound organization; 404 `not_found` for an organization the user is not a member of; 409 `token_limit` at 50 tokens; 429 `rate_limited`. The route takes no window and no quota |
| GET | `/tokens` | session | `{ tokens: [{ id, name, hint, expiresAt, lastUsedAt, organizationId, permissions, metadata, rateLimit, remaining, retired, createdAt }] }`, newest first, never a token or its hash; 401; 403 `email_unverified` |
| POST | `/tokens/revoke` | session, `{ id }` | `{ ok: true }`; 400 `invalid_body`; 401; 403 `email_unverified`; 404 `not_found` for another user's token |
| POST | `/tokens/update` | session (fresh), `{ id, name?, permissions?, expiresAt? }` | the `apiToken` after the change; it narrows only: 400 `invalid_body` for a wider set, `null` over a set, a later expiry, `null` over a date, or another key; 401; 403 `email_unverified`, `session_not_fresh`; 404 `not_found` for another user's token; 409 `conflict` when the row changed between the read and the write |
| GET | `/tokens/current` | `Authorization: Bearer tk_…` only | `{ user, apiToken }`, and one call of the quota spent; 401 for a session cookie, a `ts_` bearer, or no credential, and `token_retired` for a key of `tokens.movedPrefixes` with no row; 429 `rate_limited` over the token's window, `token_exhausted` at a quota of zero; 409 `conflict` when a lost spend sees no other spend, or after 20 lost spends |
| POST | `/totp/setup` | session, `{ password }` | `{ secret, uri, backupCodes }`, each answered once; `backupCodes` is empty when another method is on, because the factor keeps its list (plan 12c); 400 `invalid_body`; 401, `invalid_credentials` (a wrong password; no row is written); 403 `email_unverified`; 429 `rate_limited` (`totp-setup:user`, 5 per 15 minutes); 409 `totp_enabled`, `conflict` (a parallel setup of the same user). A new setup replaces one that was not confirmed. Only with `password` and `totp` not `false` |
| POST | `/totp/enable` | session (fresh), `{ code }` | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`, as `GET /totp`; 400 `invalid_body`, `invalid_code`, `totp_not_enabled` (no setup, one older than 15 minutes, or a setup whose codes another method made stale: set up again); 401; 403 `email_unverified`, `session_not_fresh`; 409 `totp_enabled`, `conflict` (a parallel first enable of another method: retry); 429 `rate_limited`. As the first method, it ends every other session of the user with `two_factor` |
| POST | `/totp/disable` | session (fresh), `{ code }` (a current code or a backup code) | `{ ok: true }`, and clears the trust cookie; it turns the TOTP method off, and with no method left the factor is off; 400 `invalid_body`, `invalid_code`, `totp_not_enabled`; 401; 403 `session_not_fresh`; 409 `conflict`; 429 `rate_limited` |
| POST | `/totp/backup-codes` | session (fresh), `{ code }` | `{ backupCodes }`, a new list; the old codes stop working; 400 `invalid_body`, `invalid_code`, `totp_not_enabled`; 401; 403 `session_not_fresh`; 409 `conflict` (parallel writes won every try); 429 `rate_limited` |
| GET | `/totp` | session | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`: `enabled` is true when any method is on, `methods` lists them, and `backupCodesVersion` is 1 for the codes of plan 9f, 2 for the codes of 23 characters, and `null` with the factor off; never the secret or the URI; 401 |
| POST | `/totp/devices/revoke` | session | `{ ok: true }`: every trusted device of the user goes, and the trust cookie is cleared; 401 |
| POST | `/totp/verify` | `{ challenge }` and one of `code`, `backupCode`, `emailCode`, or `passkey` (an assertion over the options of `/second-factor/passkey/options`), `trustDevice?` | `{ token, user, session, next, backupCodesLeft, trustDevice }` with the session cookie, and the trust cookie when `trustDevice` is true; 400 `invalid_code`, `too_many_attempts` (the fifth wrong code), `invalid_token` (unknown, spent, or older than 5 minutes), `invalid_body` (no proof, two proofs, or a method that the challenge does not offer), `passkey_failed`; 429 `rate_limited` |
| GET | `/totp/challenge` | `?challenge=` | 200 HTML form of the challenge's methods, with a trusted-device button when the browser sends a live trust cookie of the user (`totp.challengePage` replaces it); 302 to `/?auth_error=invalid_token` on a malformed or dead challenge. It reads rows and writes none |
| POST | `/totp/challenge` | form `challenge`, and `code`, `backupCode`, or `emailCode` with `trustDevice=1`; or `action=send-email`; or `action=trusted` | 302 to `next` with the cookies; back to the form on `invalid_code` and after a send; 302 to `/?auth_error=<code>` otherwise. `action=trusted` passes with the trust cookie alone |
| POST | `/second-factor/passkey/enable` | session (fresh), `{ password, response }` (an assertion over `/passkey/authenticate/options` by a passkey of the user) | `{ methods, backupCodes }`; the codes come once, with the first method; 400 `invalid_body`, `passkey_failed`; 401, `invalid_credentials`; 403 `email_unverified`, `session_not_fresh`; 404 `not_found` without `passkey`; 409 `conflict`; 429 `rate_limited` (`totp-setup:user`). Only with `passkey` |
| POST | `/second-factor/passkey/options` | `{ challenge }` | WebAuthn request options with the user's passkeys in `allowCredentials`, bound to the challenge; 400 `invalid_body` (the challenge does not offer `passkey`), `invalid_token`; 429 `rate_limited` (`second-factor-passkey:ip`, 30 per 15 minutes). Only with `passkey` |
| POST | `/second-factor/email/enable` | session (fresh), `{ password }` | `{ methods, backupCodes }`, as the passkey enable; 400 `invalid_body`; 401, `invalid_credentials`; 403 `email_unverified`, `session_not_fresh`; 409 `conflict`; 429 `rate_limited` (`totp-setup:user`) |
| POST | `/second-factor/email/send` | `{ challenge }` | `{ sent: true }`, and a 6-digit code to the user's address; a new send replaces the code; 400 `invalid_body` (the challenge does not offer `email`), `invalid_token`; 409 `conflict`; 429 `rate_limited` (3 sends per challenge, `second-factor-email:user` 5 per 15 minutes, `totp:email-day` 20 per 24 hours) |
| POST | `/second-factor/disable` | session (fresh), `{ method, password }` with `method` `passkey` or `email` | `{ ok: true, methods }`, the methods left; with none left the factor is off and the trust cookie is cleared; 400 `invalid_body`, `totp_not_enabled` (the method is not on); 401, `invalid_credentials`; 403 `session_not_fresh`; 409 `conflict`; 429 `rate_limited` (`totp-setup:user`). TOTP has its own disable, with a code |
| GET | `/jwks` | none | `{ keys }`: the signing key and each key retired less than 24 hours ago, public JWKs with `kid`, `alg`, and `use: "sig"`; `cache-control: public, max-age=300`. The first call writes the first key. Absent with `jwtMint: false` |
| GET | `/token` | session (cookie or `ts_` bearer) | `{ token }`: a session JWT; 401 with no session, a `tk_` bearer, or a JWT bearer; 500 `hook_failed` when `jwtMint.claims` throws |
| POST | `/operator/keys/rotate` | `Authorization: Operator <secret>` | `{ kid }`: a new signing key; the old one verifies for 24 hours and signs nothing; 401 `unauthorized` for a missing or wrong secret; 429 `rate_limited` after 5 calls per IP per hour (`operator:ip:<ip>`), right or wrong. Only with `operator` and `jwtMint` |
| GET | `/operator/secrets/status` | `Authorization: Operator <secret>` | `{ versions }`: for each version, `configured`, `current`, `totpSecrets`, `backupCodes`, `signingKeys`, and `emailCodes`, as `api.secrets.status()`; 401 `unauthorized`; 429 `rate_limited` after 120 calls per IP per hour (`operator-secrets:ip:<ip>`), one count with rewrap and info, right or wrong. Only with `operator` |
| POST | `/operator/secrets/rewrap` | `Authorization: Operator <secret>`, `{ limit?, after? }` (`limit` 1 to 1000, default 100; `after` the `next` of the last answer); an empty body is `{}` | `{ resealed, failed, skipped, more, next }`, as `api.secrets.rewrap({ limit, after })`; 400 `invalid_body` for another key, a limit outside the range, or a cursor that is not `totp:<id>` or `jwk:<id>`; 401 `unauthorized`; 429 `rate_limited` (`operator-secrets:ip:<ip>`). Only with `operator` |
| GET | `/operator/info` | `Authorization: Operator <secret>` | `{ core, schemaVersion, configKeys }`: the version of core, its schema version, and the sorted key paths of the config, names only, never a value; 401 `unauthorized`; 429 `rate_limited` (`operator-secrets:ip:<ip>`). Only with `operator` |
| GET | `/operator/users` | `Authorization: Operator <secret>` with the scope `users`, or a platform operator's session, `?after=&limit=` | `{ users, next }`: the users by id, 1 to 100 per page; 401 `unauthorized`; 403 `operator_required`; 429 `rate_limited`. Only with `operator.users` |
| GET | `/operator/users/search` | `Authorization: Operator <secret>` with the scope `users`, or a platform operator's session, one of `?email=`, `?emailPrefix=`, `?id=` | `{ users, next }`; a prefix search reads the whole user table. Only with `operator.users` |
| GET | `/operator/users/get` | `Authorization: Operator <secret>` with the scope `users`, or a platform operator's session, `?userId=` | `{ user }`; 404 `not_found`. Only with `operator.users` |
| POST | `/operator/users/ban` | `Authorization: Operator <secret>` with the scope `users`, or a platform operator's session, `{ userId, reason, until? }` | `{ auditId }`; ends every challenge, handoff code, and OAuth refresh token and code of the user, and the sessions that fit the call. The sweep ends the rest. Only with `operator.users` |
| POST | `/operator/users/unban` | `Authorization: Operator <secret>` with the scope `users`, or a platform operator's session, `{ userId, reason }` | `{ auditId }`; restores no session. Only with `operator.users` |
| POST | `/operator/users/platform-role` | `Authorization: Operator <secret>` with the scope `users`, or a platform operator's session, `{ userId, grant, reason }` | `{ auditId }`; a revoke ends the sessions of the user that fit the call, and the sweep or a second revoke ends the rest. Only with `operator.users` and `organizations.platformRole` |
| POST | `/operator/users/second-factor/disable` | `Authorization: Operator <secret>` with the scope `users`, or a platform operator's session, `{ userId, reason, proof: { method, reference, checkedAt } }` | `{ auditId }`; ASVS 5.0.0 6.4.4. Only with `operator.users` |
| POST | `/operator/users/create-admin` | `Authorization: Operator <secret>` with the scope `users`; a session caller gets 403 `operator_required` | `{ userId, created, auditId }`. Only with `operator.users` and `organizations.platformRole` |
| POST | `/operator/sessions/end-user` | `Authorization: Operator <secret>` with the scope `sessions`, or a platform operator's session, `{ userId, reason }` | `{ ended, more, auditId }`; call again while `more` is true. Only with `operator.users` |
| POST | `/operator/sessions/end-all` | `Authorization: Operator <secret>` with the scope `sessions`, or a platform operator's session, `{ reason, limit? }` | `{ ended, more, auditId }`; keeps the caller's own session; call again while `more` is true. Only with `operator.users` |
| GET | `/operator/audit` | `Authorization: Operator <secret>` with the scope `audit`, or a platform operator's session, `?targetUserId=&after=&limit=` | `{ rows, next }`: the audit rows, oldest first. Only with `operator.users` |
| POST | `/operator/impersonate` | session (cookie or `ts_` bearer) of a platform operator who passes the operator user guard; `{ userId, reason }` | `{ expiresAt, auditId }`. The session cookie gets the new session's token, and `<cookie name>_actor` gets the operator's own token. Both get the Max-Age of the new session. A bearer caller gets `{ token, expiresAt, auditId }` and no cookie. The new session has `actorId`, no fresh time, and a fixed expiry at `operator.impersonation.ttlMinutes`. Errors: 401 `unauthorized` (also with an operator secret) and 403 `operator_required`. The answer is 403 `impersonation_refused` for the operator, a platform operator, a banned user, or no user. The limit `operator-impersonate:user:<userId>` answers 429 `rate_limited` after 20 per hour. Only with `operator.impersonation` |
| POST | `/operator/impersonate/stop` | the impersonation session; `{ reason? }`, an empty body is `{}` | `{ auditId, restored }`. It ends the session and clears the actor cookie. It puts the operator's token back in the session cookie while that session lives, else it clears the session cookie. A session that is not an impersonation gets 404 `not_found`. Only with `operator.impersonation` |
| POST | `/oauth/register` | JSON client metadata (RFC 7591) | 201 `{ client_id, client_id_issued_at, client_name?, redirect_uris, token_endpoint_auth_method, grant_types, response_types, subject_type, id_token_signed_response_alg, dpop_bound_access_tokens }`, with `client_secret` once for a secret client; 400 `invalid_redirect_uri`, `invalid_client_metadata`; 401 `invalid_token` without the initial access token; 429. Only with `oauth` and `registration.dynamic` |
| GET | `/oauth/authorize` | the OAuth 2.1 parameters, PKCE S256, `resource`, `scope`, `state`, `nonce`, `prompt`, `dpop_jkt?` (RFC 9449 section 10: the exchange needs a proof of that key) | 302 to `/oauth/sign-in` with no session, with `next` back to `?request_id=oq_…`, a request that core holds for 10 minutes; `request_id` alone shows the held request, and an unknown, spent, or expired one, or one that the consent page showed to another user, also with no session, answers 400 `invalid_request` JSON and spends nothing for that caller; 200 the consent page; 302 to the client with `code`, `state`, and `iss` when a consent covers the scopes; 302 with `error` for a bad request; 400 or 401 JSON with no redirect for a bad client or redirect URI; 429 |
| POST | `/oauth/authorize` | the consent form: `request_id` and `decision=allow` or `deny`; the user the page showed the request to; session; `Origin` equal to `baseURL` | 302 to the client with `code` or `error=access_denied`; 400 `invalid_request` for a spent, expired, or another user's request; 401; 403 |
| GET | `/oauth/sign-in` | `?next=<basePath>/oauth/authorize?…` | the sign-in page, which lands back on `next`; 302 to `<appURL>/?auth_error=invalid_request` for another `next` |
| POST | `/oauth/token` | A form. The code grant sends `grant_type=authorization_code` with `code`, `code_verifier`, `client_id`, `redirect_uri`, and `resource?`. The refresh grant sends `grant_type=refresh_token` with `refresh_token`, `client_id`, `scope?`, and `resource?`. A confidential client adds its secret as HTTP Basic or `client_secret`. A `DPoP` header with a proof binds the tokens to its key (RFC 9449). | `{ access_token, token_type, expires_in, scope, refresh_token?, id_token? }`. After a proof, `token_type` is `"DPoP"` and the access token holds `cnf.jkt`. A public client's refresh token is then bound to the key. With no proof, `token_type` is `"Bearer"`. 400 `invalid_grant`, `invalid_target`, `invalid_scope`, `invalid_request`, `unsupported_grant_type`, `invalid_dpop_proof`; `invalid_client`, 401 after an `Authorization` header and 400 with none; 429 |
| POST | `/oauth/revoke` | form `token`, `client_id?`, `client_secret?`, or HTTP Basic (RFC 7009) | 200 `{}` for a token it revoked, an unknown token, and an access token. A refresh token's family goes. 400 `unauthorized_client` for a refresh token of another client, which stays. `invalid_client` for a failed client auth, and for a confidential client's refresh token with no auth. It is 401 after an `Authorization` header and 400 with none. 400 `invalid_request` for a body that is not a form. 429. |
| POST | `/oauth/introspect` | form `token`, `token_type_hint?`, and the client auth of `/oauth/token`, by a confidential client with `introspect: true` (RFC 7662) | `{ active: true, scope, client_id, sub, aud, iss, exp, iat, jti, token_type, cnf? }` for a live access token, and for a live refresh token of the caller. A DPoP-bound access token answers `token_type: "DPoP"` and `cnf: { jkt }`. `{ active: false }` alone for every other token. `invalid_client` for any other caller: 401 after an `Authorization` header, 400 with none. 400 `invalid_request` without `token`. 429 |
| GET, POST | `/oauth/userinfo` | `Authorization: Bearer <access token>` with `openid`, or `Authorization: DPoP <bound token>` with a proof in the `DPoP` header | `{ sub, email?, email_verified?, name?, picture? }` by scope; 401 `invalid_token`; 401 `invalid_dpop_proof` for a bound token with no valid proof; 403 `insufficient_scope`. A bound token as a bearer gets 401. `WWW-Authenticate` names both schemes (RFC 9449 section 7.2) |
| GET, POST | `/oauth/end-session` | `id_token_hint?`, `client_id?`, `post_logout_redirect_uri?`, `state?` in the query or a form (OIDC RP-Initiated Logout 1.0). `logout_hint` and `ui_locales` are ignored. The yes of the page is a POST of `confirm=yes` with `Origin` equal to `baseURL` | A POST that carries no session answers 303 to the GET of the same fields, without `confirm`. A cross-site POST carries no `SameSite=Lax` cookie, and the top-level GET does. A valid hint of the session that the request carries ends it at once, also an expired hint. With no valid hint of the session, 200 the confirmation page, and nothing ends until the yes. A redirect to an exact `post_logout_redirect_uri` of the hint's client, with `state`, only with a valid hint (302, or 303 for a POST); else 200 the signed-out page. 400 `invalid_request` for a repeated parameter; 429 |
| GET | `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | none | the issuer's metadata, `cache-control: public, max-age=300`; also at the origin root through `auth.wellKnown`. `/.well-known/oauth-protected-resource` answers 404 here |

Without a `passkey` config none of these routes exist, and the router answers 404.

Without a `password` config none of the password routes exist, and the router answers 404. The token routes exist in every deployment.

Since plan 9f a user with the second factor on gets `{ twoFactor: { challenge, expiresAt, methods } }` from `POST /password/sign-in` in place of the session, with no cookie. Send the challenge and a code to `POST /totp/verify`, or send the browser to `GET /totp/challenge?challenge=`. The sign-in also takes `trustDevice` (a native app's `td_` token; a browser sends the trust cookie) and `next` (where the challenge page lands). Without `password`, or with `totp: false`, none of the TOTP routes exist. Since plan 12c the magic link, the email code sign-in, social, and the reset answer the same challenge, and the challenge lists its `methods`. A form flow goes to the challenge page.

With `emailOtp: false` none of the code routes exist, and the router answers 404. Without a `password` config the two reset code routes do not exist.

The organization routes follow.

| Method | Path | Body or query | Answer |
| --- | --- | --- | --- |
| POST | `/organizations/create` | session, `{ slug, name, metadata? }` | `{ organization, member }`; 400 `invalid_body`, `slug_reserved`; 401; 403 `email_unverified`; 409 `slug_taken` |
| GET | `/organizations` | session | `{ organizations: [{ organization, role }] }`; 401 |
| POST | `/organizations/check-slug` | session, `{ slug }` | `{ slug, status }` with `available`, `taken`, `reserved`, or `invalid` (a null slug); 400 `invalid_body`; 401 (a `tk_` bearer too); 403 `email_unverified`; 429 `rate_limited` at 60 per minute |
| POST | `/organizations/has-permission` | session, `{ organizationId, permissions }` | `{ success }`, `false` for a non-member; 400 `invalid_body`; 401 (a token bearer too) |
| GET | `/organizations/permissions` | session, `?organizationId=` | `{ role, permissions }`, `role: null` and `{}` for a non-member; 400; 401 (a token bearer too) |
| POST | `/organizations/update` | session, `{ organizationId, name?, slug?, metadata? }` | `{ organization }`; 400 `invalid_body`, `slug_reserved`; 401; 403 `forbidden_rank`, `email_unverified`; 404; 409 `slug_taken` |
| POST | `/organizations/delete` | session, `{ organizationId }` | `{ ok: true }`; 400 `slug_reserved`; 401; 403 `forbidden_rank`, `email_unverified`; 404 |
| GET | `/organizations/members` | session, `?organizationId=` | `{ members }`; 400 `invalid_body`; 401; 403 `forbidden_rank`; 404 |
| POST | `/organizations/members/add` | session, `{ organizationId, userId, role }` | `{ member }`; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404; 409 `already_member` |
| POST | `/organizations/members/role` | session, `{ organizationId, userId, role }` | `{ member }`; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404 `not_found`; 409 `last_owner`, `conflict` |
| POST | `/organizations/members/remove` | session, `{ organizationId, userId, revokeTokens? }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank` (with `revokeTokens: true`, also without `apiToken:revoke`), `email_unverified`, `session_not_fresh` (with `revokeTokens: true` only); 404 `not_found`; 409 `last_owner`, `conflict` |
| POST | `/organizations/invite` | session, `{ organizationId, email, role }` | `{ invitation }` with no token; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404 `not_found`; 429 `rate_limited` |
| GET | `/organizations/invitations` | session, `?organizationId=` | `{ invitations }`; 400; 401; 403 `forbidden_rank`; 404 `not_found` |
| POST | `/organizations/invitations/revoke` | session, `{ organizationId, invitationId }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404 |
| POST | `/organizations/invitations/accept` | session, `{ token }` | `{ organization, member }`; 400 `invalid_token`, `token_expired`; 401; 403 `email_mismatch`, `email_unverified`; 409 `already_member`; 429 `rate_limited` |
| POST | `/organizations/invitations/decline` | `{ token }`, no session | `{ ok: true }`; 400 `invalid_token`, `token_expired` |
| POST | `/organizations/active` | session, `{ organizationId }` (a string or `null`) | `{ user, session }` with `session.activeOrganizationId`; 401; 403 `forbidden_rank` |
| GET | `/organizations/roles` | session, `?organizationId=` | `{ roles }`, by name, with no row of a bad shape; 400; 401; 403 `forbidden_rank` without `ac:read`. Only with `organizations.dynamicRoles` |
| GET | `/organizations/roles/get` | session, `?organizationId=&name=` | `{ role }`; 400; 401; 403 `forbidden_rank` without `ac:read`; 404 |
| POST | `/organizations/roles/create` | session (fresh), `{ organizationId, name, rank?, permissions }` | `{ role }`; 400 `invalid_body` (also a name of the config or the platform role, a rank above yours, or a rank at the owner rank); 401; 403 `forbidden_rank` without `ac:create` or for a set wider than yours, `session_not_fresh`; 409 `role_taken`, `role_in_use` while a member or a pending invitation holds the name, `role_limit` |
| POST | `/organizations/roles/update` | session (fresh), `{ organizationId, name, rank?, permissions? }` | `{ role }`; 400; 401; 403 `forbidden_rank` without `ac:update` or for a role above you, `session_not_fresh`; 404; 409 `conflict` |
| POST | `/organizations/roles/delete` | session (fresh), `{ organizationId, name }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank` without `ac:delete` or for a role above you, `session_not_fresh`; 404; 409 `role_in_use` |
| GET | `/organizations/teams` | session, `?organizationId=` | `{ teams }`, by name; 400; 401; 403 `forbidden_rank` for a non-member. Only with `organizations.teams` |
| POST | `/organizations/teams/create` | session, `{ organizationId, name }` | `{ team }`; 400; 401; 403 `forbidden_rank` without `team:create`, `email_unverified`, `hook_refused`; 409 `team_limit`; 500 `hook_failed` |
| POST | `/organizations/teams/update` | session, `{ teamId, name }` | `{ team }`; 400; 401; 403 `forbidden_rank` without `team:update`, `email_unverified`, `hook_refused`; 404; 500 `hook_failed` |
| POST | `/organizations/teams/delete` | session, `{ teamId }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank` without `team:delete`, `email_unverified`, `hook_refused`; 404; 409 `last_team` with `keepLastTeam`; 500 `hook_failed` |
| GET | `/organizations/teams/members` | session, `?teamId=` | `{ members }`; 400; 401; 403 `forbidden_rank` without `member:read`; 404 |
| POST | `/organizations/teams/members/add` | session, `{ teamId, userId }` | `{ member }`; 400; 401; 403 `forbidden_rank` without `member:update` or for a person you may not touch, `email_unverified`, `hook_refused`; 404 for a person who is not a member; 409 `already_member`, `team_member_limit`, `conflict`; 500 `hook_failed` |
| POST | `/organizations/teams/members/remove` | session, `{ teamId, userId }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank` without `member:delete` for another person, `email_unverified`, `hook_refused`; 404; 500 `hook_failed`. A member leaves with their own `userId` |
| POST | `/organizations/teams/active` | session, `{ teamId }` (a string or `null`) | `{ user, session }` with `session.activeTeamId`; 400; 401; 403 `forbidden_rank` with no active organization, for a team of another organization, or for a team that you are not in |
| GET | `/organizations/teams/mine` | session | `{ teams }`, the user's teams in every organization; 401 |
| POST | `/organizations/tokens` | session (fresh), `{ organizationId, name, permissions, expiresInDays?, metadata? }` | `{ token, apiToken }`, the `to_` token once; 400 `invalid_body` (also `permissions: null`, a window, or a quota); 401 (a token bearer too); 403 `forbidden_rank` without `apiToken:create` or for a set wider than yours, `email_unverified`, `session_not_fresh`; 404; 409 `organization_token_limit` at 50 live tokens; 429 `rate_limited` (the key of `POST /tokens`) |
| GET | `/organizations/tokens` | session, `?organizationId=` | `{ tokens }`, newest first, each with `createdById` and `creatorIsMember`; 400; 401; 403 `forbidden_rank` without `apiToken:read`, `email_unverified`; 404 |
| POST | `/organizations/tokens/update` | session (fresh), `{ organizationId, id, name?, permissions?, expiresAt? }` | the token after the change; it narrows only, as `POST /tokens/update`; 400; 401; 403 `forbidden_rank` without `apiToken:update`, `email_unverified`, `session_not_fresh`; 404; 409 `conflict` |
| POST | `/organizations/tokens/revoke` | session, `{ organizationId, id }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank` without `apiToken:revoke` (the creator has no right of their own), `email_unverified`; 404 |
| GET | `/organizations/tokens/current` | `Authorization: Bearer to_…` only | `{ organization, apiToken }`, and one call of the quota spent; 401 for any other credential; 429 `rate_limited`, `token_exhausted`; 409 `conflict` |

Without an `organizations` config none of the organization routes exist, and the router answers 404.

With hooks (see "Hooks" below), every organization write and every sign-in
can also answer 403 `hook_refused` (with `message`) and 500 `hook_failed`.
With `organizations.limits`, create answers 409 `organization_limit`, add
and accept answer 409 `member_limit`, and invite answers 409
`invitation_limit`. A sign-in whose session hook names an organization the
user is not a member of answers 404 `not_found`.

Set `appName` in the config to name the app. It is 1 to 80 characters with
no control character. The default is the host of `baseURL`. The default
pages show it in the title and the heading. The magic link mail subject is
`Sign in to <appName>`. The invitation mail subject is
`You are invited to <organization name> on <appName>`. Each page function
receives `appName` in its input.

The confirm page is `defaultConfirmPage`. Replace it with
`magicLink.confirmPage` in the config. The function returns the markup
only; core sets `cache-control`, `referrer-policy`, `x-robots-tag`, and a
content security policy that permits inline style, no script, and a form
post to this origin only. A page that needs script or a remote stylesheet
needs its own route in the app, because the policy header is fixed.

## Sessions

A use of a session after `session.slidingRefreshDays` moves its expiry
forward by `session.ttlDays`, under the cap of `session.absoluteDays`. The
refresh never moves `freshAt`.

`session.deferRefresh: true` (plan 12a, Better Auth's
`deferSessionRefresh`) moves that write from a GET request to a POST. Use
it when a GET reads from a replica or must not write.

- A GET request writes no session row: no sliding refresh, and no delete of an ended row, which the sweep deletes later.
- `GET /session` answers `needsRefresh: true` when the refresh is due, and it sends no renewed cookie.
- `POST /session/refresh` slides the expiry, renews the cookie, and answers the session or 401, with the key on or off.

The key is off by default. With it on, a client that never posts the
refresh lets an active session end at its old expiry. The client calls
`client.session.refresh()`. In process, `auth.api.session.refresh(token)`
does the same write.

## Entries for SDKs

Four entries hold the facts that an SDK reads, so each fact has one copy (plans 11d, 11g, and 12k).

- `@authtempo/core/routes`: `ROUTES`, every route that core can serve, with literal types. `RoutePath<"GET">` is the type of a GET path that core serves, so a typo in an SDK's path fails its compile. It also exports `PROVIDER_NAME_RE` and `AUTH_ERROR_PARAM` (`auth_error`).
- `@authtempo/core/credentials`: the prefixes `ts_` and `tk_`, the JWT `typ` values `JWT` and `at+jwt`, `DEFAULT_COOKIE_NAME` (`__Host-tempo_session`), `LEGACY_COOKIE_NAME` (`tempo_session`, read for one release), `readBearer`, `readSessionToken`, the compact JWS check on Web Crypto (`decodeJws`, `verifyJws`), and `resourceOf`, the rule that finds the resource a URL falls under.
- `@authtempo/core/access`: the pure checks of permission statements (`can`, `union`, `intersect`, `isSubset`, `effectiveOf`, `roleHasPermission`, `statementFault`) and `CORE_STATEMENTS`. It imports nothing, so a browser bundle can use it. The server check decides; a client check only hides a control.
- `@authtempo/core/openapi`: `openApiDocument(options)` builds the OpenAPI 3.1 document of the routes; `openApiOptionsFrom(config)` gives the options of a config, with only the features that it turns on. `openapi: true` serves the same document at `GET <basePath>/openapi.json`. The key is off by default.

`@authtempo/core/testing` still exports `ROUTES` for an app's own route tests.

### `@authtempo/core/bindings`

A third entry, of a different kind: the gate of the framework bindings (plan 11d2). Each server binding fits it to its framework, so the rule has one copy.

- `readGate(options, request, routed?, returnTo?)`: the `Gate` of a page request. `session` is the session or null. `redirect` is the 307 to the sign-in page for a protected path with no session, or null. `cookie` is the renewed session cookie after the sliding refresh, or null. A path of core reads nothing, because `auth.handle` reads and renews the session itself. `routed` is the path that the framework's router matched, with the query: a string, or a URL object that the framework parsed. The gate uses its path for the base path check and the `protect` rule. It reads the cookie from `request`, and the origin of the redirect from `request.url`, so the redirect never leaves that origin. A binding that passes no `routed` gets the raw `request.url`, which is right only when the router matches the raw path. A fourth argument, `returnTo`, is the page URL for a request whose URL is not the page URL, such as SvelteKit's `/account/__data.json` or React Router's `/account.data`. `next` holds the path and the query of `returnTo` when given, else of a routed URL object, else of `request.url`. It never comes from a routed string, because a decoded text is not a safe `next`: `/%2561ccount` decodes to `/%61ccount`, which a browser opens as `/account`. The binding passes the text its router matched and, when the request URL is not the page URL, the page URL as `returnTo`. `protect` gets the path exactly as the router matched it. The gate does not change it: no resolution of `.` or `..`, no decoding, no encoding, no merge of slashes. Of a string the gate drops the fragment and splits the query at the first `?`. A path with no leading `/` gets one, so no request throws. Of a URL object the gate takes `pathname` and `search`, as the framework parsed them. A router that decodes `%3F` or `%23` into the path makes `?` or `#` part of the path text. A binding of such a router passes the object form `{ pathname, search? }` (the type `RoutedPath`), and the gate judges `pathname` as given, with no split at `?` and no drop of `#`. The gate does not read its `search`, because `next` comes from `returnTo` or `request.url`, which hold the query. The string form keeps its split, for a router whose decode keeps `%3F` escaped. Each binding's README states how its router decodes the path and compares the case.
- `signInRedirect(url, signInPath)`: the 307 to `signInPath`, with `next` set to the path and the query of `url`. `next` gets one leading slash, and then the `safeNext` rule of core's own flows: a value with a backslash or a control character, or one that names another origin, becomes `/`. So `next` cannot name another origin. A query of `signInPath` stays.
- `withSetCookie(response, cookie)`: adds the cookie to the page's answer. An answer with fixed headers, such as one of `Response.redirect`, gets a copy.
- `checkGateOptions(options)`: a binding calls it at construction. It throws when `protect` has no `signInPath`, when `signInPath` is not a path of this origin (it must start with one `/`, not `//` or `/\`; the check reads the path with the URL parser that the redirect uses, so a tab, a newline, or a carriage return after the first `/` cannot make it another origin), and when `basePath` does not start with `/` or ends with `/`.
- `isAuthPath(pathname, basePath?)`: true for a path under the base path, not the base path itself. It answers false for a malformed base path (`""`, no leading `/`, or a `/` at the end), so a hand-made auth object with such a base path makes the gate judge every request as a page.
- `DEFAULT_BASE_PATH`: `"/auth"`, the default `basePath` of core.
- The types `GateOptions` (`auth`, `protect`, `signInPath`, `basePath`), `GateAuth` (`handle`, `session`, `sessionCookie`, and the optional `basePath` and `baseURL`), `Gate`, and `RoutedPath` (`pathname`, optional `search`).

The gate reads the base path from `auth.basePath`, the resolved `basePath` of the config, so an app names it once. `auth.baseURL` is the resolved `baseURL`. A binding that builds the request URL from the Host header uses `new URL(auth.baseURL).origin` when that header does not parse, so a bad Host gets no 500 of the binding's own. `GateAuth` has `baseURL` as an optional member, beside `basePath`, so a binding typed on it can read it.

The base path check trusts the router: a path under the base path reads no session and gets no redirect, because core answers it. So a binding mounts core for every method under the base path. A binding that mounts core for some methods only lets a catch-all page under the base path run with no gate, and the check is then no control. The `basePath` option of the gate is for a proxy that mounts core under another prefix.

The gate skips the session read and the `protect` rule only when the raw path of `request.url` and the routed path are both under the base path. When only one of them is, the gate judges the request as a page. A binding sends a request to `auth.handle` by the raw path of `request.url`, which is the path that core's router reads. A binding that sends a request to core when only the decoded path is under the base path gets a 404 from core, not a page.

## Apps on another origin

Set `appURL` to the app's origin and list it in `trustedOrigins`. Every
redirect after a sign-in then lands on `appURL` plus `next`, and errors
go to `appURL/?auth_error=<code>`. A `next` under `basePath` stays on
`baseURL`; that is how the handoff rides through a sign-in.

A trusted origin gets credentialed CORS: the router answers its
preflight with 204 and marks every response with
`Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials`.
The browser still needs the session cookie on the request. With the
default `SameSite=Lax` the cookie goes on every same-site request, so an
app on a sibling subdomain of the API works as is. An app on another
site needs `cookie: { sameSite: "None" }`; then any site can make the
browser send the cookie, and the Origin rule on POST is what refuses
them. The session cookie is `__Host-tempo_session` and the binding cookie
is `__Secure-tempo_session_oauth` (plan 12b).

Every POST also passes the Fetch Metadata rule. A form post (a form,
multipart, `text/plain`, or no content type) needs `Sec-Fetch-Site` to be
`same-origin` or `none`. A JSON post from another site (`cross-site` or
`same-site`) needs a trusted `Origin`. A request with no `Sec-Fetch-Site`
passes. A refusal answers 403 `origin_not_trusted`. Apple's callback skips
both rules: Apple posts it from its own site.

## Handoff for native and desktop apps

Set `handoff: { schemes: ["consumera://"] }`. The app makes a PKCE
verifier and its S256 challenge, then opens the system browser at
`GET /auth/handoff/start?challenge=<c>&redirect=consumera://auth`. Core
shows the sign-in page: a magic link form, the configured social
buttons, a passkey button, and, with a `password` config, an email and
password form with a Forgot password button.
With a `password` config the form also has a Create account button. It
posts the email and the password to `POST /auth/password/sign-up`; that
answer sets the session cookie, and the page goes on to the continue
path. Every method ends by visiting
`/auth/handoff/continue?h=<id>` on the API origin, which shows a confirm
page. When the person presses the button, core mints a one-time code and
redirects to `consumera://auth?code=<code>`. The app
then calls `POST /auth/handoff/redeem { code, verifier }` and keeps the
bearer token. A code lives two minutes and redeems once; a start lives
ten minutes, or as long as a magic link if that is longer.

The continue is a consent step. A signed-in browser sees a page that names the account and the app, and the code is minted only when the person presses the button. The post is accepted from the API origin only.

In development `devRedirectPattern` admits a full redirect URL, for
example `/^exp:\/\/[\d.]+:\d+\/--\/auth$/` for Expo Go. Core refuses a
pattern with the `g` or `y` flag, and refuses any admitted `http` or
`https` URL that is not on a loopback host.

The handoff confirm page adds the source of the matched dev redirect to
`form-action`: its scheme (`exp:`), or the origin of a loopback URL
(`http://127.0.0.1:8081`). A dev redirect on `[::1]` cannot be listed.
Use `127.0.0.1`.

`signInPage` replaces the page. The function gets the base path, the continue
path, the enabled methods, and the script nonce. It must put the nonce on its
script tag. The `methods` input has the flags `magicLink`, `google`, `apple`,
`passkey`, and `password`, and `providers`, a list of `{ name, label }` for
every configured provider other than Google and Apple. `password` is true when
the config has a `password` section. A custom `signInPage` must render
`methods.providers`, or the buttons for GitHub, LinkedIn, and the list
providers do not show. `@authtempo/handoff` (plan 5b) does the app side.

## Social sign-in

Configure `social.google` with `{ clientId, clientSecret }` and
`social.apple` with `{ clientId, teamId, keyId, privateKey }`. The Apple
`clientId` is the Services ID, and `privateKey` is the PKCS#8 PEM from the
developer portal. Core signs a five-minute Apple client secret on every
token exchange, so nothing stored expires. Rotate the key in the portal
and change `privateKey`.

Register `<baseURL><basePath>/social/<provider>/callback` as the redirect
URI at the provider. The flow sends `state`, a PKCE S256 challenge, and, for
an OpenID Connect provider, `nonce`. Apple's support for PKCE is unverified;
the state, the nonce, and the binding cookie bind the exchange without it.
Core sends the client secret in the token request body (`client_secret_post`).
A provider that expects `client_secret_basic` answers `invalid_client`.

Linking: a social identity links to an existing user only when the
provider reports the email as verified and it equals the user's email.
A signed-in user links a provider with `POST /social/:provider/link`
(see "Account").
Otherwise core creates a new user, or answers `email_taken_unverified`
when the address is in use. A profile with no email answers
`email_required`.

An account created through an unverified email is a claim. When a sign-in
proves the address (a magic link, or a provider that reports the email
verified), core deletes that user's other identities and every session,
then marks the email verified. The claimant loses access; the owner keeps
the account.

GitHub and LinkedIn are presets: `social.github` and `social.linkedin` each
take `{ clientId, clientSecret }`. GitHub issues no ID token, so core reads
`GET https://api.github.com/user` and `GET https://api.github.com/user/emails`
with the access token, under the scope `read:user user:email`. The subject is
the numeric GitHub id. The address counts as verified only when the primary
address has `verified: true`. A person whose primary address is unverified
gets a new unverified account, or `email_taken_unverified` when the address
has an account. Core never links it. LinkedIn: core reads
`GET https://api.linkedin.com/v2/userinfo` with the access token, under the
scope `openid profile email`, as Better Auth does. The subject is LinkedIn's
`sub`. Core ignores LinkedIn's ID token. Add the product "Sign In with
LinkedIn using OpenID Connect" to the LinkedIn app.

Any other provider is a list entry. `social.oidc` takes OpenID Connect
providers, and `social.oauth2` takes providers that issue no ID token. A
`name` matches `^[a-z][a-z0-9-]{0,31}$`, is unique across both lists, and is
not `google`, `apple`, `github`, `linkedin`, `email`, or `credential`. The
`label` is the button text on the sign-in page. An `oidc` entry reads
`<issuer>/.well-known/openid-configuration` on its first start and keeps the
endpoints for the life of the `createAuth` instance. The document's `issuer`
must equal `issuer` exactly. Set `endpoints` and core never reads the
document, so a sign-in does not depend on the provider's discovery at
request time.

```ts
social: {
  github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
  oidc: [
    {
      name: "microsoft",
      label: "Continue with Microsoft",
      issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
      clientId: env.ENTRA_CLIENT_ID,
      clientSecret: env.ENTRA_CLIENT_SECRET,
    },
  ],
  oauth2: [
    {
      name: "discord",
      label: "Continue with Discord",
      authorizeUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      scope: "identify email",
      async userinfo(accessToken, fetch) {
        const res = await fetch("https://discord.com/api/users/@me", {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error(`discord answered ${res.status}`);
        const u = (await res.json()) as {
          id: string;
          email?: string | null;
          verified?: boolean;
          global_name?: string | null;
        };
        return {
          subject: u.id,
          email: u.email ?? null,
          emailVerified: u.verified === true,
          name: u.global_name ?? null,
          image: null,
        };
      },
    },
  ],
},
```

The Microsoft and Discord entries are examples. Core does not test them.
Check each endpoint and claim in the provider's documentation on the day you
configure it. Microsoft Entra ID sends no `email_verified` claim by default,
so an Entra sign-in never links to an existing account by its address.

`userinfo` gets the access token and a fetch. Call the provider with that
fetch: core puts a 10 s limit on it, and the whole step stops at 10 s.
Answer `emailVerified: true` only when the provider says that this person
proved the address. Core counts no other value as verified. Core never
stores or logs the access token, and a failure logs the error name, never
its message.

`social.fetch` and `jwt` exist for tests: inject a fetch for the token
endpoint and a fake verifier, so no test reaches a provider.

## Passkeys

Set `passkey: { rpID, rpName, origins }`. `rpID` is the registrable
domain the credentials bind to, and every origin in `origins` must be on
it (the host equals it or ends with `.<rpID>`). Registration needs a
session and a verified email. Sign-in uses a discoverable credential, so
the options carry no credential list, and both ceremonies require user
verification. Every origin in `origins` must also be `baseURL` or in `trustedOrigins`, or the router refuses its posts; `resolveConfig` checks this.

The browser side is `navigator.credentials.create(options)` and
`navigator.credentials.get(options)` with the options JSON from the
routes (through `PublicKeyCredential.parseCreationOptionsFromJSON` and
`parseRequestOptionsFromJSON`), and the credential's `toJSON()` goes back
as `response`. Plan 5's client package wraps this.

`@authtempo/core/testing` exports `SoftAuthenticator`, a software
authenticator on Web Crypto that produces both responses, so an app's
tests prove the whole flow without a browser.

The passkey name rule (plan 12a): a name is a string of 1 to 64 code
units, under the character rule of a user name (see "Account"). A bidi
override or a zero-width space must not make one passkey read as another in
a device list. The rename refuses a name that breaks the rule. The
registration never refuses a credential for its name, because the device
has made the credential by then. It stores a name that is blank after the
trim, or that breaks the rule, as no name. The rename
(`POST /passkeys/rename`, `api.renamePasskey`) needs a session, not a fresh
session. It sends no notice, because a name is not a credential. The id of
another user's passkey answers `not_found`, as an unknown id does, by the
same calls. Its limit is `passkey-rename:user:<userId>` (see "Account").

`webauthn` in the config replaces the seam. The default is
@simplewebauthn/server 14.0.3, which runs on Workers without
`nodejs_compat` (proved by the example Worker's spike test).

## Passwords

Set `password: {}` to turn on password sign-in. The fields are all
optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `hash` | `createPbkdf2PasswordHash()` | The hash seam. It has `hash`, `verify`, and `dummy`. |
| `minLength` | 8 | The lower bound, 8 to 128. Counted in code points. |
| `breachCheck` | none | `(plain) => Promise<boolean \| "unavailable">`. True refuses with `password_breached`. `"unavailable"` refuses with 503 `breach_check_unavailable`: the check fails closed. `@authtempo/breach-check` answers it. |
| `resetTtlMinutes` | 15 | The life of a reset link, 1 to 1440. |
| `resetPage` | `defaultResetPage` | The HTML of the reset page. |
| `requireVerified` | `false` | True refuses the password sign-in of an unverified address. |
| `uniformSignUp` | `true` | Every sign-up answers `{ sent: true }` with no session. A known address gets a mail. False keeps a session at sign-up and `email_taken`. |
| `existingAccountMail` | `defaultExistingAccountMail` | The mail to a known address at a uniform sign-up. Core sends it to the address. |

The default hash is PBKDF2-HMAC-SHA256 on Web Crypto. A hash is stored as
`pbkdf2-sha256$<iterations>$<salt>$<hash>`. The salt is 16 random bytes and
the output is 32 bytes, both in base64url. The default cost is 100000
iterations, because Workers refuses a higher count. `maxIterations`
(default 100000) is the highest cost the seam hashes or verifies. A stored
hash above it answers `{ ok: false, rehash: false }` and never runs. A
hash with a lower cost verifies, then the engine rehashes it at the next
sign-in.

The default cost needs more CPU than Workers Free allows (10 ms per
request). A deployment needs Workers Paid.

A password is hashed as given, with no Unicode normalization. A person who
types the same text in another normal form does not sign in.

A sign-in for an unknown address, or for a user with no password, verifies
against a dummy hash. The seam builds the dummy on first use and keeps it,
so the time is the same. A hash error never reaches the caller: the answer
is `invalid_credentials`.

A magic link or a provider proof of an unverified address deletes that
user's password, as it deletes the other credentials of a claimant. The
verify link keeps the password it confirms.

A reset of a verified user ends every session and keeps the passkeys and
social identities. A reset of an unverified user claims the address. A
reset writes the new password before it deletes the sessions. A reset of
a verified user also deletes the user's pending handoff codes. Every reset
deletes the address's other pending reset links. A password change writes
the new password first, deletes every other session, and deletes the
user's pending handoff codes. It keeps the current session. A change also
deletes the address's pending reset links (added 2026-10-10 by the plan 8
final fix wave).

`requireVerified` (plan 12b). The default is `false`, because core signs in
an unverified password user since plan 8 (spec 8.7). A default of `true`
would lock out each unverified user of a live app at the upgrade. With the
key on, a sign-in checks the password first, then rehashes, then checks the
address. A wrong password answers `invalid_credentials` as before. A right
password of an unverified address answers `email_unverified` (403) and
opens no session and no challenge, so only a person who knows the password
learns that the address is unverified. A new verify link goes out first. It
counts on `password-resend:email:<email>`, the key of the resend route, so
at most 3 links go per 15 minutes. Over the limit, no mail goes, and the
answer stays `email_unverified`. Under `signUp: "invited"` the sign-in does
the same check, whatever `requireVerified` says: a stranger who signs up at
an invited address cannot sign in before the address is proved. The other
pending links of the address go first, so one link at a time is live.
With `uniformSignUp: false`, a sign-up with the key on writes the user and
the password, mails the link, and opens no session: it answers 200
`{ user, verifyRequired: true }` with no cookie, and the session hooks do
not run. The verify link signs the person in.

`uniformSignUp` (plan 12b, ASVS 5.0.0 6.3.8). Every sign-up that passes the
body check, the policy, and the breach check answers 200 `{ sent: true }`
with no cookie. A new address gets the unverified user, the password, and
the verify link, and the link opens the session. A known address gets no
row and one mail that points to the sign-in, and a claim race or a refusal
by `signUp: "invited"` gets no row and no mail. Under `"invited"` the
invitation check runs first, so a known address with no pending invitation
gets no mail. The hash runs before the
transaction on every path, but the transaction of a new address writes
more than the read of a known one, so core does not claim 6.3.8 in full.
Under `"invited"` only a new address with an invitation gets the rows and
the verify mail, so the time of the answer can show that an invitation
exists. That tells less than whether an account exists.

`breachCheck` (plan 12b, ASVS 5.0.0 6.2.12). The check fails closed, and
core holds no list of breached passwords. An answer of `true` refuses the
password with 400 `password_breached`. An answer of `"unavailable"`
refuses it with 503 `breach_check_unavailable`: the person tries again
later. A throw of the function answers 500, because it is a fault of the
app's function, not an outage. The sign-up, the reset by link, the reset
by code, and the change run the check. The sign-up and both resets run it
before any read of a user, so a known and an unknown address get the same
answer. A refused reset link stays usable. A refused reset code is spent,
so after an outage the person asks for a new code. In the sign-up, the
check runs after `password-sign-up:ip` and the captcha, and before
`password-sign-up:email`. `@authtempo/breach-check` answers the port with the HIBP
Pwned Passwords range API.

A reset of a user with the second factor on opens no session (plan 12c).
It sets the password and ends every session, as before. Then it writes a
challenge, as the last write, and answers it: JSON 200
`{ twoFactor: { challenge, expiresAt, methods } }`, or a 302 of the form
to the challenge page. A trusted device skips the challenge. A reset never
turns the factor off: a person who holds the mailbox and not the factor
gets a new password and still meets the factor. The reset by code does
the same.

The limits, in the same limiter as the other routes:

| Key | Limit |
| --- | --- |
| `password-sign-up:ip:<ip>` | 10 per hour |
| `password-sign-up:email:<email>` | 5 per hour |
| `password:ip:<ip>` | 20 per 15 minutes |
| `password:email:<email>` | 10 per 15 minutes |
| `password-reset:ip:<ip>` | 20 per 15 minutes |
| `password-reset:email:<email>` | 5 per 15 minutes |
| `password-reset-post:ip:<ip>` | 20 per 15 minutes |
| `password-resend:ip:<ip>` | 20 per 15 minutes |
| `password-resend:email:<email>` | 3 per 15 minutes |
| `password-change:user:<userId>` | 10 per 15 minutes |

`<ip>` is an IPv4 address, the IPv4 form of a mapped IPv6 address, or the
`/64` prefix of another IPv6 address (`ipKey`). One `/64` shares each count.

The `password:email` limit is a trade-off: 10 wrong tries from anyone stop
password sign-in for that address for 15 minutes. The magic link still
works for the owner. Without the limit, a guess run on one account from
many IP addresses has no bound. Recorded 2026-10-10 by the plan 8 final
fix wave.

The reset POST checks its limit, then reads the link row, then the policy,
then the breach check, then hashes. A transaction consumes the link first.
A spent or expired link costs no breach call and no hash.

## Captcha

`captcha: { port, flows?, onUnavailable? }` puts a captcha on the flows that
send mail or write rows. Core names no supplier, and
`@authtempo/captcha-turnstile` answers the port.

- The token comes in the header `x-captcha-response`, and the preflight answer lists it.
- The default flows are `password-sign-up`, `magic-link-request`, `email-otp-request`, and `password-reset-request` (the reset link and the reset code).
- `password-sign-in` is off by default; name it in `flows` to check every sign-in.
- Each flow runs its per-IP limit, then the captcha, then its per-email limits and its work. The per-IP limit bounds the captcha calls.
- A request with no token spends no per-email limit, so a bot cannot block the mail to an address. In the sign-up, it costs no policy check and no breach call.
- The captcha runs before the flow reads a user, so its answer is the same for every address.
- No token answers 400 `captcha_required`; a refused token, or a token over 2048 characters, answers 403 `captcha_failed`.
- When the port gives no answer or throws, `onUnavailable: "allow"` (the default) writes one log line and goes on, and `"refuse"` answers 503 `captcha_unavailable`.
- An in-process `api` call with no `captchaToken` skips the check. An app that proxies a browser request through `api` must pass the browser's token as `captchaToken`; without it, the check does not run.
- While core serves its own sign-in page (`handoff` or `oauth`, with no `handoff.signInPage`), `captcha.port.page` is required when a gated flow is on that page.
- The page has the magic link form, and the password forms only with `password`. Without the widget, each gated flow on it answers `captcha_required`.
- With `port.page`, core's sign-in page loads the widget's script under its nonce, adds the widget to the magic link and password forms, and adds `cspSources` to `script-src` and `frame-src`.

## Email codes

Since plan 9e core signs a person in by a code from the mail, and resets a
password by a code. A code is for a device whose mailbox is elsewhere, such
as a phone app, a desktop app, or a CLI, or whose mail client strips links.
It follows the magic link's rules: the request tells nothing about the
account, a right code proves the address, and the claim rule applies. The
sign-in page does not change: a browser has the magic link.

Email codes are on by default. `emailOtp: false` turns them off.

| Field | Default | Meaning |
| --- | --- | --- |
| `ttlMinutes` | 10 | The life of a code, 1 to 60. |
| `length` | 6 | The digits of a code, 6 or 8. |
| `maxAttempts` | 5 | The wrong guesses that spend a code, 3 to 10. |
| `mail` | `defaultEmailOtpMail` | `({ email, code, ttlMinutes, appName }) => MailMessage` for the sign-in code. |
| `resetMail` | `defaultResetOtpMail` | The same, for the reset code. |

Core sends each code mail to the address the code belongs to, whatever
`to` the builder answers.

- One code per address and purpose is live. A new request spends the
  earlier code, so the code of an older mail answers `invalid_code`.
- A wrong code counts one guess. The guess that reaches `maxAttempts`
  spends the code and every other live code of the address and purpose,
  and answers `too_many_attempts`. Every later try answers the same until a
  new request, also when two parallel requests left two live codes. A right
  code after the cap does not sign in.
- A wrong code, an expired code, a spent code, and an address with no code
  answer `invalid_code`. Core does not tell them apart.
- The stored value is HMAC-SHA256 under `secret` of the row id and the
  code. A copy of the verification table gives no code without the secret.
  After a change of `secret`, every live code answers `invalid_code`.
- The guess count is a compare-and-set on the row's `updatedAt`, so
  parallel guesses all count, on D1 and on Postgres. The storage
  conformance suite pins `eq` on a date to the millisecond on every
  adapter. The count stops after `maxAttempts + 1` rounds and answers
  `invalid_code`, with the log line `authtempo: email code count gave up`
  and the row id, so a storage that never matches cannot hold a request.
- One address gets at most 20 codes per 24 hours, for both purposes
  together (`otp:email-day:<address>`), after the 15-minute limits. So one
  address takes at most 100 guesses a day with the defaults.
- A reset by code runs the reset link's path: the policy, the breach
  check, the new password, the end of every session, the claim rule, and a
  new session. A password that the policy or the breach check refuses
  spends the code: request a new one. A reset of either kind spends the
  live reset links and codes of the address, and so does a password change.

The odds that an attacker who never sees the mail guesses a code, with the
defaults and a limiter that the product owns (D1 or Postgres):

| Scope | Guesses at most | Odds of a takeover |
| --- | --- | --- |
| One code | 5 | 5 × 10⁻⁶ |
| One address, one day | 100 (20 codes × 5) | 1 × 10⁻⁴ |
| One address, one year | about 36,500 | about 3.6 % |

The attack is loud: at full rate the address gets 20 code mails a day.
`length: 8` divides each figure by 100, so use it for high-value accounts.
The memory limiter is per isolate: on Workers the request and verify
budgets, the daily cap too, multiply by the isolate count. The per-code cap
stays global, because it lives in the row.

```ts
import { createClient } from "@authtempo/client";

const client = createClient({ baseURL: "https://api.example.com" });
await client.emailOtp.request({ email });
const signedIn = await client.emailOtp.verify({ email, code }); // { token, user, session }
```

## Second factor

The second factor (plan 9f, plan 12c) is on when `password` is set. Its config key is `totp`, and `totp: false` turns it off. A user turns on one or more methods for their own account. The first step of each method proves the password, because a session alone must not turn the factor on: a person with a stolen session could enroll their own method, and the enable then ends the owner's other sessions. A wrong password answers `invalid_credentials` and writes no row.

| Method | Turn it on | Pass a challenge with |
| --- | --- | --- |
| `totp` | `POST /totp/setup` with the password answers the secret and the `otpauth://` URI for a QR code, once; then `POST /totp/enable` with a current code within 15 minutes | `code` |
| `passkey` | `POST /second-factor/passkey/enable` with the password and a sign-in assertion by a passkey of the user. Needs `passkey` | `passkey`, over `POST /second-factor/passkey/options` |
| `email` | `POST /second-factor/email/enable` with the password | `emailCode`, after `POST /second-factor/email/send` |
| `backup` | The first method answers 10 backup codes, once | `backupCode` |

- The first method creates the factor row, answers the backup codes, ends every other session, and deletes the trusted devices and the challenges. A later method adds itself to the row and answers no codes. A TOTP setup while another method is on answers an empty list.
- `ta_second_factor` holds one row per user with the factor on: the methods, the backup code hashes, and `backupCodesVersion`. Migration `0008_schema_v8` copies each confirmed `ta_totp` row into it with `["totp"]` and version 1. It also deletes each `ta_totp` setup that no enable confirmed: a setup open across the deploy answers `totp_not_enabled` at the enable, and the person sets up again. A code of version 1, 8 to 12 characters, keeps working until the next regeneration.
- A backup code has 23 characters, `totp.backupCodeLength` 23 to 32, shown in groups such as `abcde-fghjk-mnpqr-stuv-wxyz`. 23 characters of the 31-letter alphabet hold 113.9 bits, above the 112 bits of ASVS 5.0 6.5.2. The check ignores the dashes and the case.
- The gate: a password sign-in, a magic link, an email code sign-in, social, and a reset of a user with the factor on answer a challenge, not a session. `totp.gate.magicLink`, `totp.gate.emailOtp`, and `totp.gate.social` turn one gate off. Each is `true` by default, because a method with no gate lets the holder of a mailbox past the factor. The password and the reset have no key. A passkey sign-in has no gate: a passkey is a factor of its own. The handoff has no key: it continues a browser session that passed the gate.
- A challenge lists its `methods` in the order `passkey`, `totp`, `email`, `backup`. `email` is in the list only after a password sign-in: after a magic link, an email code, social, or a reset the mailbox was the first factor (owner decision 4). `passkey` is in the list only with the `passkey` config. `backup` is in the list while a code is left.
- The TOTP code: RFC 6238 with SHA-1, 6 digits, 30 seconds, one step before and after now. A code passes once: the write of the last step is the check.
- A challenge lives 5 minutes and takes 5 wrong codes. Every code check, of a TOTP code, a backup code, or an email code, counts on two per-user limits. A passkey assertion counts on none: it is not a guess. These two limits bind an attacker who has the password.
- An email code has 6 digits. It lives with its challenge, at most 5 minutes, below the 10 minutes of ASVS 5.0 6.5.5. It is bound to its challenge (6.6.2). A new send replaces it. The mail is `totp.emailMail`, `defaultSecondFactorMail` by default, to the user's address.
- The methods turn off in two ways. `POST /second-factor/disable` turns the passkey or the email method off with the password alone. `POST /totp/disable` turns TOTP off only with a code. So TOTP needs a code to turn off. But a person with the password and a fresh session can turn the passkey and the email methods off. The last method turns the factor off. `api.totp.disable({ userId })` turns every method off in process.
- A passkey that is the last passkey of the user stays while the passkey method is on: its delete answers `second_factor_last_method`.
- A trusted device skips the factor for `totp.trustDays` (default 30). Its cookie `tempo_totp_trust` has the path `<basePath>/`. A JSON caller sends the `td_` token as `trustDevice`. The challenge page shows a trusted-device button when the browser sends the cookie on the GET: an Apple callback is a cross-site POST, and a Lax cookie does not come with it. The first method and the disable of the last method delete the user's trusted devices.
- The per-user limits have a cost: a person who has the password, or a stolen session, can use up the budget with wrong codes. Until the window ends, the owner's verify, enable, and disable answer `rate_limited`. Better Auth's account lockout has the same effect. A stale session counts no try at an enable or a disable: the fresh rule answers first (plan 12a).
- A wrong password at an enable counts on its own key, `totp-setup:user`, and not on the sign-in's limits, so a stolen session cannot hold the owner's password sign-in at `rate_limited` from there (plan 9h). The TOTP setup, each method enable, and `POST /second-factor/disable` share its one budget of 5 per 15 minutes. The trade of owner decision 3a: a stolen session can still use up this budget, and until the window ends the owner's own enable and disable answer `rate_limited`.
- The TOTP secret is sealed with AES-256-GCM under a key from `secret`. A backup code and an email code are HMAC-SHA256 under `secret`. A new app `secret` opens no sealed secret and matches no code. Before you change `secret`, have each user turn the factor off, or turn it off for them with `api.totp.disable`.
- A lost factor: a person with no method and no backup code left cannot pass the challenge. A reset does not turn the factor off. The operator turns it off with `api.totp.disable({ userId })` after identity proofing at the level of the enrollment (ASVS 5.0 6.4.4). The site's runbook "Second factor recovery" gives the steps.

The limits of the second factor, in the same limiter as the other routes:

| Key | Window | Count | Covers |
| --- | --- | --- | --- |
| `totp-verify:ip:<ip>` | 15 minutes | 30 | The verify and the challenge page POST |
| `totp-code:user:<userId>` | 15 minutes | 10 | Every code check: a TOTP code, a backup code, or an email code |
| `totp-code:user-day:<userId>` | 24 hours | 30 | Every code check, as above |
| `totp-setup:user:<userId>` | 15 minutes | 5 | The password check of the TOTP setup, of the passkey and the email enable, and of `POST /second-factor/disable` |
| `second-factor-passkey:ip:<ip>` | 15 minutes | 30 | The passkey options of a challenge |
| `second-factor-email:user:<userId>` | 15 minutes | 5 | The email code sends |
| `totp:email-day:<email>` | 24 hours | 20 | The email code sends of the second factor |

Two counts live in the row and stay global: 5 wrong codes per challenge, and 3 email sends per challenge.

`totp:email-day:<email>` and `otp:email-day:<email>` read one cap, `MAILED_CODES_PER_EMAIL_DAY` in `verification.ts`: one number, two keys (owner decision of 2026-10-14). The keys are apart because `POST /otp/request` needs no password. A person who knows the address must not use up the mails of the second factor.

There is no per-account lockout. The sign-in's 10 per address and the 5 codes per challenge allow 50 challenge guesses per address per 15 minutes; the shared per-user limits stop the verify at 10 code checks per user in that window and 30 in a day. One guess of a TOTP code passes with odds of 3 in 10⁶ (the three codes of the window). The odds of a takeover by an attacker who has the password, at the full rate of a TOTP code:

| Bound | Guesses | Odds of one success |
| --- | --- | --- |
| One challenge | 5 | 1.5 × 10⁻⁵ |
| One account per day | 30 | 9 × 10⁻⁵ |
| One account per year | 10,950 | about 3.2 % |

The limits are per isolate under the memory limiter: on Workers each isolate counts on its own, so the per-user budgets multiply by the isolate count. The owned D1 and Postgres limiters count once.

- `api.totp` holds the TOTP operations in process. `api.totp.setup({ userId, password, ip })` takes the password, as the route does; `ip` is not read since plan 9h. `api.password.verify({ userId, password, ip })` checks a password again with the sign-in's limits.
- The default issuer is `appName`, and with no `appName` the host of `baseURL` with no port. A default that holds a colon (an IPv6 `baseURL` such as `http://[::1]:8787`, or an `appName` such as "Acme: Notes") stops `createAuth` with a message that names `totp.issuer`: the key URI uses the colon to split the issuer from the account. Set `totp.issuer`, or `totp: false`.

## JWT minting

`jwtMint` (plan 9g) is on by default; `jwtMint: false` removes `/jwks`, `/token`, `/token/live`, and `api.jwt`. A session JWT is a signed statement about a session user for a server that cannot call `auth.session`.

- The key: `jwtMint.alg` is `EdDSA` (Ed25519, the default), `ES256` (ECDSA P-256), or `RS256` (RSA 2048, plan 12e). Every JWT of the deployment signs with it. Core writes the first key at the first use, seals the private half with AES-256-GCM under a key from `secret`, and opens it for one signature at a time. `api.jwt.rotate()` makes a new key; the old one verifies for 24 hours and signs nothing, and the sweep deletes it after that. A new app `secret` opens no old key: the key retires at the next signature with one log line, and a new key signs.
- The timer (plan 11c): `jwtMint.rotateEvery` is a whole number of days from 1 to 365, and off by default. The first signature with a key that old retires the key and signs with a new one. A JWKS read never rotates. Two signatures at once make one new key: the retire matches the old row by id and slot, and the unique key on `slot` keeps one new row. The retired key verifies for 24 hours, as after `api.jwt.rotate()`.
- The operator routes (plans 11c and 11c2): `operator: { secretHash }` turns
  on `POST /operator/keys/rotate`, `GET /operator/secrets/status`, `POST
  /operator/secrets/rewrap`, and `GET /operator/info`, and it is off by
  default. `secretHash` is the SHA-256 of the operator secret as 64
  lowercase hex characters; core stores no secret. Core hashes the presented
  secret and compares the digests in constant time. Make the secret from 32
  random bytes or more (`openssl rand -base64 32`), and hash it with
  `printf '%s' "$SECRET" | shasum -a 256`. The secret must be 32 to 512
  visible ASCII characters, and any other secret answers 401 with no reason.
  The secret is not an API token: no user owns it. `authtempo keys rotate`
  calls the rotation. With `jwtMint: false`, `keys/rotate` does not exist,
  and the three other routes answer.
- Two live versions: during a gradual deployment, two versions of the app with different secrets, or with different `jwtMint.alg` values, retire each other's key at each mint. The JWKS then grows by one key per mint for 24 hours (core lists the signing key and at most 100 retired keys, the last retired first), and a mint can throw after three tries (`authtempo: no signing key after three tries`). Finish the deployment: when one version serves every request, one key signs again.
- The token: header `{ alg, kid, typ: "JWT" }`. The claims are `iss` (`baseURL + basePath`), `sub` (the user id), and `aud` (`jwtMint.audience`, default `baseURL`). Then come `iat`, `exp` (`jwtMint.ttlMinutes`, 1 to 60, default 15), and `sid` (the session id). Then come `email`, `email_verified`, `name`, and `org` (the active organization id or null). The JWT of an impersonation session (plan 12f) adds `act: { sub }` with the operator's user id (RFC 8693 section 4.1). Its `exp` is no later than the session's fixed expiry. `jwtMint.claims(user, session)` adds names and sets none of these, nor `nbf`, `jti`, or `act`.
- A resource server verifies the signature against `<basePath>/jwks`, `iss`, `aud`, `exp`, and the header `typ`: `JWT` for a session JWT, `at+jwt` for an OAuth access token (with jose, `jwtVerify(token, jwks, { issuer, audience, typ: "JWT" })`). One key signs both kinds with one issuer, so a server that skips `typ` can take one kind for the other. It keeps the key set in a cache. The token is a bearer for its life: a sign-out does not end it. Keep `ttlMinutes` short, and where a sign-out must end access at once, check the `sid` claim with `api.jwt.sessionLive({ sid })`: true while the session exists and is not expired.
- The live check (plan 11d): `POST <basePath>/token/live` with the session JWT as the bearer answers `{ live: true }` while its session exists and is not expired, else `{ live: false }`. Any other bearer answers 401, counts nothing, and reads no session. A valid JWT counts on `token-live:session:<sessionId>`, 120 per 60 s. A resource server on another host calls it where a sign-out must end access at once; `@authtempo/verify` calls it with `checkSessionEnd: true`.
- Core refuses a config where a `jwtMint.audience` entry is also an `oauth.resources` entry: a server of that audience would take an access token of any client and scope as a session JWT. The default audience is `baseURL`, so a resource equal to `baseURL` needs its own `jwtMint.audience`.
- `api.jwt.mint({ userId, sessionId })`, `api.jwt.verify(token)` (this instance's session JWTs only), `api.jwt.rotate()`, `api.jwt.jwks()`, `api.jwt.sessionLive({ sid })`, and `client.jwt.token()` hold the same operations.

## OAuth 2.1 and OIDC provider

`oauth` (plan 9g) makes core the authorization server for agents and MCP clients. It is off by default. With `oauth` set, `oauth.resources` must name 1 to 20 resources, and core refuses the config with `jwtMint: false`.

```ts
import { readBearer, readSessionToken, sessionCookieNames } from "@authtempo/core/credentials";
import { insufficientScopeResponse, unauthorizedResponse } from "@authtempo/verify";

// A bearer and no session cookie: core lets a cookie win and never reads the bearer.
const refusedBearer = (request: Request) => {
  if (readBearer(request) === null) return false;
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  return readSessionToken(sessionCookieNames(), { headers }) === null;
};

const auth = createAuth({
  // ...
  oauth: {
    resources: ["https://api.example.com/mcp"],
    scopes: { "mcp:tools": "Use your tools" },
    // A client id may be the https URL of its metadata document. Pass your
    // own fetch that refuses private addresses, or set registration.cimd to false.
    fetch: guardedFetch,
  },
});

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/.well-known/")) return auth.wellKnown(request);
    if (url.pathname.startsWith("/auth/")) return auth.handle(request);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const resource = "https://api.example.com/mcp";
      const c = await auth.caller(request);
      // @authtempo/verify writes the challenge of RFC 6750 and RFC 9728, with the
      // scope that MCP 2026-07-28 asks for in the 401 and the 403.
      if (c?.kind !== "oauth")
        return unauthorizedResponse({
          resource,
          scope: "mcp:tools",
          invalidToken: refusedBearer(request),
        });
      // Check the scope of each tool: a token with only openid must not call it.
      if (!c.scopes.includes("mcp:tools"))
        return insufficientScopeResponse({ resource, scope: "mcp:tools" });
      // c.user, c.clientId, c.scopes, c.resource
    }
    return new Response("not found", { status: 404 });
  },
};
```

- `auth.wellKnown` serves, at the origin root, the authorization server metadata (RFC 8414) at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server<basePath>`, the same document at `/.well-known/openid-configuration` and `/.well-known/openid-configuration<basePath>`, and the protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource<path>` for each resource. The root form `/.well-known/oauth-protected-resource` answers the first resource on the request's origin. Every document is public, with `access-control-allow-origin: *`. A method other than GET answers 405, `OPTIONS` 204, and any other path 404.
- `POST /oauth/register` is off by default since plan 12e: `oauth.registration.dynamic` turns it on. A client registers there, or its client id is the https URL of its metadata document. Core fetches the document through `oauth.fetch` with `redirect: "manual"`, 10 seconds, and 8 KB. It keeps the document one hour per isolate. The document's `client_id` must equal its URL. Core implements draft-ietf-oauth-client-id-metadata-document-02 and accepts the documents of -00. Core refuses a document with `client_secret`, `client_secret_expires_at`, or a method other than `none` or `private_key_jwt` (-02 section 4.1). A document cannot change at the request of this server. So core drops a member that it does not serve, and it writes a warning with the member name. Core drops each entry of `grant_types` or `response_types` that it does not serve, and an `id_token_signed_response_alg` other than `jwtMint.alg`. A pairwise document loses `sector_identifier_uri` and the device grant of its `grant_types`. Core drops a `backchannel_logout_uri` that is not valid, is off the host of the document, or has no `oauth.fetch` to post to it. It also drops a `backchannel_logout_session_required` that is not a boolean. A document with no `authorization_code` grant or no `code` response type is refused. When a document changes from `private_key_jwt` to `none`, core revokes every refresh token and deletes every device code of the client in the same write. So a client id alone cannot refresh a grant or poll a device code that needed a key. A `private_key_jwt` document with `jwks` or `jwks_uri` is a confidential client, and it authenticates by a client assertion. Core refuses a document URL that is not in canonical form. It also refuses a URL whose host is an IP literal, `localhost`, a single label, or a `.local`, `.home.arpa`, or `.internal` name. The host of `baseURL` on any port is refused too. A public name can still resolve to a private address, so `oauth.fetch` must refuse private addresses too.
- A redirect URI is https, http on 127.0.0.1 or localhost with any port, or a private-use scheme, and it must match exactly. Registration refuses `http://[::1]`: the consent page's policy cannot name an IPv6 literal, so a loopback client uses 127.0.0.1.
- The authorize step sends a browser with no session to core's sign-in page and back. It refuses an unverified user. `prompt=login`, `max_age=0`, and a sign-in older than `max_age` seconds send the person to the sign-in step again (plan 12e). The held request then goes on only with a session signed in at or after the request. `prompt=none` answers `login_required` in place of the page. The ID token carries `auth_time`, the session's `freshAt`, else its `createdAt`. A handoff session keeps the sign-in time of the browser session, so it is not a new sign-in. The fresh rule of plan 12a reads that time too. `oauth.signInURL` replaces core's sign-in page with the app's own route, which gets `?request_id=oq_…` alone. The route must ask for a new sign-in each time, also when the browser has a live session. Core never lets a session from before the request go on. A route that skips its form for a live session makes a redirect loop. `request`, `request_uri`, and `registration` go back to the client as `request_not_supported`, `request_uri_not_supported`, and `registration_not_supported`. `prompt=select_account` is accepted and ignored: a session holds one account, so core cannot offer a selection. With no session the sign-in page is that new sign-in. Core holds each request that goes to the sign-in page or to the consent page for 10 minutes and passes only its short id (`request_id=oq_…`), so a long client id or `state` fits the way back. The consent form posts that id and the decision; the POST decides on the held request, once, and only for the user the page showed it to (plan 9h).
- The consent page names the client by its own claimed name and the resource of the request. A consent is one decision per user and client for every resource of this instance: the scopes, not the resources, are the unit of consent. With more than one `oauth.resources` entry, the page states that the client may ask for the other resources with the same scopes, and it asks for no new consent then. A new scope asks again. `oauth.consentPage` replaces the page; its input has `resource` and `otherResources`, and `fields` holds `request_id` only. Upgrade note for an app with its own `oauth.consentPage` (plan 9h): render each entry of `input.fields` as a hidden input, and do not write the old field names (`client_id`, `code_challenge`, and the others) by hand. A form that still posts the old fields answers 400 `invalid_request`. A consent page that the old version showed before the deploy answers the same 400 once, and the person starts the sign-in again from the client.
- An access token is a JWT (`typ: "at+jwt"`) with `aud` equal to the resource, `scope`, `client_id`, and `sub`. It lives `accessTtlMinutes` (default `jwtMint.ttlMinutes`) and cannot be revoked; a sign-out does not end it. `auth.caller` answers `kind: "oauth"` only under the resource of the token: the `oauth.resources` entry on the request's origin whose path is the request path or a parent of it at a `/` boundary, the longest first. The cookie still wins. Each scope of the token must still be in `oauth.scopes`, so a deploy that drops a scope ends its tokens at once (plan 12e). `auth.session` never accepts an access token, so core's own routes answer 401 to it.
- A refresh token (`offline_access`) rotates at each use. A client gets one only when its `grant_types` hold `refresh_token`, as the default list does. Without it, the `scope` of the answer and of the access token leaves out `offline_access`. The new access token gets only the scopes of the grant that `oauth.scopes` still names. A grant with none of them but `offline_access` answers 400 `invalid_grant`, so the client starts a new authorization (plan 12e). A used refresh token presented again deletes the whole family. Core first writes an end mark of the family. A new refresh row reads the mark after its write, so a parallel refresh leaves no live row on any adapter. `POST /oauth/revoke` deletes a family. A `client_id` of another client answers 400 `unauthorized_client` and deletes nothing (RFC 7009 section 2.1).
- The refresh reuse window (plan 12e): `oauth.refreshReuseSeconds`, 0 (off, the default) to 60 (`REUSE_WINDOW_MAX_S`). With it on, a spent refresh token that its own client presents again within N seconds of its use answers a new child. The client auth and the DPoP key check run first. The child of the first use is then spent, so the family keeps one live branch. The odds: without the window, a copy of a refresh token presented after the client's own use deletes the family at once. Take a window of N seconds. A copy presented within N seconds of the client's use gets an access token and a refresh token. The holder of the copy can rotate that refresh token until the client's next refresh. That refresh presents the superseded child and deletes the family. So an attacker who holds a copy has N seconds to act. Its access then lasts until the client's next refresh, plus at most `accessTtlMinutes`. For a confidential client or a bound refresh token, the copy is useless without the secret or the key. The use: a client whose answer was lost on the network retries and keeps its grant. RFC 9700 section 4.14.2 gives no grace period for rotation, so the window is off by default. Each retry spends the live child, so two parallel retries leave one live branch at most. When the two spends meet, the loser deletes the family; when one retry follows the other, both answer.
- The default resource (plan 12e ruling 52): `oauth.defaultResource`, absent by default, one entry of `oauth.resources`. With it, an authorize request, a `client_credentials` grant, and a device start that name no `resource` take it. Without it, each answers `invalid_target`. A code exchange and a refresh with no `resource` keep the resource of their grant. The metadata documents do not change.
- Grants: a grant is the consent of one user for one client, with the client's refresh tokens. `api.oauth.grants({ userId })` lists each consent of the user, newest first: `clientId`, `clientName`, `scopes`, `createdAt`, and `refreshTokens` (the count of live refresh tokens). `api.oauth.revoke({ userId, clientId })` deletes the consent and every refresh token of the user and the client, and answers `{ ok: true }` also when nothing existed. A code from before the revoke gives no token. The session routes `GET /oauth/grants` (`{ grants }`) and `POST /oauth/grants/revoke` (`{ clientId }`) and the calls `client.oauth.grants()` and `client.oauth.revoke({ clientId })` do the same for the signed-in person; a `tk_` token and an access token answer 401, and the POST takes the Origin rule of every session POST. Build a "connected apps" page on them. An access token that the client holds lives on to its `exp`.
- A password reset of either kind (the link and the code) and a password change delete every refresh token, every pending authorization code, and every device code that the user decided, in the same transaction as the session delete. So a code from before the reset gives no token. The consents stay: the next authorize asks for no consent, but each client must send the person through the authorize step again.
- With `openid` the code exchange adds an ID token. It holds `aud` (the client id), `nonce`, `sid`, `at_hash`, and `email` or `name` and `picture` by scope. `/oauth/userinfo` answers the same claims. The `sid` is the session id, or for a pairwise client a keyed hash of its sector and the session id. A back-channel link stores the `sid`, so a secret rotation keeps it. The ID token uses the `jwtMint.alg` (EdDSA, ES256, or RS256). OIDC Discovery asks a provider to support RS256: set `jwtMint.alg: "RS256"` for a relying party that accepts RS256 only. Every JWT of the deployment then signs with RS256.
- Registration (plan 12e): an omitted `token_endpoint_auth_method` is `none`, a public client with PKCE S256 on every code. This departs from RFC 7591, whose default is `client_secret_basic`: an MCP client that omits the field works as a public client. A client of `client_secret_basic` or `client_secret_post` gets `client_secret` (`cs_` plus 32 random bytes) and `client_secret_expires_at: 0` once, in the answer. A registration refuses `client_credentials`, the device grant, `jwks` beside `jwks_uri`, a key with a private member, and an `id_token_signed_response_alg` other than `jwtMint.alg`. It refuses a `jwks_uri` while `oauth.fetch` is unset: core could never read that set. With `oauth.registration.initialAccessTokenHash` (the SHA-256 hex of a token), the route needs `Authorization: Bearer <token>`, and a miss answers 401 `invalid_token`.
- Clients in code (plan 12e): `api.oauth.clients` has `create`, `get`, `list`, `update`, `delete`, and `rotateSecret`. `list` answers newest first, 100 per page, with a cursor. `update` changes every field but the id, the method, and the secret. `delete` removes the client with its consents, refresh tokens, device grants, session links, and logouts, in one transaction. `rotateSecret` keeps the old secret for `keepOldHours`: 0 to 168, default 24. A client of `create` has kind `api`, and the 90-day idle sweep keeps it. Each call answers an OAuth result, and an unknown id answers `invalid_client`. Only `create` and `update` take `client_credentials`, `credentialsScopes` (app scopes only), and `introspect`. A registration refuses `client_credentials` and ignores the other two. The row holds the SHA-256 hex of a secret, and the secret leaves core once, in the answer of `create` or `rotateSecret`.
- The register limit counts each request before the check of the initial access token, so a guess of the token counts too.
- Back-channel logout (OIDC Back-Channel Logout 1.0, plan 12e). A client registers an https `backchannel_logout_uri`, with the host rule of a document URL. It needs `oauth.fetch`, and that fetch must refuse private addresses for these posts too: core cannot resolve a name. A code exchange or a device grant that answers an ID token links the session to such a client. Each end of a linked session writes one outbox row per client. These flows write the rows in their own transaction: a reset, a password change, and the first second-factor enable. A revoke of the other sessions, an email change, and an account delete do so too. A sign-out, an end-session, and the revoke of one session write the rows first, then delete the session. After the commit the flow posts a logout token as a form through `oauth.fetch`, with `redirect: "manual"`. Each post has 2 seconds, and all of them have 5 seconds. Core reads no byte of the answer. A 200 or 204 deletes the row. A throw, a timeout, 408, 429, or 5xx keeps the row (section 2.5). It waits 1 minute, 5 minutes, 30 minutes, then 2 hours, and the sweep sends it again. Any other answer, such as 400 or a redirect, deletes the row with one log line. A row whose next attempt would be the seventh goes with one log line at its next delivery, in a flow or in the sweep. The token has `typ` `logout+jwt`, `sid`, the client's `sub`, the `events` claim, no nonce, and 2 minutes of life. A refresh token stays (section 2.7). Each end of a session sends one logout to each linked client, an expiry too. A link whose session is gone becomes a logout at the user's next session end or at the sweep. So a race between a link and a sign-out delays a logout, and never loses it. Each sign-out with a linked client can take up to 2 seconds more while that client does not answer. A delivery stops at 5 seconds in all. The session end never waits for a post to succeed.
- The back-channel sweep (plan 12e): one sweep sends at most 50 rows, and at most 10 of one client. It takes the rows of each client in turns. So a client that fails or does not answer cannot hold back the logouts of other clients. The whole sweep fits its call budget with its posts (ruling 37 of plan 12f). At the default budget of 50 calls it sends about 6 rows. An operator act sends no logout in its call: the end of sessions, the ban, and the revoke of the platform role. The sweep sends their rows.
- Limits: `oauth-register:ip` 10 per hour; `oauth-authorize:ip` 60 per 15 minutes; `oauth-token:ip` 60 per 15 minutes, shared with the revoke; `oauth-token-origin:ip` 60 per 15 minutes, the origin check of a foreign origin at the token endpoint (plan 11d). `oauth-credentials:client` is 120 per minute, the `client_credentials` grant of one client (plan 12e). `oauth-introspect:ip` is 600 per minute before the client auth, and `oauth-introspect:client` is 600 per minute for one resource server (plan 12e). `oauth-device:ip` is 30 per 15 minutes, the device request before its client auth. A `GET /oauth/device` with no session counts on `oauth-authorize:ip` before core holds a row for the sign-in. The device page counts each post: `oauth-device-verify:session` 5 and `oauth-device-verify:ip` 20 per 15 minutes. A post that finds a live code also counts on `oauth-device-verify:code`, 10 per 15 minutes (plan 12e). `oauth-end-session:ip` is 60 per 15 minutes (plan 12e). A poll of a known device code by the client of the code counts on `oauth-device-poll:code`, not on `oauth-token:ip`. That key allows one poll per `interval` over the code life, plus 10: 130 for the defaults. A poll past it answers `slow_down`. A poll of an unknown code, or under another client id, counts on `oauth-token:ip`. A failed client auth of a poll counts there too.
- Client auth (plan 12e): the token and revoke routes take four methods. `client_secret_basic` is HTTP Basic of the form-encoded id and secret. `client_secret_post` is `client_secret` in the form. `private_key_jwt` is a JWT client assertion (RFC 7523). `none` is `client_id` alone, for a public client. One request has one method; two methods answer 400 `invalid_request`. A client with a secret may send it by either secret method (RFC 6749 section 2.3.1). A public client and a `private_key_jwt` client take their own method only. An empty `client_secret` counts as omitted. A failed auth answers `invalid_client` and spends nothing. After an `Authorization` header, `invalid_client` is a 401 with `WWW-Authenticate: Basic realm="<issuer>"` (RFC 7235 section 3.1). With no header it is a 400 with no challenge, so a browser shows no sign-in dialog (RFC 6749 section 5.2). A failed auth counts on `oauth-token:ip`; no per-client limit exists, because a stranger could use one to lock a real client out.
- `private_key_jwt` (plan 12e, RFC 7523 with draft-ietf-oauth-rfc7523bis-11): the form sends `client_assertion_type` `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and one compact JWS as `client_assertion`. `iss` and `sub` are the client id, and a form `client_id` must equal them. `aud` is the issuer alone, as a string or an array of one; the token endpoint URL is refused. `exp` is at most 300 seconds ahead. `iat` is at most 300 seconds back and not ahead. `nbf` is not ahead. Each allows 30 seconds of skew. `jti` holds 1 to 256 characters and works once. A `verification` row of purpose `client-assertion` keeps it to `exp`, rounded up, plus 31 seconds. The key is the `kid` of the header in the client's set; with no `kid`, at most 10 keys of the alg are tried. The algs are EdDSA, Ed25519 (RFC 9864), ES256, RS256, and PS256. An RSA key needs a modulus of 2048 bits or more, counted as bits, and an odd `e` of 65537 or more. Neither member may start with a zero byte. A `jwks_uri` set is read with the guards of a metadata document and kept one hour in the isolate. Its media type is `application/json` or `application/jwk-set+json` (RFC 7517 section 8.5). A `kid` that the kept set lacks reads the set again at most once per 30 seconds. A failed read keeps a kept set to its hour. With no kept set, a failed read waits 30 seconds before the next read. No `typ` is required. A failed assertion answers 400 `invalid_client`, spends nothing, and never reaches a log.
- The `client_credentials` grant (plan 12e, RFC 6749 section 4.4): a confidential client whose `grantTypes` hold the grant sends `grant_type=client_credentials`, `resource`, and `scope?`. A public client and a client without the grant answer 400 `unauthorized_client`. A metadata document never gets the grant. A scope of this grant must be in both `credentialsScopes` and `oauth.scopes`. With no `scope`, the token gets every scope in both. A scope outside either set, or an empty set, answers `invalid_scope`. No `resource`, and no `oauth.defaultResource`, answers `invalid_target`. The answer holds no refresh token and no ID token. The access token has `sub` and `client_id` equal to the client id (RFC 9068 section 2.2), and no user claim. `auth.caller` answers it as `kind: "oauth-client"`, with no user. `auth.session` and `/oauth/userinfo` refuse it. The token passes only while its client exists and holds the grant. Each scope of the token must still be in both sets. So a delete or an update of the client ends it at once. The grant moves the client's `lastSeenAt`, so the idle sweep keeps a registered client that uses it. `oauth-token:ip` counts first, so a service on one IP gets 60 tokens per 15 minutes. A service keeps its token until its `expires_in` ends.
- Introspection (plan 12e, RFC 7662): `POST /oauth/introspect` tells a resource server whether a token is live now. The caller is a confidential client with `introspect: true`, which only `api.oauth.clients` sets. An access token is live while `auth.caller` would take it and its grant stands. A token of a revoked grant stays inactive after a new consent. A refresh token is live only for its own client, while it is unspent and before its expiry. It shows the scopes that `oauth.scopes` still names, and with none of them but `offline_access` it is inactive. Every other token answers `{ active: false }` with no other member. `oauth.introspection` maps each client id to the resources whose access tokens it may see. Without it, a client sees the one resource of a single-entry `oauth.resources`, and none of several. The map does not apply to a refresh token. `oauth-introspect:client` counts after the client auth, so a stranger cannot lock a resource server out.
- Pairwise subjects (plan 12e, owner decision 2, OIDC Core 1.0 section 8): a client of `subject_type: "pairwise"` gets one subject per user and sector. The subject is `ps_` plus 16 random bytes, stored in `oauthSubject`, so a secret rotation never changes it. The ID token, the access token, userinfo, and introspection carry it, and `auth.caller` maps it back: `c.user` is the user and `c.subject` the token `sub`. The sector of a `cl_` client is the one host of its redirect URIs. A document's sector is the host of its client id. Two hosts, a private-use scheme, a loopback or local host, or an IP literal give no sector. Core refuses such a pairwise client with `invalid_client_metadata`. Core never fetches `sector_identifier_uri`: a registration or a create with it is refused, and a document drops it. An update that changes the sector of a pairwise client is refused, so each subject stays. A pairwise client cannot take the device grant. `@authtempo/verify` answers the token `sub` as `userId`, so a resource server on another host sees the pairwise subject.
- Release note (plan 12e): a switch over `Caller.kind` gains one case, `oauth-client`. An exhaustive switch fails to compile until it handles it. Code that reads `c.user` of any caller must first refuse that kind.
- PKCE (plan 12e, owner decision 3): a public client sends S256 on every code. A confidential client may omit PKCE only when it asks `openid` with a non-empty `nonce` (RFC 9700 section 2.1.1). A code with a challenge needs its verifier, and a code with no challenge refuses a verifier.
- The device grant (plan 12e, RFC 8628): `oauth.device: {}` turns it on. A client with the grant `urn:ietf:params:oauth:grant-type:device_code` asks at `POST /oauth/device_authorization` with the client auth of the token route. The answer holds an `od_` device code and a user code `XXXX-XXXX` of the letters `BCDFGHJKLMNPQRSTVWXZ`, 10 minutes long by default. The person opens `GET /oauth/device`, signed in, and types the code. `verification_uri_complete` fills the field, and the person still submits it. The page shows the client, the scopes, and the line "Approve only a device that is in front of you." The device polls `/oauth/token` with `device_code`. A poll before the decision answers `authorization_pending`. A poll within `interval` seconds answers `slow_down`, and the interval grows by 5. A deny answers `access_denied`, and an expired code `expired_token`. An approved code gives the tokens of the code exchange once, then `invalid_grant`. Only the client that asked may poll. A DPoP proof at the device request binds the code to its key. The table holds a SHA-256 of the device code and an HMAC of the user code under the app secret, never a code. A pairwise client cannot take the grant: it has no redirect that ties a sector to the client. A reset, a password change, and a grant revoke delete the device codes that the user decided, so an approved code gives no token after them.
- Not in this version: CORS on the revoke and register endpoints for an origin that is not trusted, and a token exchange.
- A browser client on another origin gets 403 `origin_not_trusted` from the Fetch Metadata rule (plan 12b) on its form post to `POST /oauth/revoke`, and on a `POST /oauth/userinfo` with no body. This holds also for a trusted origin. At `POST /oauth/token` a cross-site form post with no Origin gets the same 403. A post with an Origin skips the rule there (plan 11d, below).
- A browser client on another origin (plan 11d): `POST /oauth/token` accepts a web origin of the public client that its form names. A confidential client gets 403 `origin_not_trusted` and no preflight answer: a secret in a browser is not a secret (plan 12e). A web origin is the origin of an `https` redirect URI, or of an `http` redirect URI on `127.0.0.1` or `localhost`. The answer carries `access-control-allow-origin: <origin>` and `Vary: Origin`. It carries no `access-control-allow-credentials`. Every other foreign origin gets 403 `origin_not_trusted`, and nothing is spent. A trusted origin gets the credentialed CORS of the router. The token endpoint reads no cookie, so a post with an Origin skips the Fetch Metadata rule there. A post with no Origin keeps the rule. Core answers a preflight from a web origin only for `?client_id=cl_…` of a registered client. That preflight allows the headers `content-type` and `x-captcha-response`. A client metadata document URL gets no preflight answer. A browser client of that kind sends a CORS-safelisted request: a form body and `accept`. The check counts on `oauth-token-origin:ip:<ip>`, 60 per 15 minutes. The revoke and register endpoints keep the 403. Two risks stay open. A person who registers a client with an origin of their own gets CORS for that client only. A script on a client's own origin can read that client's tokens.

## API tokens

A script or a CLI signs in with an API token, not with a password. A
person with a session creates the token. The clear token appears once, in
the create answer, and core stores its SHA-256 only.

```ts
// A route that a script may call: a session or a token.
const c = await auth.caller(request);
// A client_credentials token and an organization token act for no user, so this route has no one to name.
if (!c || c.kind === "oauth-client" || c.kind === "organizationToken")
  return Response.json({ error: "unauthorized" }, { status: 401 });
// c.kind === "session": c.user, c.session, c.refreshed
// c.kind === "token":   c.user, c.apiToken, c.activeOrganizationId
// c.kind === "organizationToken": c.organization, c.apiToken, and no user (plan 12k)
// c.kind === "oauth":   c.user, c.clientId, c.scopes, c.resource, c.tokenId, c.expiresAt (plan 9g), c.dpopJkt, c.subject (plan 12e)
//   c.subject is the token sub: the user id, or the pairwise subject of a pairwise client
// c.kind === "oauth-client": c.clientId, c.scopes, c.resource, c.tokenId, c.expiresAt, c.dpopJkt (plan 12e)
const res = Response.json({ id: c.user.id });
// After a sliding refresh, renew the cookie or the browser drops it early.
const renewed = c.kind === "session" ? auth.sessionCookie(request, c) : null;
if (renewed) res.headers.set("set-cookie", renewed);
return res;
```

- DPoP (RFC 9449, plan 12e): a bound access token reaches `auth.caller` as `Authorization: DPoP <token>`. The `DPoP` header holds a proof of its key for the request's URL and method. `c.dpopJkt` is then the thumbprint of the key; it is null for a Bearer token. A bound token as a bearer answers null. Core spends the proof's `jti` in the `verification` table, so a replay on any instance answers null. A second `auth.caller` of the same `Request` object answers the same caller.

- `auth.session(request, { refresh: false })` is a read with no write: no
  sliding refresh and no delete of an ended row. A server render reads this
  way, so the browser's own `GET /auth/session` still gets the renewed cookie.
  With `session.deferRefresh` on, every GET request reads this way (see Sessions).
- `auth.session(request)` resolves sessions only. Every route that calls
  it, core's and the app's, answers 401 to a `tk_` bearer. Core's own
  routes call it, except `GET /tokens/current`. So a token cannot create a
  token, change a password, or touch passkeys or organizations.
- A token is `tk_` plus 43 base64url characters. `hint` holds the 8
  characters after `tk_`, so a list tells the tokens apart.
- `name` is 1 to 80 characters with no control character. `expiresInDays`
  is an integer from 1 to 3650, default 90. `null` means no expiry.
- `organizationId` may be omitted or `null`, for no organization. Else it
  names one organization the user is a member of. Core
  checks the membership at create and at each use. When the membership is
  gone, `caller` answers null, and the token stays in the list.
- A user holds at most 50 tokens (`token_limit`). Create is limited to 20
  per user per hour. An expired token goes at its next use and at the
  sweep, and it does not count against the cap.
- `lastUsedAt` is written at most once per hour.
- A `tk_` value counts only in the `Authorization` header, never in a
  cookie. A CLI passes `token: () => "tk_…"` to `createClient`.
- A password reset, a password change, and a sign-out delete no token. Revoke
  a token from the list.
- In process: `auth.api.tokens.create`, `list`, `revoke`, and `current`.

## The sign-up rule

`signUp` sets who may become a user.

| Key | Default | Rule |
| --- | --- | --- |
| `signUp` | `"open"` | `"open"`, `"invited"` (needs `organizations`), or `false`. A refused new user gets 403 `sign_up_closed`. |

The rule runs at each create of a user: the password sign-up, the password
reset, the magic link, the email code, and social. The importer and the
operator's own storage writes are not under the rule. An existing user signs
in as before. A magic link or code request still answers `{ sent: true }`. Its
verify answers `sign_up_closed`, and only the owner of the mailbox sees that.
A refused reset keeps its link usable.

With `false`, the password sign-up answers `sign_up_closed` before it reads a
user, so the answer is the same for every address. With `"invited"` and
`uniformSignUp: false`, the answer shows whether the address has a pending
invitation.

With `"invited"`, a new user needs a proved address. A social sign-in that
would create a user needs a verified address from the provider: else it
answers `sign_up_closed`. The password sign-up of an invited address opens
no session until the person follows the verify link. It answers `{ sent: true }`
by default, and `{ user, verifyRequired: true }` with
`password.uniformSignUp: false`.

## Organizations

Set `organizations: {}` to turn the feature on. Without it, the organization
routes and the `api` functions answer 404 `not_found`.

With `signUp: "invited"`, only an address with a pending invitation becomes a
user. The invitee signs in by any method, and the accept follows.

**Ranks.** A role name maps to a rank. The default table is `viewer` 1,
`member` 2, `admin` 3, `owner` 4. A member may hold more than one role,
joined by a comma, such as `member,billing`. The rank of that member is the
highest rank among the parts. A part that is not in the table ranks 0, so
an unknown role never grants a right. Pass `ranks` to change the table. It
must name `owner`.

**Slugs.** A slug is lower case, up to 64 characters, with digits and
hyphens. Core folds the slug to NFKC first, so a look-alike letter cannot
hide a reserved word. The default reserved slugs are `admin`, `api`,
`auth`, `internal`, `operator`, `ops`, `platform`, `system`, and `www`.
Pass `reservedSlugs` to replace the list. A reserved slug answers
`slug_reserved`. A slug in use answers `slug_taken`.

`POST /organizations/check-slug` (`api.checkSlug`) answers the folded slug
and its status before a create. The platform slug answers `reserved`. Each
user gets 60 slug reads per minute (`slug-check:user:<userId>`). The check,
the create, and a rename to a new slug spend this one key before the read.
So after 60 checks in one minute, a create answers `rate_limited` until the
minute ends. `available` is a hint, not a hold: the create still answers
`slug_taken` when another user takes the slug first, because the unique key
decides.

**Organization tokens.** A `to_` token belongs to the organization, not to
a person (plan 12k). It acts with its own fixed `permissions`, never with
the role of its creator, and it stays when the creator leaves or deletes
the account. `auth.caller` answers it as `kind: "organizationToken"` with
`organization` and no `user`. `auth.hasPermission` reads its set in its own
organization only. A token never manages. Each route above but
`GET /organizations/tokens/current` takes a session, so a token bearer
answers 401. Each organization holds at most 50 live tokens. Pass
`revokeTokens: true` to the member removal to delete the tokens that the
person made there, in the same write. That needs `apiToken:revoke` too.

**Platform role.** Set `platformOrganization` and `platformRole` to keep one
role for staff. Core accepts that role in the platform organization only.
Any other organization refuses it with `invalid_body`.

The platform slug is reserved, so `createOrganization` refuses it. Seed the
platform organization yourself, through the storage adapter or a
migration. Write one `organization` row with that slug and one `member`
row for the first staff user. The member role must include `owner`, and
also the platform role if it is not `owner`, for example `owner,operator`.
Take the fields of each row from `schema` (`organization`: `id`, `slug`,
`name`, `metadata`, `createdAt`, `updatedAt`; `member`: `id`,
`organizationId`, `userId`, `role`, `createdAt`, `updatedAt`). After the
seed, the engine refuses a slug change and a delete of the platform
organization with `slug_reserved`, because no route could create it again.
A change of its name or metadata is allowed. Accept also checks the
platform role again: if the organization of a pending invitation no longer
has the platform slug, the link is dead and the answer is `invalid_token`.

**Write rules.**

- A creator becomes `owner` of the new organization. The creator needs a verified email.
- An `admin` may update the organization, add members, change roles, remove other members, and manage invitations.
- Only an `owner` may change the slug or delete the organization.
- A caller may grant or set only a role with a rank at or below the caller's own rank. This is the no-escalation rule.
- A caller may not change or remove a member of higher rank.
- A member may always remove themselves, unless that member is the last owner.
- The last owner cannot leave, be demoted, or be removed. The answer is `last_owner`.
- Two owner writes at the same time cannot both succeed. The second answers `conflict`. This means a concurrent owner write. Retry.
- A role change or a removal writes only if the member still holds the role that the caller read. If another request changed that role first, the answer is `conflict`. Read the member again and retry.

**Invitations.** An invitation is valid for seven days. Set
`invitationTtlDays` to change this. An organization holds one pending
invitation for each address. A new invitation replaces the old one, and the
old link stops working. The token is in the mail only. No route answer
carries it. To accept, the caller must hold a verified email that equals the
invited address, or the answer is `email_mismatch`. Accept checks the
inviter again. If the inviter left or lost rank since the invite, the link
is dead and the answer is `invalid_token`. The same is true when the
invited role now ranks 0, because the app removed it from `ranks`. Decline
needs no session, because the link is the credential. Set
`invitationLinkBuilder` to change the link in the mail. The default is
`<appURL>/?invitation=<token>`.

Accept is limited to 20 per IP per 15 minutes. Invite is limited to 20 per
inviting user per 15 minutes, and to 5 per invited address per hour. A
refusal answers 429 `rate_limited` and sends no mail.

If the invited person is already a member, accept keeps the current role
when it ranks at or above the invited role. A higher invitation replaces
the role. It does not add to it: a `member,billing` member who accepts an
`admin` invitation becomes `admin`, and `billing` is gone.

The invitations list shows each pending invitation that has not expired. It
does not check the inviter. An invitation whose inviter left or lost rank
stays in the list until someone tries to accept it. That accept then
deletes it, and no record of it stays.

**Active organization.** A session may name one active organization.
`POST /organizations/active` sets it, and `null` clears it. The caller must
be a member. The value comes back in `session.activeOrganizationId`.
Core stores the value and does not read it for any other check.

The value is a choice, not a right. Core clears it when the member leaves,
is removed, or the organization is deleted. A demotion does not clear it.
Check the member's rank on each request.

**Error codes.** Organization routes add these codes to the existing set.

| Code | Status | Meaning |
| --- | --- | --- |
| `forbidden_rank` | 403 | The caller is not a member, or the rank is too low |
| `slug_reserved` | 400 | The slug is on the reserved list, or the organization is the platform organization |
| `slug_taken` | 409 | Another organization uses the slug |
| `last_owner` | 409 | The write would leave no owner |
| `already_member` | 409 | The user is already a member |
| `email_mismatch` | 403 | The invitation is for another address |
| `conflict` | 409 | A concurrent write changed the organization or the member; retry |
| `organization_limit` | 409 | The user holds `organizations.limits.perUser` member rows |
| `member_limit` | 409 | The organization holds `organizations.limits.membersPerOrganization` members |
| `invitation_limit` | 409 | The organization holds `organizations.limits.pendingInvitationsPerOrganization` pending invitations |
| `hook_refused` | 403 | A before hook threw `hookRefusal(message)`; the body carries `message` |
| `hook_failed` | 500 | A before hook threw another error, or a session patch was wrong |

## Account

The routes of a settings page (plan 12a, spec 8.15). Each needs a session: a `tk_` bearer or a JWT bearer answers 401. A route marked "fresh" needs a session whose sign-in or re-authentication is younger than `session.freshMinutes` (default 1440, 24 hours). Else it answers 403 `session_not_fresh`: the client re-authenticates at `POST /reauth` and sends the change again. The token and the expiry do not change.

The fresh rule also holds on routes of other sections. The passkey and token routes are `POST /passkey/register/options`, `POST /passkeys/delete`, and `POST /tokens`. The factor routes are `POST /totp/enable`, `POST /totp/disable`, `POST /totp/backup-codes`, `POST /second-factor/passkey/enable`, `POST /second-factor/email/enable`, and `POST /second-factor/disable`. `POST /password/change` needs a fresh session for a first password, and while the second factor is on. With a password and no second factor, the current password is the proof. A sign-in is fresh for `session.freshMinutes`, so a "register a passkey now" step after a sign-in works. The rule answers before any limit counts a try, so a stale session fills no limit key. `POST /totp/setup` has no fresh rule: it turns nothing on, and the enable after it applies the rule.

The in-process calls `api.passkeyRegistrationOptions`, `api.deletePasskey`, `api.tokens.create`, `api.totp.disableWithCode`, and `api.totp.regenerateBackupCodesWithCode` take a user, not a session. So they apply no fresh rule. The app's server code calls `api.session.requireFresh(resolved)` first. `api.totp.enable` and `api.password.change` take a session and apply the rule themselves.

| Method | Path | Body or query | Answer |
| --- | --- | --- | --- |
| POST | `/reauth` | session, `{ password, code? }`. With the email method or the passkey method only, `code` is a backup code. See the rule below the table | `{ freshUntil }`; 400 `invalid_body` (no proof, an unknown field, or no `code` while the second factor is on), `invalid_code`; 401, `invalid_credentials`; 404 `not_found` (no `password` config); 429 `rate_limited` |
| POST | `/reauth` | session, `{ emailCode, code? }` or `{ passkey }` | the other two proofs of `/reauth`; a passkey is two factors and takes no `code`. Two first proofs, or `code` beside a passkey, answer 400 `invalid_body`; 400 `passkey_failed` (a passkey of another user), `invalid_token` (a spent challenge), `token_expired` (an old passkey challenge), `too_many_attempts` (an email code that its cap spent); 404 `not_found` (no `emailOtp`, or no `passkey` config), and the limit counts no try |
| POST | `/reauth/email` | session | `{ sent: true }`: a code to the user's address; 404 with `emailOtp: false`; 429 `rate_limited` |
| POST | `/reauth/passkey/options` | session | the request options for `navigator.credentials.get`, with the user's passkeys; 404 without `passkey`; 429 `rate_limited` |
| GET | `/sessions` | session | `{ sessions: [{ id, createdAt, lastSeenAt, expiresAt, freshAt, ip, userAgent, activeOrganizationId, current }] }`, the live sessions newest first, at most 100, never a token or its hash; 401. `lastSeenAt` moves only at the sliding refresh. `expiresAt` is the earlier of the row's expiry and the absolute cap |
| POST | `/sessions/revoke` | session (fresh), `{ id }` | `{ ok: true, current }`; `current` is true for the caller's own id, which also clears the cookie; 400 `invalid_body`; 401; 403 `session_not_fresh`; 404 `not_found` (another user's, an unknown, or an ended id); 429 `rate_limited`. A session JWT of that session lives to its `exp` |
| POST | `/sessions/revoke-others` | session (fresh) | `{ ended }`, the count of live sessions it ended: every other session, the second-factor challenges, and the handoff codes go. An ended row goes too, with no count and no `revoked` event. The trusted devices, the API tokens, and the OAuth grants stay; 401; 403 `session_not_fresh`; 429 `rate_limited` |
| POST | `/user/update` | session, `{ name?, image? }` | `{ user }`. `name`: a name by the name rule below, or null. `image`: an image URL by the image rule below, or null. 400 `invalid_body` (no field, a bad value, or any other field, the address too); 401 (also when the user row goes during the update); 403 `email_unverified`, `hook_refused`; 409 `conflict`; 429 `rate_limited`; 500 `hook_failed`. No fresh rule |
| POST | `/user/change-email` | session (fresh), `{ newEmail, method?, next? }` | `{ sent: true }`. `method` is `link` (default) or `code` (needs `emailOtp`). A proof goes to the new address. When any user holds it, a note goes there in place of the proof, with the same answer. 400 `invalid_body` (a malformed address, the same address, or any other field); 401; 403 `email_unverified`, `session_not_fresh`; 404 `not_found` (`code` with `emailOtp: false`); 429 `rate_limited` |
| GET | `/user/change-email/confirm` | `?token=` | 200 HTML confirm page (`account.confirmPage` replaces it); 302 to `/?auth_error=invalid_token` on a malformed token. No storage read, no limit, no cookie |
| POST | `/user/change-email/confirm` | form or JSON `token`, no session | form body: 302 to `next`, or to `/?auth_error=<code>` on a failure; JSON body: `{ user }`. The address moves and is verified. The `email` identity follows. The old address's live links and codes go. Every other session, challenge, handoff code, and OAuth grant ends. A notice goes to the old address. 400 `invalid_token`, `token_expired`; 403 `hook_refused`; 409 `email_taken` (a user took the address since the request), `conflict`; 429 `rate_limited`; 500 `hook_failed` |
| POST | `/user/change-email/verify` | session, `{ code }` | `{ user }`, the same move by a code. The caller's session stays. 400 `invalid_body`, `invalid_code`, `too_many_attempts`; 401; 403 `hook_refused`; 409 `email_taken`, `conflict`; 404 with `emailOtp: false`; 429 `rate_limited`; 500 `hook_failed` |
| GET | `/identities` | session | `{ identities: [{ id, provider, email?, linkedAt, canUnlink }], password, passkeys }`, oldest link first. The provider's subject is not in the answer. The `email` identity carries the address and `canUnlink: false`. No fresh rule and no limit; 401 |
| POST | `/identities/unlink` | session (fresh), `{ id }` | `{ ok: true }`. No session ends. 400 `invalid_body` (the `email` identity, or any other field); 401; 403 `session_not_fresh`, `hook_refused`; 404 `not_found` (an unknown id, or an id of another user); 409 `last_credential`, `conflict`; 429 `rate_limited`; 500 `hook_failed` |
| POST | `/social/:provider/link` | session (fresh), JSON or form `{ next? }` | JSON: `{ url }` and the binding cookie; the client navigates to `url`. Form: 303 to the provider, and a failure redirects to `/?auth_error=<code>`. The callback links the provider identity to the session's user, and redirects to `next` with no new session cookie. 400 `invalid_body`; 401; 403 `email_unverified`, `session_not_fresh`; 404 `not_found` (no such provider); 429 `rate_limited`. "The link of a provider" below gives the codes of the callback |
| POST | `/user/delete` | session (fresh), `{}` | `{ ok: true }`, and the session cookie is cleared. The user goes with every row that names it. "The account delete" below gives the rows and the organization rule. With `account.deleteConfirm` on: `{ sent: true }`, a link goes to the user's address, and nothing is deleted. 400 `invalid_body` (any field); 401 (also when the session of the proof ended); 403 `session_not_fresh`, `hook_refused`; 404 with `account.delete: false`; 409 `sole_owner` (the last owner of an organization with other members), `conflict`; 429 `rate_limited`; 500 `hook_failed` |
| GET | `/user/delete/confirm` | `?token=` | 200 HTML confirm page of the mailed delete link; 302 to `/?auth_error=invalid_token` on a malformed token. No storage read, no limit, no cookie. 404 with `account.delete: false` |
| POST | `/user/delete/confirm` | session, form or JSON `token` | form body: 302 to the app, or to `/?auth_error=<code>` on a failure; JSON body: `{ ok: true }`. Both clear the session cookie. The delete of `POST /user/delete`, with no fresh rule. 400 `invalid_token` (a spent, expired, unknown, or foreign link, or no token); 401; 403 `hook_refused`; 404 with `account.delete: false`; 409 `sole_owner`, `conflict`; 429 `rate_limited`; 500 `hook_failed` |

The second factor at `/reauth` (spec 8.15). A passkey proves two factors, so it takes no `code`, whatever methods the user has on. After a password or an email code, `code` is the second factor. Item 2 says: "With the second factor on, the password and the email code need `code`, an authenticator code or a backup code." Item 12 lists "the email method of plan 12c as a re-authentication code" as a later input. So a user whose only method is the email method sends a backup code, or proves by a passkey. A user whose password row holds `LEGACY_VERIFY_HASH` proves by an email code or a passkey. The password proof refuses the marker, as the TOTP setup does.

| Limit | Window | Count | Route |
| --- | --- | --- | --- |
| `reauth:user:<userId>` | 15 minutes | 10 | `POST /reauth`, right or wrong. Its own key: a guessed password costs the owner's sign-in nothing. A wrong email code also counts on `otp-verify:ip` and `otp-verify:email`, the keys of the email code sign-in |
| `reauth-mail:user:<userId>` | 15 minutes | 3 | `POST /reauth/email`, then `otp:email` and `otp:email-day` of the address, shared with every mailed code |
| `passkey-options:ip:<ip>` | 15 minutes | 30 | `POST /reauth/passkey/options`, shared with the passkey sign-in options |
| `session-revoke:user:<userId>` | 15 minutes | 30 | `POST /sessions/revoke` and `POST /sessions/revoke-others` together |
| `user-update:user:<userId>` | 15 minutes | 30 | `POST /user/update`, also when a hook refuses it. A refused body and an unverified user count no try |
| `passkey-rename:user:<userId>` | 15 minutes | 30 | `POST /passkeys/rename`, also for an unknown id or another user's id. A refused name counts no try |
| `email-change:user:<userId>` | 1 hour | 5 | `POST /user/change-email`. A refused body, a stale session, and an unverified user count no try |
| `email-change:email:<new address>` | 15 minutes | 3 | `POST /user/change-email`, after the per-user key |
| `email-change-confirm:ip:<ip>` | 15 minutes | 20 | `POST /user/change-email/confirm`. A malformed token counts no try |
| `otp-verify:ip:<ip>`, `otp-verify:email:<new address>` | 15 minutes | 30, 10 | `POST /user/change-email/verify`, shared with every code verify. With no request, the IP key only |
| `unlink:user:<userId>` | 15 minutes | 10 | `POST /identities/unlink`, also for an unknown id. A stale session counts no try |
| `social-link:user:<userId>` | 15 minutes | 10 | `POST /social/:provider/link`, after `social-start:ip`. An unverified user, a stale session, and an unknown provider count no try |
| `user-delete:user:<userId>` | 1 hour | 5 | `POST /user/delete`, also when it answers `sole_owner`. A stale session and `account.delete: false` count no try |
| `user-delete-confirm:ip:<ip>` | 15 minutes | 20 | `POST /user/delete/confirm`. A malformed token counts no try |

The profile update (`POST /user/update`, `api.user.update`) writes only the fields it gets. Null clears a field. It needs a verified address: a claim keeps the user row and its name, so a claimant must not set what the owner inherits. It has no fresh rule, because the name and the image do not affect a sign-in.

The name rule (`validUserName`) holds for the profile update, the password sign-up, the `user.beforeCreate` patch, the social fill, and the importer. A name is a string of 1 to 200 code units. It holds no control character (C0, DEL, C1), no line or paragraph separator, and no lone surrogate. It holds no format character, such as a bidi control or a zero-width space. The zero-width non-joiner (U+200C) and joiner (U+200D) pass, because Persian names and joined emoji carry them. A name that breaks the rule answers 400 at the sign-up and the profile update. The social fill then fills no name, and the importer drops the name and lists it.

The image rule (`validImageUrl`) holds for the profile update, the `user.beforeCreate` patch, the social fill, and the importer. An image is an `https://` URL with a host, of at most 2048 characters. Its authority holds no `@` and no `%`, so it has no credentials and no escaped host. It holds no whitespace, no control character (C0, DEL, C1), no format character (such as a bidi control or a zero-width character), and no backslash. It holds none of `"`, `<`, `>`, a backtick, `{`, `}`, `|`, and `^`. A `data:` URL is refused. A private or loopback host passes.

`user.beforeUpdate` gets the stored row, the patch, and `via: "profile"`. It runs before the write, so a refusal or a throw leaves the row as it was. The write is a compare-and-set on the row that the hook saw. A parallel write that lands first makes the update read the row again and run `user.beforeUpdate` again. After 5 lost rounds the answer is 409 `conflict`, and core logs `authtempo: profile update gave up <user id>`. `user.afterUpdate` gets the stored row after the write and, as `previous`, the row that the write replaced.

The change of address (`POST /user/change-email`, `api.user.changeEmail`) needs a fresh session of a verified user. The proof goes to the new address: a link (the magic link's life) or a code (the email code rules). One request per user is live: a new request spends the earlier link or code. An address that any user holds gets a note with no proof. The caller gets the same answer, so the answer does not tell that the address is taken. Both paths count the same keys and write the same rows in the same order. The row of a taken address is a decoy: its proof is never mailed, and the confirm and the verify answer it as an unknown link or a wrong code. Wrong guesses count on it as on a real row, so the verify does not tell either.

The link opens a confirm page that does nothing on load, so a mail scanner spends nothing. Its button posts the token, with no session: the person may open the mail on another device. The code needs a session of the same user, because a 6-digit code is not a bearer proof. The move is one transaction: the user row, the `email` identity, the old address's proofs, and the other sessions. A spent, old, or replaced proof undoes it. Of two confirms of one link, one moves and one answers `invalid_token`. Of two users who confirm one address, one moves and one answers 409 `email_taken`.

`user.beforeUpdate` gets the stored row, `patch: { email }`, and `via: "email_change"`. It runs before the write, so a refusal or a throw leaves both rows as they were. The move is a compare-and-set on the row that the hook saw, the rule of the profile update. A parallel profile update makes the move read the row again and run the hook again. After 5 lost rounds the answer is 409 `conflict`, and core logs `authtempo: email change gave up <user id>`. Each ended session fires `session.afterEnd` with `email_change`.

A change of address keeps the social identities: a later social sign-in finds the user by its subject. Pending invitations to the old address stay with that address. An authenticator app keeps the old address as its label.

**The last-credential guard.** A user keeps at least one way in. The ways in are an active password, a passkey, an identity of a configured provider, and a verified address. The magic link signs in with a verified address in every deployment. The unlink and the passkey delete (`POST /passkeys/delete`) run the guard. They answer 409 `last_credential` when the removal would leave no way in, and remove nothing. The unlink checks the count before `identity.beforeUnlink`, so a refused unlink runs no hook.

The guard holds the user row by a compare-and-set, then removes, then counts again, in one transaction. So two removals at the same moment cannot both take a way in. On Postgres the second waits, reads the row again, and counts again. A parallel write to the user row makes the guard read it again. After 5 lost rounds the answer is 409 `conflict`, and core logs `authtempo: credential removal gave up <user id>`; send it again. `identity.beforeUnlink` and `identity.afterUnlink` get the user row as the guard holds it and `{ provider, subject }`.

**The link of a provider.** A signed-in user adds a provider at `POST /social/:provider/link` (`api.startLink`). The start needs a fresh session of a verified user. A claimant has nothing to link: a claim deletes the identities. The flow is the social sign-in: the state, PKCE, the nonce, and the binding cookie. The state row has its own purpose, `oauth-link-state`, so a link state never opens a session, and a sign-in state never links. The callback answers these codes on `/?auth_error=<code>`:

- `invalid_token`: the session of the start ended, or the callback carries no session cookie, or the cookie of another session. A browser signed in as another account cannot take the link. Apple's callback is a cross-site form post, and a browser sends no `Lax` cookie with it. So with `cookie.sameSite: "Lax"`, Apple's callback needs the binding cookie only. A state is spent once.
- `email_required`, `email_mismatch`: the provider address must be present, verified by the provider, and equal to the account's address (owner decision 4).
- `identity_taken` (409): another user holds the provider account. Core never moves an identity. A social sign-in with that provider account opens the account that holds it, so the answer tells the caller nothing new.
- `hook_refused`, `hook_failed`, and the codes of the sign-in callback: `oauth_denied`, `oauth_failed`, `token_expired`.

The link writes no user row, and fills no name and no image. No session opens and no session ends. A second link of a provider account that the user holds answers the link and writes nothing. Of two callbacks of one state, one links, and the other answers `invalid_token`. Of two users who link one provider account at once, one links, and the other answers `identity_taken`. A sign-out during the link undoes it. `identity.beforeLink` runs inside the transaction, before the identity write, with `via: "link"`. `identity.afterLink` runs after the commit.

**The account delete.** `POST /user/delete` (`api.user.delete`) needs a fresh session. By default no mail confirms it: the fresh session is the proof. `account.delete: false` removes the route, and the engine answers 404. Better Auth's default is off. Core's default is on, because the right to delete the account is the person's.

**The mailed confirm.** `account.deleteConfirm` (default `false`) adds a proof of the mailbox, for an app whose sessions live on shared devices. With it on, `POST /user/delete` keeps every check above in its order: the fresh rule, the limit, and the organization rule. Then it ends the user's earlier delete links and mails a new one through `account.mail` with the kind `delete_confirm`. It answers `{ sent: true }` and deletes nothing. The link lives `account.deleteConfirm.ttlMinutes` (5 to 1440, default 60). Core stores only the SHA-256 of the `ad_` token.

The link opens a page that reads nothing and spends nothing, because a mail scanner fetches links. Its button posts the token with the session cookie to `POST /user/delete/confirm` (`api.user.confirmDelete`). The confirm needs a session of the user who asked, but not a fresh one. In one transaction it holds the user row, spends the link by one conditional update, and runs the delete above. The organization rule runs again, and the delete hooks and the notice run here. A spent, expired, or unknown link, and the link of another user, answer 400 `invalid_token`. A refusal undoes the spend, so the link stays live. A change of address ends a pending link, because the link went to the old mailbox.

The organization rule (owner decision 3). An organization where the user is the only member goes with the account, with its invitations. Any other membership of the user goes, and the organization stays. When the user is the last owner of an organization with other members, the delete answers 409 `sole_owner` and deletes nothing. Make another member an owner first, then delete again. The platform organization never goes. So its last owner answers `sole_owner`, also as its only member.

One transaction removes the user row, every session, the identities, the password, and the passkeys. The second factor, the trusted devices, the API tokens, the OAuth consents, and the refresh tokens go too. The member rows and the invitations that the user sent go too. After the commit, the mailed proofs of the user id and of the address go. Invitations to the address stay, because they belong to the organizations.

The delete holds the user row by a compare-and-set, the rule of the profile update. A parallel change of address commits first, and the delete then reads the moved row. A parallel write makes the delete read the row again. After 5 lost rounds the answer is 409 `conflict`, and core logs `authtempo: account delete gave up <user id>`. A sign-in of a verified user holds the same row. So the session of such a sign-in ends with the account, or never commits. A sign-in that loses the race answers 409 `conflict`. For each organization that keeps another owner, the delete takes the owner lock of that organization. A parallel removal of the other owner then answers `conflict`. The delete takes these locks in the order of the organization ids, so two deletes never wait on each other.

Five more writers hold the user row. They are the organization create, the member add, the accept of an invitation, the password change, and a reset that answers a second-factor challenge. Each also reads the user row after its insert. So a member row or an `email` identity of a deleted user never commits. A writer that loses the race answers 409 `conflict`. An organization that goes loses its invitations first. An accept that comes later finds no invitation. An accept that commits first makes the delete answer `conflict`, and the organization stays.

`organization.beforeDelete` runs for each organization that goes, then `user.beforeDelete` with `organizations`, the ids of those organizations. Both run inside the transaction, after core's checks and the lock, before the first delete. After the commit, `session.afterEnd` fires once per session with `account_deleted`. Then `organization.afterDelete` fires for each organization, and `user.afterDelete` with the row as the delete held it. The member rows and the identities fire no member or identity hook.

A notice mail goes to the user's address after each change of a way in (ASVS 5.0.0 6.3.7). These changes send one:

- a password change, or a first password
- a reset by link or by code, also when the reset answers a second-factor challenge
- a passkey added or removed
- a provider linked (`POST /social/:provider/link`) or unlinked (`POST /identities/unlink`): the notice names the provider
- a second-factor method turned on or off: TOTP, the passkey method, the email method, and `api.totp.disable`
- a change of address, by link or by code: the notice goes to the old address, which the request read, and names the new one
- the account delete: the notice goes to the address of the row that the delete held, after the commit. The address is read before the delete, because the row is gone after it

The notice holds the event, the time, the IP address when core has it, and what to do. It holds no link and no code. A password change, a reset, and a change of address pass the client IP and the user agent to the builder. A link, an unlink, and the account delete pass them too. The passkey and second-factor changes pass neither. The default text prints the IP only when it is a bare IPv4 or IPv6 literal (`isIpLiteral`). On a host with no `clientIp` of its own, the caller writes the header. Core sends the notice after the commit, never inside a transaction. A refused change, a change that rolls back, and an enable of a method that is on already send none. A notice that fails writes `authtempo: notice mail failed <event> <error name>`, and the change stays. The line holds no address and no error message.

`account.notices: false` turns every notice off. The proof mails of `account.mail` stay on. `account.notices.mail` replaces the text, and core sends it to the input's address, whatever `to` the builder answers.

## Operator tools

Plan 12f gives the operator of a deployment the support tools of day one. `operator.users: true` turns them on; they are off by default. Each write runs its change and one audit row in one transaction. The guide `/docs/guides/operator-tools/` (plan 12f Task 14) gives the setup.

- The actors: a named operator secret, a platform operator, and the app in process (`{ kind: "app", name }`). Each entry of `operator.secrets` names its scopes from `keys`, `secrets`, `users`, `sessions`, and `audit`. A platform operator holds `organizations.platformRole` in `organizations.platformOrganization`. The 11c `operator.secretHash` is one secret named `default` with `keys` and `secrets` only.
- The guard of a platform operator: no impersonation session, the platform role, a verified address, a second factor, and a fresh session. Each failure answers 403 `operator_required`.
- The routes under `<basePath>/operator/` are in the table above. `POST users/create-admin` takes a secret only.
- A request with an operator secret and a session answers 401. A route of a tool that is off answers 404. With `operator.users` and no secret entry, the four secret routes of plans 11c and 11c2 answer 404 too.
- The limits: every secret call counts on `operator-users:ip:<ip>`, 600 per hour, before the secret compare. A secret that matches also counts on `operator-users:secret:<name>`, 600 per hour from any IP. A platform operator counts on `operator:user:<userId>`, 600 per hour.
- `auth.api.operator` holds the same tools in process, with the actor as an input. Its entries are `users`, `platformRole`, `secondFactor`, `createAdmin`, `sessions`, `audit`, `impersonate`, and `stopImpersonating`.
- The audit table `ta_operator_audit` is append-only: core never updates or deletes a row. `hooks.operator.afterAction` sends each row to a separate system.
- An audit id is a monotonic ULID (`newMonotonicId`). The audit list reads the rows in id order. So the rows of one isolate list in the order of their writes, also inside one millisecond. The rows of two isolates in one millisecond have no defined order between them.

## Hooks

A hook is your code at a named point of a core flow (plan 9d). Pass plain
objects of functions in `hooks`:

```ts
import { createAuth, hookRefusal } from "@authtempo/core";

const auth = createAuth({
  // ...
  organizations: { limits: { perUser: 5, membersPerOrganization: 50 } },
  hooks: {
    organization: {
      async beforeCreate({ organization, user }) {
        if (organization.slug.startsWith("acme-")) throw hookRefusal("Choose another name.");
        // Write your own row first, with the id core minted. On Postgres, on a
        // connection that core's adapter does not hold (see the rule below).
        await tenants.create({ id: organization.id, ownerId: user.id });
      },
      async afterAddMember({ organization, member, via }) {
        await audit.write("member.added", organization.id, member.userId, via);
      },
    },
    session: {
      beforeCreate: () => ({ ip: null, userAgent: null }),
      async afterEnd({ session, reason }) {
        await audit.write("session.ended", session.id, reason);
      },
    },
  },
});
```

- A before hook runs inside the flow's transaction, after core's rank
  checks and limits, and before the first write. This holds for
  `session.beforeCreate` in every sign-in too (see "Session points").
  `throw hookRefusal(message)` answers 403 `{ "error": "hook_refused", "message": "…" }`. A message that
  is empty, longer than 200 characters, or holds a control character becomes
  "The app refused this request.". Any other throw answers 500
  `hook_failed` and logs `authtempo: before hook failed <hook> <error name>`.
  The error name is logged only when it is a plain class name such as
  `TypeError`; any other name logs as `Error`, because the app sets it.
  Either way, no row is written.
- Three flows have a write before the before hook. An owner demotion and
  an owner removal stamp the owner lock first, and a passkey sign-in moves
  the passkey counter first. A refusal undoes the stamp. On Postgres the
  stamp's row lock is held while the hook runs, so a slow hook on an owner
  write blocks the other owner writes of that organization.
- An after hook runs after the commit, before the answer. A throw cannot
  undo the row: core logs `authtempo: after hook failed <hook> <row id>
  <error name>` and answers success. If your app must not keep a core row
  without its own row, write yours in the before hook, with the id core
  minted. Then the residual of a failure is your row with no core row. On
  Postgres, write it on a second connection (see the rule on one
  connection below).
- Each hook gets a copy of its event. A before hook cannot change the row,
  except `session.beforeCreate`, which may answer `{ ip?, userAgent?,
  activeOrganizationId? }`, each a string or null. The organization must be
  one the user is a member of, or the sign-in answers 404 `not_found`. Any
  other field answers 500 `hook_failed`. Answer a plain object. Core reads
  its own enumerable fields only. A class instance, another object that is
  not plain, and a patch that core cannot read (such as one with a getter
  that throws) answer 500 `hook_failed` too.
  `user.beforeCreate` may change the name and the image of a new user (see
  the user points below).
- Organization points: `beforeCreate`, `afterCreate`, `beforeUpdate`,
  `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeAddMember`,
  `afterAddMember`, `beforeUpdateMemberRole`, `afterUpdateMemberRole`,
  `beforeRemoveMember`, `afterRemoveMember`, `beforeInvite`,
  `afterInvite`, `afterAcceptInvitation`, `afterDeclineInvitation`, and
  `afterRevokeInvitation`. The `via` of `beforeAddMember` and
  `afterAddMember` is `create` for the creator's owner row, `add`, or
  `invitation`. Since plan 12f it is also `operator`, for a grant of the
  platform role and for `createAdmin`. The `via` of `beforeRemoveMember`
  and `afterRemoveMember` is `remove`, `leave`, or `operator` for a revoke
  of the platform role. In `afterDeclineInvitation`, `user` is null when
  the decline carried no session. An accept runs `beforeAddMember`
  with `via: "invitation"` every time, and `afterAddMember` only when it
  made a new member row. An accept that raises an existing member's role
  runs `beforeUpdateMemberRole` and `afterUpdateMemberRole` too. Its `by`
  is the inviter, or the accepting user when the inviter's user row is
  gone. A refusal keeps the role and the invitation pending. A delete
  runs no member hook for the rows it removes. In the six member points, `by`
  is null for an act of an operator secret or of the app (plan 12f).
- Session points: `beforeCreate`, `afterCreate`, and `afterEnd`. The
  `via` of the two create points is `password`, `magic_link`, `social`,
  `passkey`, `handoff`, `email_otp`, or `impersonation` since plan 12f; a
  reset by code is `password`. The `reason` of `afterEnd` is `sign_out`,
  `password_reset`, `password_change`, `claim`, `expired`, `two_factor`,
  `revoked`, `email_change`, or `account_deleted` since plan 12a. Since
  plan 12e it can be `oidc_logout`, and since plan 12f `banned`,
  `operator`, or `impersonation_end`. It fires once per ended row.
  `sweepExpired` deletes expired rows in bulk and fires no hook for them, so
  `expired` fires only when a request presents the token after its expiry.
  A claim ends a claimant's sessions with `claim` in every flow that
  proves the address. These flows are the magic link, the social sign-in,
  the verify link, and the reset of an unverified user. A
  reset of a verified user ends that user's sessions with `password_reset`.
- Plan 9f adds the end reason `two_factor`: the enable of a second factor ends every other session of the user. A session that a challenge opens has `via: "password"`.
- User points (plan 12a): `beforeCreate`, `afterCreate`, `beforeUpdate`,
  `afterUpdate`, `beforeDelete`, and `afterDelete`. The `via` of a create is
  the sign-in's `via`, `password_reset` for a reset that creates the
  user, or `operator` for `createAdmin` (plan 12f). The `via` of an update
  is `profile`, `email_change`, `ban`, or `unban`, and `patch`
  holds the fields the flow writes. `beforeDelete` gets the ids of the
  organizations that go with the account. The account delete runs
  `beforeDelete` and `afterDelete`, and no member or identity hook for the
  rows it removes. The magic link, the email code,
  social, the password sign-up, the reset link, and the reset code run the
  create points. `user.beforeCreate` may answer
  `{ name?, image? }`, each a string or null. A name follows the name
  rule of "Account", and an image follows the image rule there. Any other key or value answers 500
  `hook_failed` and logs `authtempo: user patch refused` with the reason,
  never the value.
- Verify points (plan 12a): `user.beforeVerify` and `user.afterVerify`,
  with `user` and `via` (`UserVerifyVia`). They fire once when a flow moves
  an existing user from `emailVerified: false` to true. The `via` is
  `password_verify` (the verify link), `magic_link`, `email_otp`, `social`,
  or `password_reset`. `social` is a sign-in with a verified provider
  address. `password_reset` is the reset link or the reset code. `beforeVerify` sees the stored row,
  still unverified, before the first write of the flow. A refusal answers
  403 `hook_refused` and the flow writes nothing: the user stays unverified.
  The magic link, the email code, the verify link, and social spend their
  proof before the transaction, so a refusal spends it. The reset keeps its
  link. `afterVerify` fires once after the commit with the stored row, now
  verified. A throw there logs one line, and the answer stays. A user that
  a flow creates verified fires `beforeCreate` and `afterCreate`, not these
  points. The change of address fires `beforeUpdate` and `afterUpdate`. A
  verify is not a change of a credential, so it sends no notice mail.
- Operator points (plan 12f): `hooks.operator.beforeAction` and
  `afterAction`. They need `operator.users`. `beforeAction` gets the audit
  row with no id, before the act's transaction, and a refusal answers
  `hook_refused` with no write. `afterAction` gets each stored row once
  after the commit. It also gets each `impersonation_stop` row that another
  flow writes, with no `beforeAction`.
- Identity points (plan 12a): `beforeLink`, `afterLink`, `beforeUnlink`,
  and `afterUnlink`. The `via` of a link is `sign_in` or `link`. `sign_in`
  is a social sign-in that creates a user or links a verified equal
  address. `link` is the link of a signed-in user: `beforeLink` runs
  inside its transaction, before the identity write. The `email` identity
  fires no identity hook. The unlink fires `beforeUnlink` after core's
  checks and the guard's lock, and before the delete, with no `via`.
  `afterUnlink` fires after the commit.
- The order in one flow: `user.beforeCreate` or `user.beforeVerify`, then
  `identity.beforeLink`, then `session.beforeCreate`, each before the
  first write. After the commit: `user.afterCreate` or `user.afterVerify`,
  then `identity.afterLink`, then `session.afterCreate`. The
  sign-up rule (`signUp`) runs before `user.beforeCreate`, so no hook sees
  a create that the rule refuses. A claim fires the verify points only.
  The social fill of the name and the image, the sweep, and the importer
  fire no user or identity hook.
- The uniform sign-up answers `{ sent: true }` for a new and a known
  address. `user.beforeCreate` runs only for a new address. When it refuses
  or throws, the sign-up writes no row, sends no mail, and still answers
  `{ sent: true }`. So the caller never learns whether the address has a
  user, and your refusal message does not reach the caller. A throw logs
  `authtempo: before hook failed user.beforeCreate <error name>`. The time
  of `user.beforeCreate` and `user.afterCreate` shows in the answer time of
  a new address only. So a slow hook tells the caller that the address is
  new. Keep these hooks fast, or move slow work out of the request.
- With no `afterEnd` hook, a reset, a change, a claim, and the enable of a second factor delete the ended sessions in one statement (plan 9h). With the hook, each ended row goes by id, so the hook fires once per row the flow ended; an account with many sessions then pays one statement per session.
- `session.beforeCreate` runs on a password sign-in only after the password
  is correct. So `hook_refused` against `invalid_credentials` tells the
  caller that the password was right. A ban hook should refuse with a text
  that does not depend on the password. The code still differs from a
  wrong password, so only the sign-in rate limits bound such a guess, as
  in Better Auth's ban check.
- `session.beforeCreate` runs before the first write of the sign-in's
  transaction in every flow except the reset (see its row). On D1 the undo
  of a write is not exact, so a refusal after a write could bring back a
  claimant's rows. The hook sees the user as the flow will leave it:

  | Flow | The `user` the hook sees |
  | --- | --- |
  | Password sign-up | A user core minted and has not written yet. The row does not exist at hook time, so an app's own write in the hook cannot rely on a foreign key to core's user row |
  | Password sign-in, passkey, handoff | The stored user |
  | Magic link | The stored user, marked verified when the link claims it, or a minted user that does not exist yet |
  | Social sign-in | The stored user, marked verified when the sign-in claims it and with the name and image filled, or a minted user that does not exist yet |
  | Verify link | The stored user, marked verified. A user already verified gets no session and no hook |
  | Reset | The stored user, marked verified when the reset claims it, or a minted user that does not exist yet. The reset consumes its link first, and the hook runs before every other write. The consume belongs to this request alone, so its undo is exact |

  For a minted user, a set `activeOrganizationId` answers `not_found`: the
  user is a member of nothing yet.

- A refused sign-in has spent what it presented, when the flow spends it
  before its transaction. A refused magic link, verify link, or social
  callback is consumed, and a refused passkey sign-in has spent its
  challenge and moved the passkey counter. The person starts again. A
  refused reset keeps its link: its consume is in the transaction, and the
  refusal undoes it.
- A before hook can run for a sign-in that then fails, and `afterCreate`
  does not run. A claim race guard deletes the new session in the same
  transaction and answers an error. A verify link whose password row is
  gone answers `invalid_token` after the hook. A flow that retries after a unique key race
  (the magic link, the social sign-in, the sign-up, the reset) runs its
  before hook again. `user.afterCreate` and `identity.afterLink` fire only
  for the user and the identity that the committed attempt wrote. On D1,
  a sign-up that loses a claim race keeps the user row it minted, and the
  claimer owns it. Its `user.beforeCreate` ran, and no flow fires
  `user.afterCreate` for that row. An app that must mirror every user
  writes its row in `user.beforeCreate` (spec 8.9 item 1). The sign-up
  answers `{ sent: true }`, or `email_taken_unverified` with
  `uniformSignUp: false`. The organization flows have the same window: a role
  change or a remove whose member changed since the read answers
  `conflict` after its before hook, and an accept that loses the consume
  race answers `invalid_token` after `beforeAddMember`, and for a raise
  also after `beforeUpdateMemberRole`. No after hook runs
  for any of these.
- Hooks have no timeout, as the mail port has none. A hook that never
  settles holds the request. A before hook holds the transaction, and on
  Postgres one connection, for as long as it runs. Do not open a
  transaction on core's storage from a before hook.
- On Postgres, a before hook must not run a query on the client that core's
  adapter uses while its pool has one connection (`max: 1`, the setup the
  adapter README gives for Workers). The transaction holds that one
  connection and waits for the hook, and the query waits for the
  connection: with one connection the request hangs until the pool times
  out. To write your own row from a before hook, use a second connection (a
  pool of two or more, or a separate client). Or write it from the after
  hook and accept the orphan rule above. On D1, a write through the
  binding is a separate request and takes no lock. After hooks run after
  the commit and are not affected.
- Core has no request hooks. Wrap `auth.handle`, and read
  `auth.caller(request)` for the caller.
- `createAuth` refuses a hook that is no function, a name that is no hook
  point, and a hook object that is not plain. It refuses a group other than
  `organization`, `session`, `user`, and `identity`. It refuses
  organization hooks while `organizations` is off.

### Limits

`organizations.limits` takes three positive integers. Each is off by default.

| Limit | Counts | Answer at the limit |
| --- | --- | --- |
| `perUser` | the user's member rows at any rank; a leave frees a slot | 409 `organization_limit` on create |
| `membersPerOrganization` | the organization's member rows, on add and on an accept that makes a member | 409 `member_limit`; the invitation stays pending |
| `pendingInvitationsPerOrganization` | the pending, unexpired invitations to other addresses | 409 `invitation_limit` on invite |

Core counts inside the transaction, before the before hook. On D1 the count
and the write are not isolated, so two writes at the same moment can both
pass at the limit minus one. Postgres read committed has the same window.
The API token cap has the same rule.

## Sweep

`auth.api.sweepExpired()` deletes the rows that no flow can use any more,
and calls the limiter's `sweep`, when the limiter has one, to delete the
limit windows that ended. It is an `api` function and not a route. Call it
from a scheduled handler. It is safe to run at any time. A replayed token
answers `invalid_token` after the sweep because its row is gone.

It answers one count for each kind of row:

- `verificationExpired`: verification rows past their expiry, consumed or not.
- `verificationConsumed`: consumed verification rows one day after the consume. This only matters when `magicLink.ttlMinutes` is above one day.
- `invitations`: invitations that are accepted or expired.
- `sessions`: sessions past their expiry.
- `pendingSessions`: sessions that an act left past its call budget, ended with `session.afterEnd`. A ban and a revoke of the platform role leave the sessions of the user and the impersonation sessions that the user opened. An account delete of an operator, and a removal, a leave, or a role change of the platform member row, leave only those impersonation sessions. Each of them ends a page in the act (ruling 63 of plan 12f). The sweep reads the rows before the idle clients, and the outbox leaves the calls of one page for them. The step runs last, and a row of it waits for the next sweep when it does not fit. Every door refuses such a session in the meantime.
- `apiTokens`: API tokens past their expiry. A token with no expiry stays.
- `organizationTokens`: organization tokens past their expiry. A token with no expiry stays.
- `trustedDevices`: trusted devices past their expiry.
- `totpSetups`: TOTP setups that no enable confirmed within 15 minutes.
- `jwks`: signing keys retired more than 24 hours ago.
- `oauthTokens`: refresh tokens past their expiry.
- `oauthClients`: up to 100 OAuth clients unseen for 90 days with no consent and no refresh token. A client of `api.oauth.clients.create` (kind `api`) stays: an operator made it on purpose.
- `limits`: limit windows that ended; 0 when the limiter has no `sweep`.
- `oauthDevices`: device grants past their expiry: pending, decided, and spent.
- `oauthSessionLinks`: client links whose session is gone, at most 250 per sweep, and as many as the calls of the sweep allow. The sweep reads all links in turn. Each one becomes a back-channel logout: an expiry ends a session too.
- `oauthLogouts`: back-channel logouts, at most 50 per sweep. The two back-channel steps run before the pending sessions. The whole sweep fits its call budget, its posts too: 50 calls by default (`callBudget` below). D1 Free allows 50 queries per run (D1 limits page of 21 April 2026). Workers Free allows 50 subrequests (Workers limits page of 12 October 2026). Both pages were read 2026-10-21. Each step stops before a call that does not fit, and a posted row always has room for its delete. Take 45 sessions, each with a link to one public and one pairwise client. On D1 the 90 links go out within 22 sweeps in any order. The best order takes 20. A pairwise row costs 1 call more than a public row, the read of its subject. The step keeps 9 calls for each next row, so a pairwise row first can cost a post. A test on D1 pins the best and the worst order. Run the sweep more often than once an hour to send more. A storage error in either step writes one log line and counts 0. A stop loses no logout. The rows of a page of links and the delete of those links are one write. Only a post that went out and failed counts as an attempt. Each due row gets one more attempt. The count holds the rows that a client took, and the rows deleted after their sixth attempt.
- `oauthClientSecrets`: old OAuth client secrets past the overlap of a rotation, cleared from the client.

```ts
export default {
  fetch: (request: Request) => auth.handle(request),
  async scheduled(_event: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(auth.api.sweepExpired());
  },
};
```

Add a cron trigger to the Worker config, for example `"triggers": { "crons": ["17 * * * *"] }`.
Without a trigger, expired rows stay in the database.

`auth.api.sweepExpired({ callBudget })` sets the calls of one sweep
(ruling 41 of plan 12f). It is an integer from 50 to 1000, and 50 by
default, for Workers Free. D1 Paid allows 1000 queries per run (D1 limits
page, read 2026-10-20). On Workers Paid or on Postgres, a larger budget
sends more logouts and ends more left sessions in one sweep. Another value
throws a `RangeError` before any call.

## Secrets

`secret` is version 1 of the app secret. `secrets` lists the versions, the
current one first. The current version seals each new TOTP secret and
signing key, and keys each new email code and backup code. Each row names
its version in the column `secret_version`, and a read opens a value only
under that version.

| Call | Answer |
| --- | --- |
| `auth.api.secrets.status()` | For each version: `configured`, `current`, `totpSecrets`, `backupCodes`, `signingKeys`, and `emailCodes` (live codes only). A version that a row names and the config lacks has `configured: false`. It reads every row of four tables: one query per 1000 rows of each table. With 100,000 TOTP users, a call makes more than 200 queries, so run it from a script, not from a request. |
| `auth.api.secrets.rewrap({ limit, after })` | Reseals up to `limit` (1 to 1000, default 100) TOTP secrets and keys under the current version. Answers `{ resealed, failed, skipped, more, next }`. `invalid_body` for a limit outside that range or a cursor that is not `totp:<id>` or `jwk:<id>`. |

One pass of the rewrap reads each row under a configured old version once,
in the order of the ids. Pass `next` as `after` to the next call, until
`next` is `null`. A row that fails or is skipped stays behind the cursor,
so it does not stop the rows after it. `more` stays `true` while a row
under a configured old version remains, also a row that failed or was
skipped. A row under a version that the config does not hold is never read.

- `failed`: the row did not open under its version, or a concurrent write
  changed it first. The log names the table, the row, and its version. A
  later pass reads it again. A row that fails on every pass does not open
  under its version: a TOTP user then runs a new setup, and a key retires
  at its next signature and the sweep deletes it.
- `skipped`: an unconfirmed TOTP setup that holds backup codes and is less
  than 15 minutes old. Its codes are keyed under its version, so it stays
  there until the enable. Wait 15 minutes and run a new pass: the pass then
  reseals an expired setup and clears its codes.

```ts
let after: string | undefined;
for (;;) {
  const r = await auth.api.secrets.rewrap({ limit: 100, ...(after ? { after } : {}) });
  if (!r.ok) throw new Error(r.code);
  if (r.value.next === null) break;
  after = r.value.next;
}
```

A TOTP secret also moves to the current version at its next right code,
and a key at its next signature. A keyed hash cannot move: core never sees
its code again. A backup code stays under its version until it is used or
the list is replaced. An email code lives `emailOtp.ttlMinutes`.

Remove an old version from `secrets` only after `status` shows four zeros
for it. A removed version also takes its unused backup codes: they match
no more. When `backupCodes` is above 0, ask those users to make new codes
first. A signing key under a version that the config does not hold does
not open: it retires at the next signature, and a new key signs. A TOTP
user under that version cannot pass the second factor. The rotation has two
deploys. The operations guide "Secrets" gives each step and the
consequence of a skipped step.

Run the schema 9 migration on every instance before version 2 is current
(https://authtempo.com/docs/operations/secrets/). An instance at version 8
writes each value under version 1.

## Limits in version 1

- A uniform sign-up of a new address writes rows, and one of a known
  address does not. The time of the answer can differ by that work.
- The PBKDF2 cost stays at 100000 iterations until a measurement on a
  deployed Worker proves a higher count (`examples/pbkdf2-probe`).
- The captcha token passes once. After a refused answer the person solves
  the widget again.
- The default limiter counts in memory. On Workers every isolate has its
  own count, so the real limit is the limit times the isolate count. Pass
  a shared `limiter` for a real limit. The D1 adapter ships `createD1Limiter`
  and the Postgres adapter ships `createPostgresLimiter`, both on `ta_limit`.
  The memory limiter is for tests.
- The memory adapter is for tests and examples. It keeps rows in the
  isolate.
- A request with no client IP counts against one shared IP bucket. A host
  that sets no `cf-connecting-ip` shares one budget across all callers.
- Off Workers, a caller can set `cf-connecting-ip` and rotate it past the
  per-IP limit. Pass a `clientIp` function that reads the header your
  trusted proxy sets.
- The social binding cookie is `SameSite=None`, limited to the social
  path, 10 minutes. Apple posts its callback cross-site, and a Lax cookie
  is not sent on that post.
- Social start is limited to 30 per IP per 15 minutes for every provider,
  in the same per-isolate limiter as the magic link. An `oidc` entry reads
  its discovery document after this limit.
- Every call to a provider (the token exchange, the user info step, the
  discovery read, and the JWKS read) stops after 10 s, follows no
  redirect, and answers `oauth_failed` on a 3xx. An app's `userinfo` gets a
  fetch with the same rule, also when it asks to follow.
- The confirm page has no script, so a double click on its button sends
  two posts. The first consumes the token and sets the cookie. If the
  browser drops the first answer, the second answers `invalid_token`, and
  the person asks for a new link. A page from `magicLink.confirmPage` may
  disable the button after the first press, but core's content security
  policy permits no script, so such a page needs its own route in the app.
- One binding cookie per browser: a second social start, in another tab
  or for the other provider, replaces it, and the first flow then answers
  `invalid_token`. Start again.
- The session cookie is `__Host-tempo_session` (plan 12b). For one
  release core reads the old `tempo_session` and moves it. The binding
  cookie is `__Secure-tempo_session_oauth` on the social path. The trust
  cookie is a plain host cookie.
- `session.absoluteDays` (1 to 365, off by default) ends a session that
  many days after it opened, whatever its sliding refresh (ASVS 5.0.0
  7.3.2). The person then signs in again.
- A passkey challenge is valid for five minutes and for one use. Passkey
  sign-in options are limited to 30 per IP, and verifies to 20 per IP,
  per 15 minutes, in the same per-isolate limiter.
- `claimEmail` deletes a user's passkeys when a proof arrives for an
  address that was unverified. Registration already needs a verified
  email, so this only matters for a path that creates passkeys another
  way.
- Replay protection is the challenge: a second use of the same assertion answers `invalid_token`. The counter write is conditional on the counter read, which separates two different assertions; an authenticator that always reports 0 is accepted after 0, as WebAuthn allows.
- Invite is limited to 20 per inviting user per 15 minutes and to 5 per
  invited address per hour, in the same per-isolate limiter. Each invite
  sends a mail from the app's sender, so the product owns this limit. The
  per-address budget is shared by every inviter, so one verified user can
  use up an address's five invites for an hour; the per-user budget bounds
  how many addresses one user can do that to.
- Organization `metadata` is at most 4096 bytes as JSON. A larger value
  answers 400 `invalid_body`. Every member reads it in `GET /organizations`.
- Two invites for the same address at the same time can leave two pending
  invitations, because the pair of organization and address is an index,
  not a unique key. Both links work until one is accepted, revoked, or
  expired.
- On Node, loading @simplewebauthn/server prints one ExperimentalWarning
  about ML-DSA. It is the library's post-quantum probe, not a authtempo
  setting, and workerd prints nothing.
- Invitation accept is limited to 20 per IP per 15 minutes, in the same per-isolate limiter.
- The live check of a session JWT is limited to 120 per session per 60 s (`token-live:session:<sessionId>`, plan 11d). The count runs after the JWT check, so a bearer that is not a session JWT spends nothing.
- The operator route is limited to 5 calls per IP per hour
  (`operator:ip:<ip>`), right or wrong secret, in the same limiter.
- The secret status, secret rewrap, and info routes are limited to 120
  calls per IP per hour (`operator-secrets:ip:<ip>`), in the same limiter.
  The three share one count, right or wrong secret. A rewrap of 100 000
  rows at 1000 rows per call needs 100 calls.
- Email codes: a request is limited to 3 per address and 20 per IP, and a
  verify or a reset to 10 per address and 30 per IP, per 15 minutes, in the
  same limiter. The sign-in code and the reset code share each budget. Two
  parallel requests for one address can leave two live codes; the verify
  reads the newest.
- Email codes (amended 2026-10-13 by the plan 9e final fix wave): a request
  is also limited to 20 per address per 24 hours, for both purposes, in the
  same limiter. The odds table is in "Email codes".
- Core at version 4 needs the `0004_schema_v4` migration in both adapters. Version 4 adds the password table.
- Core at version 5 needs the `0005_schema_v5` migration in both adapters. Version 5 adds the API token table, `ta_api_token`.
- Core at version 6 needs the `0006_schema_v6` migration in both adapters. Version 6 adds `ta_totp` and `ta_trusted_device` (plan 9f).
- Core at version 7 needs the `0007_schema_v7` migration in both adapters. Version 7 adds `ta_jwk`, `ta_oauth_client`, `ta_oauth_consent`, and `ta_oauth_token` (plan 9g).
- Core at version 8 needs the `0008_schema_v8` migration in both adapters. Version 8 adds `ta_second_factor` and copies each enabled `ta_totp` row into it with the same id, so every stored backup code stays valid (plan 12c). It also deletes each `ta_totp` setup that no enable confirmed: a setup open across the deploy answers `totp_not_enabled` at the enable, and the person sets up again.
- Warning: a Worker at version 7 still runs between `0008_schema_v8` and the deploy. Its second-factor writes do not reach `ta_second_factor`. Deploy core at version 8 at once after the migration. Then run the three checks of the adapter README ("Migrations") immediately after the deploy. They list an enabled `ta_totp` row with no factor row, a factor row that lists `totp` with no enabled `ta_totp` row, and a version 1 factor row whose backup codes differ from its `ta_totp` row.
- Core at version 9 needs the `0009_schema_v9` migration in both adapters, and the compatibility package needs `0006_compat_schema_v9`. Version 9 adds `secret_version` to `ta_totp`, `ta_second_factor`, `ta_verification`, and `ta_jwk` (plan 12b). The column is `NOT NULL DEFAULT 1`, so every row of today reads as version 1. A Worker at version 8 that still runs after the migration writes the default 1. That is correct while the app has one secret: add a second secret version only after every Worker runs core at version 9.
- Core at version 10 needs the `0010_schema_v10` migration in both adapters. Version 10 adds `ta_session.fresh_at`, the time a sign-in or a re-authentication last proved the person (plan 12a). A session of an earlier version holds null and re-authenticates once before its first sensitive change. The compat package's migration is `0007_compat_schema_v10`.
- Core at version 11 needs the `0011_schema_v11` migration in both adapters (plan 12e). Version 11 adds the columns of a confidential client to `ta_oauth_client`, two columns to `ta_oauth_token`, and four tables of the OAuth provider's second version. Each client row of an earlier version reads as a public client. The compat package's migration is `0008_compat_schema_v11`.
- Core at version 12 needs the `0012_schema_v12` migration in both adapters (plan 12f). Version 12 adds the three ban fields to `ta_user`, `actor_id` to `ta_session`, and the table `ta_operator_audit`. A row of an earlier version holds null: no ban and no impersonation. The compat package's migration is `0009_compat_schema_v12`.
- Core at version 13 needs the `0013_schema_v13` migration in both adapters (plan 12k). Version 13 adds `active_team_id` to `ta_session`, `team_ids` to `ta_invitation`, nine columns to `ta_api_token`, and the tables of stored roles, teams, team members, and organization tokens. A row of an earlier version holds null in each new column. The compat package's migration is `0010_compat_schema_v13`.
- Handoff start is limited to 30 per IP, and redeem to 20 per IP, per 15
  minutes, in the same per-isolate limiter.
- The sign-in page needs a browser that keeps cookies between the start
  and the callback of a social sign-in; an ephemeral auth session that
  drops cookies answers `invalid_token` on the callback.
- `devRedirectPattern` admits any URL it matches. A loose pattern lets a
  page that can open the system browser send the one-time code to an
  origin it controls. Keep the pattern to the dev host and port, and
  leave it unset in production.
- The router adds the CORS headers to a handler's response in place. A
  handler that returns a `Response` with immutable headers, such as
  `Response.redirect` or a proxied fetch answer, must copy it first. Every
  route core ships builds its own `Response`.

## The storage port

Six methods: `create`, `findOne`, `findMany`, `update`, `delete`,
`transaction`. Clauses join with AND. Operators: `eq ne in lt lte gt gte
startsWith`. One sort field. No joins. Run `runAdapterConformance` from
`@authtempo/core/conformance` against a new adapter; it is the contract.

`startsWith` matches the exact text of a non-empty prefix on a string
field. Case counts, as for `eq`, and it has no wildcard. It never matches
null. The prefix is a parameter. An SQL adapter compares
`substr(column, 1, n)`, where n is the count of code points, so no index
serves it and each call reads the whole table. An empty prefix, a value or
a field that is not a string, a lone surrogate, or NUL throws
`invalid_argument`.

`@authtempo/core/testing` also exports `ROUTES`, every route that core can
serve, each with the config that turns it on. A core test proves that the
router serves exactly that list when every feature is on.
