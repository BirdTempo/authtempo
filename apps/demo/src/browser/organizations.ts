import { bind, client, text } from "./exchange.js";

bind({
  create: (f) => client.organizations.create({ name: text(f, "name"), slug: text(f, "slug") }),
  list: () => client.organizations.list(),
  invite: (f) =>
    client.organizations.invitations.invite({
      organizationId: text(f, "organizationId"),
      email: text(f, "email"),
      role: "member",
    }),
  activate: (f) => client.organizations.setActive({ organizationId: text(f, "organizationId") }),
});
