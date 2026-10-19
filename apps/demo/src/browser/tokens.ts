import { bind, client, text } from "./exchange.js";

bind({
  create: (f) => client.tokens.create({ name: text(f, "name") }),
  list: () => client.tokens.list(),
  revoke: (f) => client.tokens.revoke({ id: text(f, "id") }),
});
