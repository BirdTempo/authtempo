import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

export const socialPage: PageBody = {
  script: "social",
  body: () => html`<p class="lede">The demo has its own provider. It runs inside your sandbox, so no request leaves the demo.</p>
<p>The provider page lets you pick a test identity. Then the demo signs you in as that identity.</p>
${callForm("start", "Sign in through the provider", [], "Continue with the demo provider")}`,
};
