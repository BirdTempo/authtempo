import type { ResolvedConfig } from "../../config.js";
import { fail, type Result } from "../../result.js";
import type { SsoConnectionRow, UserRow } from "../../schema.js";
import type { SignInChallenge } from "../second-factor.js";

/**
 * The person that an IdP names after its checks (plan 12d Task 5). The OIDC
 * callback and the SAML ACS make it. It holds no `email_verified`: no word
 * of the IdP proves an address, only a verified domain of the organization.
 */
export interface SsoProfile {
  /** The IdP's id of the person: 1 to 255 characters, no control character. */
  subject: string;
  /** The address as the IdP gives it, or null. The resolution normalizes it. */
  email: string | null;
  name: string | null;
  image: string | null;
  /** The OIDC `amr` values, or `[]`. */
  amr: string[];
  /** The OIDC `acr` value, or null. */
  acr: string | null;
}

/** The answer of a sign-in that opens a session: the answer of `completeSocial`. */
export interface SsoSignedIn {
  token: string;
  next: string;
  user: UserRow;
}

/** The request facts that the resolution passes to the session and the gate. */
export interface SsoResolveInput {
  next: string;
  ip: string | null;
  userAgent: string | null;
  trustDevice?: string | undefined;
}

/**
 * The resolution of an SSO sign-in (spec 30 item 11). Task 5 of plan 12d
 * writes it in this function. Until then no SSO sign-in opens a session:
 * the answer is `sso_failed`, with the log step `resolve`.
 */
export async function resolveSsoUser(
  _config: ResolvedConfig,
  connection: SsoConnectionRow,
  _profile: SsoProfile,
  input: SsoResolveInput,
): Promise<Result<SsoSignedIn | SignInChallenge>> {
  console.error("authtempo: sso failed", connection.id, "resolve", input.ip);
  return fail("sso_failed");
}
