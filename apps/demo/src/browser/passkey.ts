import { bind, client, optional } from "./exchange.js";

bind({
  register: (f) => client.passkey.register({ name: optional(f, "name") }),
  "sign-in": () => client.passkey.signIn(),
  list: () => client.passkeys.list(),
});
