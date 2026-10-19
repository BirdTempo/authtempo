import { html } from "../html.js";
import { callForm, type PageBody } from "./layout.js";

const ORG = { name: "organizationId", label: "Id of the organization", type: "text" } as const;

export const organizationsPage: PageBody = {
  script: "organizations",
  body: () => html`<p class="lede">Make an organization, then invite a second address. Sign in first.</p>
<p>The invitation goes to the mailbox. Sign in as the second address to accept it.</p>
${callForm(
  "create",
  "Make an organization",
  [
    { name: "name", label: "Name", type: "text" },
    { name: "slug", label: "Slug", type: "text" },
  ],
  "Make it",
)}
${callForm("list", "Your organizations", [], "List the organizations")}
${callForm(
  "invite",
  "Invite an address",
  [ORG, { name: "email", label: "Email", type: "email" }],
  "Send the invitation",
)}
${callForm("activate", "Set the active organization", [ORG], "Set it")}`,
};
