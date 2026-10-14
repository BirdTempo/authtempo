import { createBreachCheck } from "@authtempo/breach-check";
import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createBreachCheckAuth(deps: {
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
    password: {
      // The HIBP range API: only 5 characters of the SHA-1 leave the server.
      // No answer in 2 seconds refuses the password with breach_check_unavailable.
      breachCheck: createBreachCheck({ timeoutMs: 2000 }),
    },
  });
}
