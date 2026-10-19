import { bind, client, text } from "./exchange.js";

bind({
  request: (f) => client.emailOtp.request({ email: text(f, "email") }),
  verify: (f) => client.emailOtp.verify({ email: text(f, "email"), code: text(f, "code") }),
  "request-reset": (f) => client.emailOtp.requestReset({ email: text(f, "email") }),
  reset: (f) =>
    client.emailOtp.reset({
      email: text(f, "email"),
      code: text(f, "code"),
      password: text(f, "password"),
    }),
});
