import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/**
 * Teams inside each organization. A team has no role of its own: every right
 * comes from the organization role. The two limits are counts that core keeps.
 */
export function createTeamsAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    organizations: {
      teams: {
        // The create of an organization also creates one team with the creator in it.
        defaultTeam: true,
        // The delete of the last team answers last_team.
        keepLastTeam: true,
      },
      limits: { teamsPerOrganization: 20, membersPerTeam: 100 },
    },
  });
}
