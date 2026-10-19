import { bind, client, text } from "./exchange.js";
import { startPanel } from "./totp-panel.js";

/** The challenge of the last sign-in that needs the second factor. */
let challenge: string | null = null;

bind({
  setup: async (f) => {
    const r = await client.totp.setup({ password: text(f, "password") });
    if (r.ok) startPanel(r.value.secret);
    return r;
  },
  enable: (f) => client.totp.enable({ code: text(f, "code") }),
  "sign-in": async (f) => {
    const r = await client.password.signIn({
      email: text(f, "email"),
      password: text(f, "password"),
    });
    challenge = r.ok && "twoFactor" in r.value ? r.value.twoFactor.challenge : null;
    return r;
  },
  verify: async (f) => {
    if (challenge === null) throw new Error("Sign in first. The sign-in gives the challenge.");
    return client.totp.verify({ challenge, code: text(f, "code") });
  },
  status: () => client.totp.status(),
});
