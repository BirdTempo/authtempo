import { getSession } from "@authtempo/solid/start";
import type { APIEvent } from "@solidjs/start/server";

// An API route that answers HTML: the middleware put the session in locals.
export function GET(event: APIEvent) {
  const session = getSession(event);
  return new Response(
    session ? `<p>Signed in as ${session.user.email}</p>` : `<a href="/sign-in">Sign in</a>`,
    { headers: { "content-type": "text/html" } },
  );
}
