import { betterAuth, type CompatDatabase } from "@authtempo/compat-better-auth";

/**
 * A Better Auth 1.7 server on authtempo. In the app this file imports
 * `better-auth`, and the package alias answers it with
 * `@authtempo/compat-better-auth`. The options are Better Auth's own.
 */
export function betterAuthServer(options: {
  /** `betterAuthSchemaStorage({ dialect: "postgres", sql })` or `drizzleAdapter(db, { provider, schema })`. */
  database: CompatDatabase;
  secret: string;
  sendMail(to: string, subject: string, url: string): Promise<void>;
}) {
  return betterAuth({
    baseURL: "https://api.example.com",
    secret: options.secret,
    database: options.database,
    emailAndPassword: {
      enabled: true,
      // Required: core mails a reset link, and the factory refuses a config without this callback.
      sendResetPassword: async ({ user, url }) =>
        options.sendMail(user.email, "Reset your password", url),
    },
    emailVerification: {
      // Required: core mails a verify link at every sign-up.
      sendVerificationEmail: async ({ user, url }) =>
        options.sendMail(user.email, "Verify your address", url),
    },
  });
}
