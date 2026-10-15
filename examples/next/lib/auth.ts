import {
  type Auth,
  createAuth,
  createMemoryAdapter,
  type MailMessage,
  type MailPort,
} from "@authtempo/core";

/**
 * Your mail transport. Core calls `send` once per mail. Replace the body with
 * a call to your mail provider. Until then a sign-in request answers 500.
 */
export const mail: MailPort = {
  async send(m) {
    if (PROOF) {
      shared.__myAppProofMail = m;
      return;
    }
    throw new Error("my-app: no mail transport; replace mail.send in lib/auth.ts");
  },
};

/**
 * The proof of this example (proof/next-start.mjs) sets AUTHTEMPO_PROOF_MAIL=1
 * and reads the last mail through app/proof/mail. Never set it in a deploy:
 * the route then answers a sign-in link to anyone. Delete both when you copy
 * the example.
 */
const PROOF = process.env.AUTHTEMPO_PROOF_MAIL === "1";

/**
 * Next bundles each route handler and each page on its own, so each bundle can
 * hold its own copy of this module. The one auth instance (and its memory
 * storage) and the proof mail live on globalThis, so every bundle of the
 * process shares them. A D1 or Postgres adapter shares its rows anyway.
 */
const shared = globalThis as typeof globalThis & {
  __myAppAuth?: Auth;
  __myAppProofMail?: MailMessage;
};

/** The last mail, for the proof only. Null when the proof mail is off. */
export function proofMail(): MailMessage | null {
  return PROOF ? (shared.__myAppProofMail ?? null) : null;
}

/** True only under the proof. */
export function proofMailOn(): boolean {
  return PROOF;
}

/**
 * The auth instance of this app. Warning: the memory adapter keeps rows in
 * this process only, and they go at a restart. Use the D1 or the Postgres
 * adapter in production (the getting started tutorials show both).
 */
export function createAppAuth(input: { baseURL: string; secret: string; mail: MailPort }): Auth {
  return createAuth({
    baseURL: input.baseURL,
    secret: input.secret,
    trustedOrigins: [input.baseURL],
    storage: createMemoryAdapter(),
    mail: input.mail,
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`my-app: set ${name}`);
  return value;
}

/** The app's one auth instance, made at the first request from BASE_URL and AUTH_SECRET. A build reads neither. */
export function getAuth(): Auth {
  shared.__myAppAuth ??= createAppAuth({
    baseURL: required("BASE_URL"),
    secret: required("AUTH_SECRET"),
    mail,
  });
  return shared.__myAppAuth;
}
