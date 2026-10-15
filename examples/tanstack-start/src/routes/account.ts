import { getSession } from "@authtempo/tanstack-start";
import { createFileRoute } from "@tanstack/react-router";

// The middleware sends a person with no session to /sign-in before this handler runs.
export const Route = createFileRoute("/account")({
  server: {
    handlers: {
      GET: ({ context }) =>
        new Response(`<p>Your account: ${getSession(context)?.user.email}</p>`, {
          headers: { "content-type": "text/html" },
        }),
    },
  },
});
