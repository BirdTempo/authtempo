---
title: Frequently asked questions
description: Answers to the questions that people ask before they move an app to authtempo, each with a link to the guide that holds the full fact.
type: reference
sources:
  - apps/site/src/content/docs/docs/migrate/cutover.md "How it behaves"
  - apps/site/src/content/docs/docs/migrate/better-auth.mdx "How it behaves"
  - apps/site/src/content/docs/docs/migrate/supabase.mdx "How it behaves"
  - apps/site/src/content/docs/docs/migrate/clerk.mdx "How it behaves"
  - apps/site/src/content/docs/docs/migrate/auth0.mdx "How it behaves"
  - apps/site/src/content/docs/docs/migrate/firebase.mdx "If it fails"
  - apps/site/src/content/docs/docs/migrate/authjs.mdx "How it behaves"
  - apps/site/src/content/docs/docs/migrate/cognito.mdx "How it behaves"
  - apps/site/src/content/docs/docs/migrate/index.md "Steps"
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md "Task 17"
---

**For:** a developer or an operator who plans to move an app to authtempo and has a question before the move.

**What it does:** this page answers the questions that people ask before a move. Each answer links the guide section that holds the full fact.

## Before you start

- Know your source system. [Choose a migration path](/docs/migrate/) gives the guide of each source.

## Questions

### Do my users have to reset their passwords?

No. An old password hash verifies until the user's first right sign-in, as [How the cutover behaves](/docs/migrate/cutover/#how-it-behaves) states.

### Do my users stay signed in after the cutover?

No. Every session of the old system ends, and its tokens do not exist in authtempo, as [How the cutover behaves](/docs/migrate/cutover/#how-it-behaves) states.

### Can I go back to the old provider?

After an import, a rollback to the old system loses each user and each change made in authtempo since the cutover. With the compatibility package, the Better Auth tables stay readable by Better Auth. [How the cutover behaves](/docs/migrate/cutover/#how-it-behaves) gives both cases.

### Does my app code change?

An app on Better Auth keeps its code, and changes only its package aliases and the options that core refuses. An app that you import changes its auth calls, as the table of [Choose a migration path](/docs/migrate/#steps) shows.

### What happens to a magic link or an invitation that I sent before the cutover?

A pending invitation and a magic link of the old system answer `invalid_token`. Send each invitation again, as [How the cutover behaves](/docs/migrate/cutover/#how-it-behaves) states.

### Which Better Auth options does authtempo refuse?

At start, the shim throws one `BetterAuthCompatError`, and its list names each refused option. The refused options include the plugins `jwt`, `mcp`, `cimd`, `oidc-provider`, and `oauth-provider`, and a provider's `disableImplicitSignUp`. [How it behaves](/docs/migrate/better-auth/#how-it-behaves) gives each rule.

### Does the session cookie of Better Auth keep its name?

No. The session cookie is `__Host-tempo_session`, not `better-auth.session_token`. Change each test and each legal page that names the old cookie, as [How it behaves](/docs/migrate/better-auth/#how-it-behaves) states.

### Does a Better Auth path that my app fetches still work?

No. A Better Auth path that the app calls with its own `fetch` fails. Call the client method instead, as [How it behaves](/docs/migrate/better-auth/#how-it-behaves) states.

### Does every Supabase user import?

No. An SSO user, a banned user, and a phone-only user with no address are skipped. [How it behaves](/docs/migrate/supabase/#how-it-behaves) lists each case.

### Do Clerk passkeys move to authtempo?

No. Clerk passkeys do not move, because the API of Clerk gives no public key. [How it behaves](/docs/migrate/clerk/#how-it-behaves) lists what moves.

### What happens when I import from Auth0 with no hash file?

The command prints one line and imports no password. A reset or a magic link then signs each user in, as [How it behaves](/docs/migrate/auth0/#how-it-behaves) states.

### Why does every imported Firebase password fail?

A hash parameter of the Firebase project is wrong. The export carries no hash parameters, so a wrong value refuses every first sign-in with no line in the report. [If it fails](/docs/migrate/firebase/#if-it-fails) names the cause.

### Does the import from Auth.js copy the OAuth tokens of the providers?

No. The select leaves out the OAuth tokens of `Account`, because a refresh token gives access to the person's account at the provider. [How it behaves](/docs/migrate/authjs/#how-it-behaves) lists what else the import drops.

### How do my Cognito users keep their passwords?

Cognito exports no hash, so core asks Cognito once, at each user's first password sign-in. A right answer writes core's own hash, and a user with a Cognito challenge resets the password. [How it behaves](/docs/migrate/cognito/#how-it-behaves) gives each case.

### Do the JWTs and the OAuth clients of the old system still work?

No. A JWT of the old system stops verifying, and each OAuth client of the old system signs in again. [How the cutover behaves](/docs/migrate/cutover/#how-it-behaves) lists what else ends.

### When do I change the callback URL at GitHub?

A GitHub OAuth App takes one callback URL, so change it at the moment of the cutover. A GitHub App takes several, as the warning in [How the cutover behaves](/docs/migrate/cutover/#how-it-behaves) states.

## Next

- [The cutover](/docs/migrate/cutover/)
- [From Better Auth](/docs/migrate/better-auth/)
