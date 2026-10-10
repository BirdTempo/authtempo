# @tempo-auth/compat-better-auth

Run an app written for Better Auth 1.7 on tempo-auth. The app keeps its code
and its tables. A package alias points the Better Auth package names at this
package.

## The alias

pnpm and npm, in the app's `package.json`:

```json
{
  "dependencies": {
    "better-auth": "npm:@tempo-auth/compat-better-auth@0.0.0",
    "@better-auth/drizzle-adapter": "npm:@tempo-auth/compat-better-auth@0.0.0",
    "@better-auth/expo": "npm:@tempo-auth/compat-better-auth@0.0.0",
    "@better-auth/passkey": "npm:@tempo-auth/compat-better-auth@0.0.0",
    "@tempo-auth/core": "0.0.0",
    "@tempo-auth/client": "0.0.0",
    "@tempo-auth/handoff": "0.0.0",
    "@tempo-auth/adapter-d1": "0.0.0",
    "@tempo-auth/adapter-postgres": "0.0.0"
  }
}
```

yarn (classic and berry) reads the same `npm:` form. Both adapters are
required peers, also in an app that uses one database: the server entry
loads both. Neither has a runtime dependency.

Map only the names the app imports. A Better Auth package with no alias, for
example `@better-auth/api-key`, stays the real package, and `betterAuth`
refuses its plugin by id at construction.

| Import in the app | Answered by |
| --- | --- |
| `better-auth` | `.` |
| `better-auth/plugins` | `./plugins` |
| `better-auth/react` | `./react` |
| `better-auth/client` | `./client` |
| `better-auth/client/plugins` | `./client/plugins` |
| `better-auth/adapters/drizzle`, `@better-auth/drizzle-adapter` | `./adapters/drizzle` and `.` |
| `better-auth/node` | `./node` |
| `better-auth/next-js` | `./next-js` |
| `@better-auth/expo` | `.` (`expo`) |
| `@better-auth/expo/client` | `./client` (`expoClient`) |
| `@better-auth/passkey` | `.` (`passkey`) |
| `@better-auth/passkey/client` | `./client` (`passkeyClient`) |

## Passwords from Better Auth

`betterAuthPasswordHash` verifies a Better Auth scrypt hash and rewrites it as
PBKDF2 on the first right sign-in. A legacy row verifies slower than a PBKDF2
row until that sign-in rehashes it. So during the migration window the
response time shows which accounts are not yet migrated. Each account loses
this tell at its first right sign-in. At most two scrypt derives run at once
per isolate; the others wait, and no sign-in is refused.
