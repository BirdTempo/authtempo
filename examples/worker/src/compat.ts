import {
  type BetterAuthInstance,
  betterAuth,
  betterAuthPasswordHash,
  betterAuthSchemaStorage,
} from "@authtempo/compat-better-auth";
import { bearer, expo, organization } from "@authtempo/compat-better-auth/plugins";
import { createPbkdf2PasswordHash } from "@authtempo/core";

let compat: BetterAuthInstance | null = null;
// Keyed by the address, so a test reads only its own mail, whatever ran before it.
const lastLinks = new Map<string, string>();

/** The last URL a compat send callback received for this address, for the test. The example has no mail transport. */
export function compatLastLink(to: string): string | null {
  return lastLinks.get(to.toLowerCase()) ?? null;
}

/**
 * The Better Auth compatibility instance (plan 9), built once per isolate:
 * consumere's and consumer-i's option shapes, minus the options the
 * refusal list names, on Better Auth's tables in BA_DB.
 */
export function getCompat(env: Env): BetterAuthInstance {
  if (compat) return compat;
  const record = async (data: { user: { email: string }; url: string }) => {
    lastLinks.set(data.user.email.toLowerCase(), data.url);
  };
  compat = betterAuth({
    baseURL: env.BASE_URL,
    basePath: "/api/auth",
    secret: env.AUTH_SECRET,
    appName: "authtempo compat example",
    trustedOrigins: [env.BASE_URL, "reception://"],
    database: betterAuthSchemaStorage({ dialect: "d1", db: env.BA_DB }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, sendResetPassword: record },
    emailVerification: {
      sendVerificationEmail: record,
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
    },
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          socialProviders: {
            google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
          },
        }
      : {}),
    plugins: [
      bearer(),
      expo(),
      organization({
        // data.id is the invitation token: the app builds its accept link from it.
        sendInvitationEmail: async (data) => {
          lastLinks.set(data.email.toLowerCase(), `invitation:${data.id}`);
        },
      }),
    ],
    // As for core's instance: 1000 iterations in TEST_MODE only. Production keeps the default cost.
    ...(env.TEST_MODE === "1"
      ? {
          authtempo: {
            passwordHash: betterAuthPasswordHash({
              pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
            }),
          },
        }
      : {}),
  });
  return compat;
}
