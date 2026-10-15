import { getSession } from "@authtempo/tanstack-start";
import { createFileRoute } from "@tanstack/react-router";

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });

// A server route: the request middleware gave the session to its context.
export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: ({ context }) => {
        const session = getSession(context);
        return html(
          session ? `<p>Signed in as ${session.user.email}</p>` : `<a href="/sign-in">Sign in</a>`,
        );
      },
    },
  },
});
