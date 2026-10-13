import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createOrganizationsAuth(deps: {
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
    organizations: {
      // The default rank table, written out: viewer < member < admin < owner.
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4 },
      // The life of an invitation in days. The default is 7.
      invitationTtlDays: 7,
      // The link in the invitation mail. The default is <appURL>/?invitation=<token>.
      invitationLinkBuilder: (token) =>
        `https://app.example.com/join?invitation=${encodeURIComponent(token)}`,
      // Counts that core keeps. Each is off by default.
      limits: { perUser: 5, membersPerOrganization: 50, pendingInvitationsPerOrganization: 20 },
    },
  });
}
