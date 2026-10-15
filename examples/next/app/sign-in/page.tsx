"use client";
import { ERRORS, type ErrorCode, errorText, type OAuthClientCode } from "@authtempo/client";
import { type AuthErrorCode, useAuthError, useClient, useSession } from "@authtempo/react";
import { useState } from "react";

/**
 * The text of a redirect error. A code of core's table takes the core text;
 * any other code is an OAuth code or `unexpected`, which the OAuth table answers.
 */
function redirectText(code: NonNullable<AuthErrorCode>): string {
  return Object.hasOwn(ERRORS, code)
    ? errorText(code as ErrorCode)
    : errorText(code as OAuthClientCode, "oauth");
}

/** The sign-in page. The client and the session come from the Providers of the layout. */
export default function SignIn() {
  const c = useClient();
  const session = useSession();
  // `?auth_error=<code>` of a social sign-in that came back with a failure, read once.
  const authError = useAuthError();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The prerendered page and the first paint wait for the session read.
  if (session.isPending) return <p>Loading</p>;
  if (session.data) return <p>Signed in as {session.data.user.email}</p>;
  if (sent) return <p>Open the link in the mail.</p>;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const next = new URLSearchParams(location.search).get("next") ?? "/";
        const r = await c.magicLink.request({ email, next });
        if (r.ok) setSent(true);
        else setFailure(errorText(r.code));
      }}
    >
      {authError && <p role="alert">{redirectText(authError)}</p>}
      {failure && <p role="alert">{failure}</p>}
      <label>
        Email
        <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button type="submit">Send a sign-in link</button>
    </form>
  );
}
