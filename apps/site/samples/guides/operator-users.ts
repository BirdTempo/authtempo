import {
  type Auth,
  createAuth,
  type LimiterPort,
  type MailPort,
  type SmsPort,
  type StorageAdapter,
} from "@authtempo/core";
import { inviteMail } from "./operator-invite.ts";

/** A placeholder port that sends nothing. Write the port of your SMS supplier. */
const NO_SMS: SmsPort = { send: async () => "unavailable" };

/**
 * An app whose self sign-up is closed. The support desk creates each account.
 * Pass the limiter of your D1, Postgres, or MySQL adapter: the phone config
 * needs a shared limiter. Only a test passes "isolate-for-tests".
 */
export function createOperatorUsersAuth(
  deps: {
    storage: StorageAdapter;
    mail: MailPort;
    secret: string;
    limiter: LimiterPort | "isolate-for-tests";
  },
  sms: SmsPort = NO_SMS,
) {
  const forTests = deps.limiter === "isolate-for-tests";
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    ...(deps.limiter === "isolate-for-tests" ? {} : { limiter: deps.limiter }),
    // No stranger makes an account. The operator create does not read this rule.
    signUp: false,
    // The first sign-in "reset" needs the password config.
    password: {},
    // A user with a phone number only signs in with a phone code.
    phone: {
      sms,
      regions: ["+44"],
      signUp: false,
      ...(forTests ? { isolateLimiter: "allow" as const } : {}),
    },
    // The gate of the invitation, totp.gate.invite, is on by default.
    totp: { issuer: "Example" },
    // A platform operator is a user with the role `admin` in the organization `staff`.
    organizations: { platformOrganization: "staff", platformRole: "admin" },
    // The invitation mail in the words of the app (operator-invite.ts).
    account: { mail: inviteMail },
    operator: {
      users: true,
      // The life of an invitation link: 1 to 168 hours. The default is 72.
      invite: { ttlHours: 24 },
    },
  });
}

/**
 * The actor of the support desk. Core trusts an app actor, so the app checks
 * its own staff and counts its own limit before each call.
 */
export const SUPPORT_DESK = { kind: "app", name: "support-desk" } as const;

/** A ticket that asks for an account. Give an address, or a phone number only. */
export interface AccountRequest {
  ticket: string;
  email: string | null;
  phone?: string;
  name?: string;
  /** "invite" by default with an address. A phone number only allows "none". */
  firstSignIn?: "invite" | "reset" | "none";
}

/** Creates the account of a ticket. The answer holds no token and no link. */
export async function createForPerson(auth: Auth, request: AccountRequest) {
  const created = await auth.api.operator.users.create({
    actor: SUPPORT_DESK,
    email: request.email,
    ...(request.phone !== undefined && { phone: request.phone }),
    ...(request.name !== undefined && { name: request.name }),
    ...(request.firstSignIn !== undefined && { firstSignIn: request.firstSignIn }),
    // The audit row keeps the reason after the account is gone: put your case id here.
    reason: `ticket ${request.ticket}`,
    // The staff member's address and browser, never the person's.
    ip: null,
    userAgent: null,
  });
  if (!created.ok) return { error: created.code };
  // mailed is "invite", "reset", or null: what the person got.
  return { userId: created.value.userId, mailed: created.value.mailed };
}
