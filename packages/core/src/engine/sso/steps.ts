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

/**
 * A refusal of the setup flow (plan 13a Task 12). The event `sso.setup_refused` names one step. The
 * answer of each step is the same as for no credential, so the event is the only place that tells
 * the cause. The prefix names the act: `open`, `page`, `session`, `draft`, `test`.
 */
export type SetupRefusalStep =
  | "open_token_form"
  | "open_link_invalid"
  | "open_ip_limit"
  | "open_link_limit"
  | "open_lost"
  | "page_ip_limit"
  | "session_cookie"
  | "session_ended"
  | "session_link"
  | "draft_step"
  | "draft_limit"
  | "test_caller"
  | "test_limit";

const SETUP_REFUSAL_STEP: Readonly<Record<SetupRefusalStep, true>> = {
  open_token_form: true,
  open_link_invalid: true,
  open_ip_limit: true,
  open_link_limit: true,
  open_lost: true,
  page_ip_limit: true,
  session_cookie: true,
  session_ended: true,
  session_link: true,
  draft_step: true,
  draft_limit: true,
  test_caller: true,
  test_limit: true,
};

export const SETUP_REFUSAL_STEPS: readonly string[] = Object.keys(SETUP_REFUSAL_STEP);

/** The claim of a profile that passed the second factor of a connection (spec 30 item 13). */
export type SsoMfaClaim = "amr" | "acr" | "authnContext";

const MFA_CLAIM: Readonly<Record<SsoMfaClaim, true>> = { amr: true, acr: true, authnContext: true };

export const SSO_MFA_CLAIMS: readonly string[] = Object.keys(MFA_CLAIM);
