import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

export const passkeyPage: PageBody = {
  script: "passkey",
  body: () => html`<p class="lede">Sign in first with a magic link or a password. Then add a passkey to the account.</p>
<p class="warn">A passkey stays in your password manager after the reset. Delete it there: it has the name authtempo demo.</p>
${callForm(
  "register",
  "Add a passkey",
  [{ name: "name", label: "Name of the passkey", type: "text", optional: true }],
  "Add a passkey",
)}
${callForm("sign-in", "Sign in with a passkey", [], "Sign in with a passkey")}
${callForm("list", "Your passkeys", [], "List the passkeys")}`,
};
