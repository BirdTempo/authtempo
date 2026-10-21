import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The plan that each new sign-in asked for. A real app writes its own table. */
export const chosenPlans: string[] = [];

export function createStateDataAuth(deps: {
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
      google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
      // The start takes `data`: at most 512 bytes of JSON here, sealed in the state row.
      stateData: { maxBytes: 512 },
    },
    hooks: {
      session: {
        // The browser sent the payload: read it as a wish, never as a right.
        async afterCreate({ user, stateData }) {
          if (typeof stateData?.plan === "string") chosenPlans.push(`${user.id} ${stateData.plan}`);
        },
      },
    },
  });
}

/** The start URL with the payload: the base64url of its UTF-8 JSON. */
export function startUrl(next: string, payload: Record<string, unknown>): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(payload)))
    binary += String.fromCharCode(byte);
  const data = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `/auth/social/google/start?${new URLSearchParams({ next, data })}`;
}
