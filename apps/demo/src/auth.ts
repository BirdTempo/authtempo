import { createD1Adapter, createD1Limiter } from "@authtempo/adapter-d1";
import { type Auth, type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import type { Mailbox } from "./mailbox.js";
import { demoProvider, demoProviderFetch } from "./provider.js";

/** The header that carries the visitor IP from the Worker to the sandbox. */
export const CLIENT_IP_HEADER = "x-demo-client-ip";

/** What the config of one sandbox reads: its origin, its secret, its store, and its mailbox. */
export interface DemoInput {
  origin: string;
  secret: string;
  db: D1Database;
  mailbox: Mailbox;
}

/** The auth of one sandbox: each method of the demo, on the store of the sandbox. */
export function demoAuth(input: DemoInput): Auth {
  return createAuth(demoConfig(input));
}

/**
 * The auth config of one sandbox. test/off.test.ts reads it: each config path
 * of DEMO_OFF in src/facts.ts stays unset, so the /demo/ page stays true.
 */
export function demoConfig(input: DemoInput): AuthConfig {
  const { origin, secret, db, mailbox } = input;
  return {
    baseURL: origin,
    basePath: "/auth",
    appName: "authtempo demo",
    secret,
    trustedOrigins: [origin],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    // The Worker deletes any incoming x-demo-client-ip and sets it from
    // cf-connecting-ip; only the Worker reaches this object. Core's per-IP
    // limits then count the real visitor.
    clientIp: (r) => r.headers.get(CLIENT_IP_HEADER),
    mail: mailbox,
    social: { oauth2: [demoProvider(origin)], fetch: demoProviderFetch(origin, db) },
    passkey: { rpID: new URL(origin).hostname, rpName: "authtempo demo", origins: [origin] },
    // Decision 4 of 2026-10-14: 1000 iterations so the demo runs on Workers
    // Free. A real deployment keeps the default of 100000 and needs Workers
    // Paid. Each password form says so.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    organizations: {},
    emailOtp: {},
    totp: {},
    jwtMint: false,
    oauth: false,
  };
}
