import { createAccessControl, defaultStatements } from "../../../src/access.js";
import { apiKey } from "../../../src/api-key.js";
import { organization } from "../../../src/plugins.js";
import { betterAuthSchemaStorage, type D1DatabaseLike } from "../../../src/storage/index.js";
import type { ApiKeyOptions, BetterAuthOptions } from "../../../src/types.js";

// The auth module of a D1 app, as the key move Worker of the README reads it.

export const ac = createAccessControl({ ...defaultStatements, project: ["read", "write"] });

/** The options of the app's apiKey plugin. */
export const keys: ApiKeyOptions = {
  defaultPrefix: "laaa_",
  references: "user",
  rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
};

/** The app's betterAuth options on its D1 binding. */
export function authOptions(env: { DB: D1DatabaseLike }): BetterAuthOptions {
  return {
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    database: betterAuthSchemaStorage({ dialect: "d1", db: env.DB }),
    plugins: [organization({ ac, sendInvitationEmail: async () => {} }), apiKey(keys)],
    authtempo: { movedKeyPrefixes: ["ci_"] },
  };
}
