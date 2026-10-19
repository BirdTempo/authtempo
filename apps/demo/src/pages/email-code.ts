import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

const EMAIL = { name: "email", label: "Email", type: "email", autocomplete: "email" } as const;
const CODE = { name: "code", label: "Code", type: "text", autocomplete: "one-time-code" } as const;

export const emailCodePage: PageBody = {
  script: "email-code",
  body: () => html`<p class="lede">Ask for a code, then read it in the mailbox. Type the code here to sign in.</p>
${callForm("request", "Ask for a sign-in code", [EMAIL], "Send the code")}
${callForm("verify", "Sign in with the code", [EMAIL, CODE], "Sign in")}
<p>A code can also reset the password of an account that has one.</p>
${callForm("request-reset", "Ask for a reset code", [EMAIL], "Send the reset code")}
${callForm(
  "reset",
  "Reset the password with the code",
  [
    EMAIL,
    CODE,
    { name: "password", label: "New password", type: "password", autocomplete: "new-password" },
  ],
  "Reset the password",
)}
<p><a href="/mailbox">Open the mailbox</a></p>`,
};
