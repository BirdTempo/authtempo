# @authtempo/react

The React binding of authtempo. It runs in React DOM and React Native. It
takes `react` 19 as a peer dependency.

```tsx
import { createClient } from "@authtempo/client";
import { AuthProvider, useSession } from "@authtempo/react";

const client = createClient({ baseURL: "https://api.example.com" });

function Account() {
  const { data, isPending, error } = useSession();
  if (isPending) return <p>Loading</p>;
  if (error) return <p>{error.code}</p>;
  return <p>{data ? data.user.email : "Signed out"}</p>;
}

export const Root = () => (
  <AuthProvider client={client}>
    <Account />
  </AuthProvider>
);
```

| Export | What it does |
| --- | --- |
| `AuthProvider` | Gives the client to every hook below it. Make the client once, outside the render. |
| `useSession()` | `{ data, error, isPending, isRefetching, refetch }` of `client.store`. The store reads at the first mount and after each change. A server render shows the pending state. |
| `useClient()` | The client of the nearest provider. It throws when there is none. |
| `useAuthError(url?)` | The code of `?auth_error=` in the page's URL, read once at mount, or `null`. |
