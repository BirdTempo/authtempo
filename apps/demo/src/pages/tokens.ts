import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

export const tokensPage: PageBody = {
  script: "tokens",
  body: () => html`<p class="lede">An API token lets a script call the API as you. Sign in first.</p>
<p>The demo shows the token once, when it makes the token. The last call shows only its first 6 characters.</p>
${callForm("create", "Make a token", [{ name: "name", label: "Name", type: "text" }], "Make a token")}
${callForm("list", "Your tokens", [], "List the tokens")}
${callForm("revoke", "Revoke a token", [{ name: "id", label: "Id of the token", type: "text" }], "Revoke")}`,
};
