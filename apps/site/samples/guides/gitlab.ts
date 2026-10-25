import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createGitlabAuth(deps: {
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
    social: {
      // Read the secret from your secret store. The placeholders only build the config.
      gitlab: {
        clientId: "gitlab-application-id",
        clientSecret: "gitlab-secret",
        // Your own GitLab instance. Leave it out for gitlab.com.
        issuer: "https://gitlab.example.org",
      },
    },
  });
}
