import { bind, client, optional, text } from "./exchange.js";

bind({
  "sign-up": (f) =>
    client.password.signUp({
      email: text(f, "email"),
      password: text(f, "password"),
      name: optional(f, "name"),
    }),
  "sign-in": (f) =>
    client.password.signIn({ email: text(f, "email"), password: text(f, "password") }),
  "request-reset": (f) => client.password.requestReset({ email: text(f, "email") }),
  reset: (f) => client.password.reset({ token: text(f, "token"), password: text(f, "password") }),
  change: (f) =>
    client.password.change({
      currentPassword: text(f, "currentPassword"),
      newPassword: text(f, "newPassword"),
    }),
});
