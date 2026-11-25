---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": patch
---

The TOTP setup takes an email code in place of the password. `POST /totp/setup` takes `{ password }` or `{ emailCode }`, exactly one. The code is the code of `POST /reauth/email`, and a right code is spent. `api.totp.setup` takes `{ session, password }` or `{ session, emailCode, ip }`, and `client.totp.setup` takes `{ password }` or `{ emailCode }`. A wrong code answers `invalid_code`, the spent guesses of a code answer `too_many_attempts`, and both write no row. Each try counts on `totp-setup:user`, 5 per 15 minutes, as before.

`totp` no longer needs `password`. With no `password`, the factor stays off by default, so an upgrade turns nothing on. Set `totp: {}` to turn it on: the gate then covers the magic link, the email code, and social, and the setup takes the email code. A config with `totp` and neither `password` nor `emailOtp` is refused at start with a new message. A session alone still sets up no factor: the thief of a session does not read the owner's mailbox.

A proof that the deployment lacks answers `not_found` and counts no try: `password` with no `password` config, and `emailCode` with `emailOtp: false`. The passkey method and the email method still take the password.

The Better Auth compat layer still refuses `allowPasswordless: true`. Its refusal text changes: core asks for a proof at every change of the factor, and a session alone is no proof.
