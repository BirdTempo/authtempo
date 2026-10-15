"use client";
import { errorText } from "@authtempo/client";
import { useClient, useSession } from "@authtempo/react";
import { useState } from "react";

/**
 * The sign-in page. The client, the session, and the text of a redirect error
 * come from the Providers of the layout.
 */
export default function SignIn() {
  const c = useClient();
  const session = useSession();
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
      {failure && <p role="alert">{failure}</p>}
      <label>
        Email
        <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button type="submit">Send a sign-in link</button>
    </form>
  );
}
