import { html } from "../html.js";
import { DEMO_PAGES, type PageBody } from "./layout.js";

/** One line for each method page of the list. */
const LINES: Readonly<Record<string, string>> = {
  "/password": "Sign up, sign in, and reset or change a password.",
  "/magic-link": "Sign in with a link from the mailbox.",
  "/email-code": "Sign in with a code from the mailbox.",
  "/passkey": "Add a passkey, then sign in with it.",
  "/social": "Sign in through the demo provider.",
  "/second-factor": "Turn on an authenticator code for a password account.",
  "/tokens": "Make an API token for a script, then revoke it.",
  "/organizations": "Make an organization and invite a second address.",
  "/mailbox": "Read each mail that the demo sends.",
};

export const homePage: PageBody = {
  script: null,
  body: () => html`<p class="lede">This demo runs each sign-in method of authtempo on test data.</p>
<p>Each visitor gets a sandbox. The sandbox has its own store, its own mailbox, and its own secret. No mail leaves the demo.</p>
<h2>Pick a method</h2>
<ul class="methods">${DEMO_PAGES.filter((p) => p.path !== "/").map(
    (p) => html`<li><a href="${p.path}">${p.title}</a>: ${LINES[p.path] ?? ""}</li>`,
  )}</ul>
<p>Start again deletes your sandbox at once. Then the demo makes a new sandbox for you.</p>`,
};
