import { type Html, html } from "../html.js";

/** The title of the pick page of the demo provider. */
export const PROVIDER_TITLE = "Demo provider: pick a test identity";

/** The body of the pick page: one button per test identity, and one field for a free address. */
export function providerBody(input: {
  action: string;
  identities: Readonly<Record<string, { email: string; name: string }>>;
  maxEmail: number;
}): Html {
  const buttons = Object.entries(input.identities).map(
    ([key, id]) =>
      html`<li><button type="submit" name="identity" value="${key}">${id.name} (${id.email})</button></li>`,
  );
  return html`<p class="lede">This page stands in for a real provider. It runs inside your sandbox.</p>
<form class="call" method="post" action="${input.action}">
<h2>Pick an identity</h2>
<ul class="identities">${buttons}</ul>
<h2>Or use another address</h2>
<label>Address <input type="email" name="email" maxlength="${input.maxEmail}" autocomplete="email"></label>
<button type="submit" name="identity" value="free">Continue with this address</button>
</form>`;
}
