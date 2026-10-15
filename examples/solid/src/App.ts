import { useSession } from "@authtempo/solid";
import type { JSX } from "solid-js";
import html from "solid-js/html";

/** The session of the person, kept current by the session store. */
export function App(): JSX.Element {
  const { session } = useSession();
  return html`<p>${() => {
    const s = session();
    if (s.isPending) return "Reading the session";
    return s.data ? `Signed in as ${s.data.user.email}` : "Signed out";
  }}</p>`;
}
