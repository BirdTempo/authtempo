import { getSession } from "@authtempo/solid/start";
import type { APIEvent } from "@solidjs/start/server";

// The middleware sends a person with no session to /sign-in before this route runs.
export function GET(event: APIEvent) {
  return new Response(`<p>Your account: ${getSession(event)?.user.email}</p>`, {
    headers: { "content-type": "text/html" },
  });
}
