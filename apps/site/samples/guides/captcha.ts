import { createTurnstileCaptcha } from "@authtempo/captcha-turnstile";
import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createCaptchaAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    password: {},
    captcha: {
      // Cloudflare's always-pass test keys. Put your own secret key in the secret store.
      port: createTurnstileCaptcha({
        secretKey: "1x0000000000000000000000000000000AA",
        siteKey: "1x00000000000000000000AA",
      }),
      // The default flows: the sign-up, the magic link, the email code, and the reset requests.
      // "allow" (the default) goes on when the captcha gives no answer. "refuse" answers 503.
      onUnavailable: "allow",
    },
  });
}
