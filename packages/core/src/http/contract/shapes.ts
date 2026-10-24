import { z } from "zod";
import { LAST_METHODS } from "../../engine/last-method.js";
import { PASSKEY_HINTS } from "../../primitives/passkey-hints.js";
import { PROVIDER_NAME_RE } from "../../social/provider.js";

/**
 * The answer shapes that two or more routes share (plan 11g). Each one is
 * strict, so the answer recorder of the test run sees an extra key. A date
 * is an ISO string on the wire. A nullable field is `.nullable()`; an absent
 * field is `.optional()`.
 */

/** The public user, as `publicUser` of the engine answers it. */
export const UserJson = z.strictObject({
  id: z.string(),
  /** Null for a user with no address (plan 12i). */
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

/**
 * The public session row of `publicSession`. Never the hash. `actorId` is
 * the operator's user id of an impersonation session, else null (plan 12f).
 */
export const SessionJson = z.strictObject({
  id: z.string(),
  expiresAt: z.iso.datetime(),
  activeOrganizationId: z.string().nullable(),
  actorId: z.string().nullable(),
  /** A team of the active organization (plan 12k). */
  activeTeamId: z.string().nullable(),
});

/**
 * The JSON of `publicSession`: the refresh, the verify routes, the passkey
 * sign-in, and the active organization. No other key: only `GET /session`
 * adds one (`SessionReadAnswer`).
 */
export const SessionAnswer = z.strictObject({ user: UserJson, session: SessionJson });

/**
 * The answer of `GET /session` alone: the session, and `needsRefresh` with
 * `session.deferRefresh` on (plan 12a). A client reads it to call the refresh.
 */
export const SessionReadAnswer = z.strictObject({
  user: UserJson,
  session: SessionJson,
  needsRefresh: z.boolean().optional(),
});

/**
 * The last method of a sign-in (plan 12i Task 12): one value of the closed
 * set, or `social:<provider>`. A sign-in answer carries it as `via` while
 * `lastMethod` is on.
 */
export const LastMethodJson = z.union([
  z.enum(LAST_METHODS),
  z.templateLiteral(["social:", z.string().regex(PROVIDER_NAME_RE)]),
]);

/** The JSON of `signedInResponse`: the session with its bearer token. A reset and the handoff answer it. */
export const SignedInAnswer = z.strictObject({
  token: z.string(),
  user: UserJson,
  session: SessionJson,
});

/** The JSON of `signedInResponse` at a sign-in: `via` too, while `lastMethod` is on (plan 12i). */
export const SignInAnswer = z.strictObject({
  token: z.string(),
  user: UserJson,
  session: SessionJson,
  via: LastMethodJson.optional(),
});

/** The session of a sign-in with no token in the body: the passkey and the magic link (plan 12i: `via`). */
export const SessionSignInAnswer = z.strictObject({
  user: UserJson,
  session: SessionJson,
  via: LastMethodJson.optional(),
});

/**
 * A challenge in place of a session, for a user with the second factor on
 * (plan 12c). The password sign-in, the reset, the magic link, the email
 * code, and social answer it.
 */
export const TwoFactorChallenge = z.strictObject({
  twoFactor: z.strictObject({
    challenge: z.string(),
    expiresAt: z.iso.datetime(),
    methods: z.array(z.enum(["passkey", "totp", "email", "backup"])),
  }),
});

/** `{ ok: true }`: the answer of a change that returns nothing else. */
export const OkAnswer = z.strictObject({ ok: z.literal(true) });

/** `{ sent: true }`: the uniform answer of a request that mails, for every address. */
export const SentAnswer = z.strictObject({ sent: z.literal(true) });

/** One passkey of the user, as the engine's `summary` answers it. Never the public key. */
export const PasskeySummary = z.strictObject({
  id: z.string(),
  credentialId: z.string(),
  name: z.string().nullable(),
  deviceType: z.string(),
  backedUp: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** One credential of a WebAuthn options answer, in its JSON form. */
const CredentialDescriptorJson = z.strictObject({
  id: z.string(),
  type: z.literal("public-key"),
  transports: z.array(z.string()).optional(),
});

const USER_VERIFICATION = ["required", "preferred", "discouraged"] as const;

/**
 * `PublicKeyCredentialCreationOptionsJSON` of WebAuthn Level 3: the answer of
 * the passkey registration options. The browser passes it to
 * `PublicKeyCredential.parseCreationOptionsFromJSON`.
 */
export const CreationOptionsJson = z.strictObject({
  rp: z.strictObject({ id: z.string().optional(), name: z.string() }),
  user: z.strictObject({ id: z.string(), name: z.string(), displayName: z.string() }),
  challenge: z.string(),
  pubKeyCredParams: z.array(
    z.strictObject({ alg: z.number().int(), type: z.literal("public-key") }),
  ),
  timeout: z.number().int().optional(),
  excludeCredentials: z.array(CredentialDescriptorJson).optional(),
  authenticatorSelection: z
    .strictObject({
      authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
      requireResidentKey: z.boolean().optional(),
      residentKey: z.enum(USER_VERIFICATION).optional(),
      userVerification: z.enum(USER_VERIFICATION).optional(),
    })
    .optional(),
  hints: z.array(z.enum(PASSKEY_HINTS)).optional(),
  attestation: z.enum(["none", "indirect", "direct", "enterprise"]).optional(),
  attestationFormats: z.array(z.string()).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

/**
 * `PublicKeyCredentialRequestOptionsJSON` of WebAuthn Level 3: the answer of
 * each authentication options route (the passkey sign-in, the second factor,
 * and the re-authentication).
 */
export const RequestOptionsJson = z.strictObject({
  challenge: z.string(),
  timeout: z.number().int().optional(),
  rpId: z.string().optional(),
  allowCredentials: z.array(CredentialDescriptorJson).optional(),
  userVerification: z.enum(USER_VERIFICATION).optional(),
  hints: z.array(z.enum(PASSKEY_HINTS)).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
