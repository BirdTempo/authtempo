import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

export const magicLinkPage: PageBody = {
  script: "magic-link",
  body: () => html`<p class="lede">Ask for a link, then open it in the mailbox. The link signs you in.</p>
<p>A new address gets a new account. The link works once. The mail states how long it stays valid.</p>
${callForm(
  "request",
  "Ask for a link",
  [{ name: "email", label: "Email", type: "email", autocomplete: "email" }],
  "Send the link",
)}
<p><a href="/mailbox">Open the mailbox</a></p>`,
};
