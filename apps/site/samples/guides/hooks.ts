import { createAuth, hookRefusal, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The app's audit trail. A real app writes its own table. */
export const auditLog: string[] = [];

export function createHooksAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    organizations: {},
    hooks: {
      organization: {
        // A before hook runs inside the flow's transaction, after core's own checks.
        async beforeCreate({ organization }) {
          if (organization.slug.startsWith("acme-")) throw hookRefusal("Choose another name.");
        },
        // An after hook runs after the commit. A throw here is logged, never answered.
        async afterAddMember({ organization, member, via }) {
          auditLog.push(`member.added ${organization.id} ${member.userId} ${via}`);
        },
      },
      session: {
        // Store no IP and no user agent with the session.
        beforeCreate: () => ({ ip: null, userAgent: null }),
        async afterEnd({ session, reason }) {
          auditLog.push(`session.ended ${session.id} ${reason}`);
        },
      },
    },
  });
}
