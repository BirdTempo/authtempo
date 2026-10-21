import type { SweepResult } from "./sweep.js";

/**
 * Every count of a `SweepResult`. A Record, so a count added to the
 * interface and not listed here fails the compile. The `sweep` event takes
 * one field for each key (plan 12h Task 6). The file imports types only, so
 * the event table reads it with no import cycle.
 */
export const SWEEP_KEYS: Readonly<Record<keyof SweepResult, true>> = {
  verificationExpired: true,
  verificationConsumed: true,
  invitations: true,
  sessions: true,
  pendingSessions: true,
  apiTokens: true,
  organizationTokens: true,
  trustedDevices: true,
  jwks: true,
  oauthTokens: true,
  oauthClients: true,
  totpSetups: true,
  limits: true,
  oauthDevices: true,
  oauthSessionLinks: true,
  oauthLogouts: true,
  oauthClientSecrets: true,
};
