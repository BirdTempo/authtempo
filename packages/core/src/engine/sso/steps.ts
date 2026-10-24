import type { SamlStep } from "../../saml/assertion.js";

/**
 * The step names of the SSO fault events (plan 12h, spec 31 item 6). Each
 * list is a Record, so a step added to its union and not listed here fails
 * the compile. The file imports types only, so the event table reads it
 * with no import cycle.
 */

/** A refused step of the OIDC start or callback. */
export type OidcStep =
  | "discovery"
  | "discovery_host"
  | "secret"
  | "state"
  | "state_connection"
  | "binding"
  | "code"
  | "exchange"
  | "id_token"
  | "nonce"
  | "subject";

const OIDC_STEP: Readonly<Record<OidcStep, true>> = {
  discovery: true,
  discovery_host: true,
  secret: true,
  state: true,
  state_connection: true,
  binding: true,
  code: true,
  exchange: true,
  id_token: true,
  nonce: true,
  subject: true,
};

const SAML_STEP: Readonly<Record<SamlStep, true>> = {
  form: true,
  request: true,
  parse: true,
  wrapping: true,
  signature_shape: true,
  algorithm: true,
  reference: true,
  digest: true,
  signature: true,
  status: true,
  destination: true,
  issuer: true,
  conditions: true,
  audience: true,
  subject_confirmation: true,
  authn_statement: true,
  request_spent: true,
  replay: true,
  subject: true,
  address: true,
};

/** The steps of `sso.failed`: the OIDC steps and the SAML steps, each once. */
export const SSO_FAILED_STEPS: readonly string[] = [
  ...new Set([...Object.keys(OIDC_STEP), ...Object.keys(SAML_STEP)]),
];

/** A refusal of the SSO manager guard. */
export type SsoGuardStep = "impersonation" | "rank" | "email" | "second_factor" | "fresh";

const GUARD_STEP: Readonly<Record<SsoGuardStep, true>> = {
  impersonation: true,
  rank: true,
  email: true,
  second_factor: true,
  fresh: true,
};

export const SSO_GUARD_STEPS: readonly string[] = Object.keys(GUARD_STEP);

/** The claim of a profile that passed the second factor of a connection (spec 30 item 13). */
export type SsoMfaClaim = "amr" | "acr" | "authnContext";

const MFA_CLAIM: Readonly<Record<SsoMfaClaim, true>> = { amr: true, acr: true, authnContext: true };

export const SSO_MFA_CLAIMS: readonly string[] = Object.keys(MFA_CLAIM);
