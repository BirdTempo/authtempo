import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

export const passwordPage: PageBody = {
  script: "password",
  body: () => html`<p class="lede">Sign up with an address and a password. The demo sends a link to the mailbox.</p>
<p>Open the link in the mailbox to prove the address. Then sign in with the password.</p>
${callForm(
  "sign-up",
  "Sign up",
  [
    { name: "email", label: "Email", type: "email", autocomplete: "email" },
    { name: "password", label: "Password", type: "password", autocomplete: "new-password" },
    { name: "name", label: "Name", type: "text", autocomplete: "name", optional: true },
  ],
  "Sign up",
)}
${callForm(
  "sign-in",
  "Sign in",
  [
    { name: "email", label: "Email", type: "email", autocomplete: "email" },
    { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
  ],
  "Sign in",
)}
${callForm(
  "request-reset",
  "Ask for a reset link",
  [{ name: "email", label: "Email", type: "email", autocomplete: "email" }],
  "Send the reset link",
)}
<p>The reset link in the mailbox opens a page of its own. You can also copy the token of the link into this form.</p>
${callForm(
  "reset",
  "Reset the password",
  [
    { name: "token", label: "Token of the link", type: "text", autocomplete: "off" },
    { name: "password", label: "New password", type: "password", autocomplete: "new-password" },
  ],
  "Reset the password",
)}
${callForm(
  "change",
  "Change the password",
  [
    {
      name: "currentPassword",
      label: "Current password",
      type: "password",
      autocomplete: "current-password",
    },
    { name: "newPassword", label: "New password", type: "password", autocomplete: "new-password" },
  ],
  "Change the password",
)}`,
};
