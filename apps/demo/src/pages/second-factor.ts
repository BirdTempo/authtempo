import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

const PASSWORD = {
  name: "password",
  label: "Password",
  type: "password",
  autocomplete: "current-password",
} as const;
const CODE = { name: "code", label: "Code", type: "text", autocomplete: "one-time-code" } as const;

export const secondFactorPage: PageBody = {
  script: "second-factor",
  body: () => html`<p class="lede">Sign up and sign in with a password first. Then turn on the second factor here.</p>
${callForm("setup", "Start the setup", [PASSWORD], "Start the setup")}
<section class="panel" id="totp-panel" hidden><h2>Demo authenticator</h2>
<p>Current code: <code id="totp-code">------</code></p>
<p>Secret: <code id="totp-secret"></code></p>
<p>The code changes every 30 seconds. A real authenticator app also works: type the secret into the app.</p></section>
${callForm("enable", "Turn on the second factor", [CODE], "Turn it on")}
${callForm(
  "sign-in",
  "Sign in with the second factor",
  [{ name: "email", label: "Email", type: "email", autocomplete: "email" }, PASSWORD],
  "Sign in",
)}
${callForm("verify", "Send the code of the sign-in", [CODE], "Send the code")}
${callForm("status", "Status", [], "Read the status")}`,
};
