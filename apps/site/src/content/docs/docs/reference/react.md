---
title: The React package
description: The provider and the hooks of @authtempo/react.
type: reference
sources:
  - packages/react/README.md
  - packages/react/src/index.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 20
  - docs/superpowers/plans/2026-10-14-11d-sdks.md
---

**For:** a developer of a React DOM app or a React Native app.

**What it does:** this page lists the provider and the hooks of the package. The export check holds this page to `packages/react/src/index.ts`.

## Before you start

- Read [The client package](/docs/reference/client/) for the session store under the hooks.

## Exports

| Export | What it does |
| --- | --- |
| `AuthProvider` | Gives a client to every hook below it. Make the client once, outside the render. |
| `useSession` | Answers a `UseSession`: the state of `client.store`, `{ data, error, isPending, isRefetching }`, and `refetch`. |
| `UseSession` | The type of the answer of `useSession`. |
| `useClient` | Answers the client of the nearest provider. It throws when there is none. |
| `useAuthError` | Answers the code of `?auth_error=` in the URL, read once at mount, or `null`. With no location (React Native) it reads only its argument. |
| `AuthErrorCode` | The type of the code that `useAuthError` answers: the answer of `client.readRedirectError`. It holds a code of the core table or of the OAuth table. |

## How it behaves

- The store reads the session at the first mount, and again after each call that changes the session.
- A server render shows the pending state. The store reads at its first subscriber, and a server render does not subscribe.
- The package uses no DOM API. It runs in React DOM and React Native.
- It takes `react` 19 as a peer dependency.

## Next

- [Show the session in React](/docs/guides/react-session/)
- [The client package](/docs/reference/client/)
