export const SCHEMA_VERSION = 16;

export interface BaseRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRow extends BaseRow {
  /**
   * The address, in the form of `normalizeEmail`. Null from schema version 15
   * (plan 12i): an account can have no address. A read takes the guard
   * `hasAddress` (`engine/address.ts`), never an assertion.
   */
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  /** When an operator banned the user (plan 12f). Null: no ban. */
  bannedAt: Date | null;
  /** The operator's reason for the ban. Null when no ban holds. */
  banReason: string | null;
  /** The end of the ban. Null with `bannedAt` set: the ban has no end. */
  banUntil: Date | null;
  /** The stored username (plan 12i): NFKC, then lower case. Unique; null for none. */
  username: string | null;
  /** The username in the case that the person typed (plan 12i). */
  displayUsername: string | null;
  /**
   * The phone number in E.164 (plan 12i). Unique. A stored phone is not
   * always a proved phone: a Better Auth store can hold one that no code
   * proved. It counts as a way in only with `config.phone` (`phoneSignsIn`).
   */
  phone: string | null;
  /** True for an anonymous account (plan 12i). A sign-in replaces it. */
  isAnonymous: boolean;
}

export interface IdentityRow extends BaseRow {
  userId: string;
  provider: string;
  subject: string;
  linkedAt: Date;
}

export interface SessionRow extends BaseRow {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  userAgent: string | null;
  activeOrganizationId: string | null;
  /**
   * When a sign-in or a re-authentication last proved the person (plan 12a,
   * spec 8.15). A sensitive change needs it within `session.freshMinutes`.
   * Null is never fresh: a row of schema version 9 or older holds null.
   */
  freshAt: Date | null;
  /**
   * The id of the platform operator who impersonates the user (plan 12f).
   * Null on every other session.
   */
  actorId: string | null;
  /** The team the session acts in, of its active organization (plan 12k). Null: none. */
  activeTeamId: string | null;
  /**
   * True when the sign-in that made the session proved the account (plan
   * 12p). The engine sets it once, at the creation, and a hook cannot set
   * it. Only the confirm of a change of address changes it later, to true
   * on the session it keeps. A verified-only action reads it with the user
   * row. So a session made before the proof of its address never gains
   * verified powers. Migration 0016 fills a row of version 15 from its
   * user: true for a verified user with an address, else false.
   */
  proved: boolean;
}

export type VerificationPurpose =
  | "magic-link"
  | "oauth-state"
  /**
   * The state of a link (plan 12a). identifier: the provider name; data:
   * the data of `oauth-state` and `link: { userId, sessionId }`. Its own
   * purpose, so a link state never signs in and a sign-in state never links.
   */
  | "oauth-link-state"
  | "handoff-code"
  | "passkey-challenge"
  /** data: { passwordId: string } */
  | "password-verify"
  /** data: { next: string } */
  | "password-reset"
  /** data: { attempts: number }. valueHash is HMAC-SHA256(secret, `<id>:<code>`) in hex (plan 9e). */
  | "email-otp"
  /** As `email-otp`, for a password reset by code (plan 9e). */
  | "password-reset-otp"
  /**
   * A second-factor challenge (plan 9f). identifier: the user id; valueHash:
   * the SHA-256 hex of the `tf_` token; data: { via, ip, userAgent, next, attempts }.
   */
  | "two-factor"
  /**
   * An OAuth authorization code (plan 9g). identifier: the user id (plan 9g
   * final fix wave, round 2: a reset deletes the user's codes by it);
   * valueHash: the SHA-256 hex of the `oc_` code; data: { clientId,
   * redirectUri, codeChallenge, scopes, resource, userId, nonce, sessionId }.
   */
  | "oauth-code"
  /**
   * A held authorize request (plan 9h). identifier: the client id;
   * valueHash: the SHA-256 hex of the `oq_` id; data: { params, userId }.
   * Lives 10 minutes; spent at the decision, the code, or another final answer.
   */
  | "oauth-request"
  /**
   * A spent client assertion of `private_key_jwt` (plan 12e, RFC 7523).
   * identifier: the client id; valueHash: the SHA-256 hex of
   * `client-assertion:<clientId>:<jti>` (`replayHash`); data: null. Lives
   * to the ceiling of the assertion's `exp` plus 31 seconds. The unique key
   * on `valueHash` refuses a replay on every adapter.
   */
  | "client-assertion"
  /**
   * A spent DPoP proof (plan 12e, RFC 9449 section 11.1). identifier: the JWK
   * thumbprint; valueHash: the SHA-256 hex of `dpop-proof:<thumbprint>:<jti>`
   * (`replayHash`); data: null. Lives to the ceiling of the proof's `iat`
   * plus twice `oauth.dpop.windowSeconds`.
   */
  | "dpop-proof"
  /**
   * The end mark of a refresh family (ruling 40 of plan 12e). identifier:
   * the family id; valueHash: the SHA-256 hex of `oauth-family-end:<familyId>`;
   * data: null. A reuse or a revoke writes it before it deletes the family,
   * and a new refresh row reads it after its write. Lives `refreshTtlDays`.
   */
  | "oauth-family-end"
  /**
   * A re-authentication code (plan 12a), as `email-otp`: identifier the
   * address, data { attempts }, valueHash the keyed hash of `<id>:<code>`.
   */
  | "reauth-otp"
  /**
   * A change-of-address link (plan 12a). identifier: the user id, so one
   * user has one live request; valueHash: the SHA-256 hex of the `ec_`
   * token; data: { newEmail, oldEmail, sessionId, next, attempts }.
   */
  | "email-change"
  /**
   * A change-of-address code (plan 12a). identifier: the user id; data:
   * `email-change`'s data; the code rules of `email-otp`.
   */
  | "email-change-otp"
  /**
   * The mailed confirm of an account delete (plan 12a Task 20). identifier:
   * the user id, so one user has one live link; valueHash: the SHA-256 hex
   * of the `ad_` token; data: null.
   */
  | "account-delete"
  /**
   * The invitation link of a created user (plan 12f2 Task 3). identifier:
   * the user id, so the account delete takes it; valueHash: the SHA-256 hex
   * of the `ui_` token; data: { email }, the address at the create. The
   * confirm refuses the row when the user's address is not that address.
   */
  | "user-invite"
  /**
   * The sessions that an act left for the sweep (rulings 44 and 63 of plan
   * 12f). Four acts write it: a ban, a revoke of the platform role, an
   * account delete, and a role loss. A role loss is a removal, a leave, or a
   * role change of the platform member row. The identifier is the user id,
   * and the valueHash is the SHA-256 hex of `session-end:<id>`. The data is
   * { reason, before } or { reason, before, targets }. A row with no
   * `targets` names the user's own sessions: only a ban or a revoke writes
   * one. A row with `targets` names the impersonation sessions that the user
   * opened on those users as an operator. The row lives 3650 days. The sweep
   * deletes it when no session from before `before` stays. A row of a SCIM
   * deactivate (reason `revoked`) becomes a `session-end-record` instead.
   */
  | "session-end"
  /**
   * The record of a SCIM deactivate (ruling 56 of plan 12d): a
   * `session-end` row of reason `revoked` after the sweep ended its work.
   * The data is { reason, before }. The session door and the refresh grant
   * read it, so a session or an OAuth family that started at or before
   * `before` stays refused. The expiresAt is `before` plus `recordLife`,
   * and the sweep deletes the row then. One act writes at most one row per
   * user.
   */
  | "session-end-record"
  /**
   * The rows of the solo organizations of an account delete that wait for
   * the sweep (ruling 78 of plan 12d). The act deleted the organization,
   * connection, domain, SCIM token, and member rows. The identifier is the
   * first organization id, and the valueHash is the SHA-256 hex of
   * `organization-rest:<id>`. The data is { organizations }, the ids. The
   * row lives 3650 days. The sweep deletes the rest of the rows of those
   * organizations, and then the row.
   */
  | "organization-rest"
  /**
   * One SAML AuthnRequest that core sent (plan 12d). The ACS spends it
   * once, so one Response opens at most one session.
   */
  | "saml-request"
  /**
   * The ID of one SAML assertion that the ACS took (plan 12d, SAML
   * Profiles 4.1.4.5). valueHash is unique, so a replay of the assertion
   * fails while the row lives.
   */
  | "saml-assertion"
  /**
   * The latest expiry of one session: a SAML `SessionNotOnOrAfter` (ruling
   * 38 Q1 of plan 12d). The session create writes it in its own handle.
   * The sliding refresh reads it, so a refresh never moves `expiresAt` past
   * the cap. The identifier is the user id. The valueHash is the SHA-256
   * hex of `session-cap:<sessionId>`. The expiresAt is the cap, and the data
   * is null. The session ends at the cap, so the sweep deletes the row with it.
   */
  | "session-cap"
  /**
   * A phone sign-in code (plan 12i). The identifier is the number in E.164.
   * The valueHash is HMAC-SHA256 under the current secret version of
   * `<row id>:<code>`, in hex. The data is { attempts }.
   */
  | "phone-otp"
  /**
   * A code that adds a phone to an account (plan 12i). The identifier is the
   * user id. The data is { phone, attempts }, and the hash is as for `phone-otp`.
   */
  | "phone-add-otp"
  /**
   * A nonce for an ID-token sign-in (plan 12i). The identifier is the
   * provider name. The valueHash is the SHA-256 hex of the nonce.
   */
  | "id-token-nonce"
  /**
   * A spent ID token (plan 12i). The identifier is the provider name. The
   * valueHash is the SHA-256 hex of `id-token-used:<provider>:<payload>`,
   * with the payload part of the token in the canonical base64url. A hash
   * of the token text would miss a copy with other spare bits (Task 10).
   * The row lives until the token's `exp`, so a replay fails while the
   * token is valid.
   */
  | "id-token-used"
  /**
   * The address proof at sign-up by an email code (plan 12i). The
   * identifier is the normalized address. The data is { passwordId,
   * attempts, anonymousUserId }, and the hash is as for `email-otp`.
   */
  | "password-verify-otp";

export interface VerificationRow extends BaseRow {
  purpose: VerificationPurpose;
  identifier: string;
  valueHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  data: Record<string, unknown> | null;
  /**
   * The version of the app secret that keys this row's code (plan 12b, spec
   * 22): an `email-otp` or `password-reset-otp` row, and a `two-factor` row
   * whose `data` holds `emailCodeHash`. Every other purpose holds an unkeyed
   * SHA-256, and its version means nothing. Migration 0009 writes 1 into
   * every row of today.
   */
  secretVersion: number;
}

export interface PasskeyRow extends BaseRow {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  deviceType: string;
  backedUp: boolean;
  name: string | null;
  /**
   * The `credProps.rk` output of the registration (plan 12i): true for a
   * discoverable credential. Null when the browser did not answer it. The
   * three flags are advice of the client and decide nothing.
   */
  discoverable: boolean | null;
  /** True when the authenticator said that it supports the PRF extension (plan 12i). */
  prf: boolean;
  /** True when the authenticator said that it supports the `largeBlob` extension (plan 12i). */
  largeBlob: boolean;
}

export interface OrganizationRow extends BaseRow {
  /** NFKC-normalized, lowercase, unique. */
  slug: string;
  name: string;
  metadata: Record<string, unknown> | null;
}

export interface MemberRow extends BaseRow {
  organizationId: string;
  userId: string;
  /** One or more roles joined by comma. The rank is the highest part. */
  role: string;
}

export interface InvitationRow extends BaseRow {
  organizationId: string;
  email: string;
  role: string;
  inviterId: string;
  tokenHash: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  /** Team ids that an accept adds the person to. Null: none. */
  teamIds: string[] | null;
}

export interface PasswordRow extends BaseRow {
  userId: string;
  /** Names its algorithm and its cost, so a later hash seam can rehash. */
  hash: string;
}

export interface ApiTokenRow extends BaseRow {
  userId: string;
  /** 1 to 80 UTF-16 code units, no control character. */
  name: string;
  /** SHA-256 hex of the clear token. The clear token is never stored. */
  tokenHash: string;
  /** The 8 characters after `tk_`, so a list tells the tokens apart. */
  hint: string;
  /** Null: the token never expires. */
  expiresAt: Date | null;
  /** Written at most once per hour. */
  lastUsedAt: Date | null;
  /** The one organization the token acts in, or null. */
  organizationId: string | null;
  /** The statements the token may use (plan 12k). Null: the rights of its user. */
  permissions: Record<string, string[]> | null;
  /** The app's own data on the token. Core never reads it. */
  metadata: Record<string, unknown> | null;
  /** The length of the per-token window in seconds. Null: no window. */
  rateLimitSeconds: number | null;
  /** The calls that one window allows. Null: no window. */
  rateLimitMax: number | null;
  /** The calls that the quota still allows. Null: no quota. */
  remaining: number | null;
  /** The value that a refill sets `remaining` to. Null: no refill. */
  refillAmount: number | null;
  /** The seconds between two refills. Null: no refill. */
  refillSeconds: number | null;
  /** The time of the last refill. Null: no refill yet. */
  lastRefillAt: Date | null;
  /** The time of the retirement of the token. A retired token never acts. Null: live. */
  retiredAt: Date | null;
}

/** One row per user with a second factor (plan 9f). */
export interface TotpRow extends BaseRow {
  userId: string;
  /**
   * The 20-byte secret, sealed: base64url of the 12-byte IV and the
   * AES-256-GCM ciphertext, under HKDF-SHA256 of the app secret, with the
   * user id as additional data. The clear secret is never stored.
   */
  secret: string;
  /** Null while the setup is unconfirmed. */
  enabledAt: Date | null;
  /** The last accepted 30-second step. A code of this step or an earlier one never passes again. */
  lastStep: number;
  /** HMAC-SHA256 hex under the app secret of `<id>:<code>`, one per unused backup code. */
  backupCodes: string[];
  /**
   * The version of the app secret that seals or keys this row's value (plan
   * 12b, spec 22). Migration 0009 writes 1 into every row of today. A read
   * opens the value only under this version.
   */
  secretVersion: number;
}

/** A device that skips the second factor until `expiresAt` (plan 9f). */
export interface TrustedDeviceRow extends BaseRow {
  userId: string;
  /** SHA-256 hex of the `td_` token. The clear token is never stored. */
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

/** A second-factor method (plan 12c). The TOTP method keeps its secret in `totp`. */
export type SecondFactorMethod = "totp" | "passkey" | "email";

/**
 * The second factor of one user, apart from its methods (plan 12c). The row
 * exists only while at least one method is on: "the factor is on" is "the
 * row exists", and every gate reads this row.
 */
export interface SecondFactorRow extends BaseRow {
  userId: string;
  /** When the first method of this row went on. */
  enabledAt: Date;
  /** The methods that are on, in the order of their enable. Never empty. */
  methods: SecondFactorMethod[];
  /** HMAC-SHA256 hex under the app secret of `<id>:<code>`, one per unused backup code. */
  backupCodes: string[];
  /**
   * 1: a list of plan 9f (8 to 12 characters, about 40 to 60 bits), copied
   * by migration 0008. 2: codes of 23 to 32 characters, 112 bits or more
   * (ASVS 5.0 6.5.2). Core cannot rehash a code it never sees, so a list of
   * version 1 stays valid until it is spent or replaced.
   */
  backupCodesVersion: number;
  /**
   * The version of the app secret that seals or keys this row's value (plan
   * 12b, spec 22). Migration 0009 writes 1 into every row of today. A read
   * opens the value only under this version.
   */
  secretVersion: number;
}

/** A signing key of this instance (plan 9g). The id is the `kid`. */
export interface JwkRow extends BaseRow {
  /** The public JWK: kty, crv, x, (y), kid, alg, use. The algorithm is read from here. */
  publicJwk: Record<string, unknown>;
  /**
   * The PKCS#8 private key, sealed: base64url of the 12-byte IV and the
   * AES-256-GCM ciphertext under HKDF-SHA256 of the app secret (info
   * `tempo-auth jwk`), with the kid as additional data. Never the clear key.
   */
  privateKey: string;
  /** `"signing"` for the one key that signs; null once retired. The unique key keeps one signing key. */
  slot: string | null;
  /** Null while the key signs. A retired key verifies for 24 hours and signs nothing. */
  retiredAt: Date | null;
  /**
   * The version of the app secret that seals or keys this row's value (plan
   * 12b, spec 22). Migration 0009 writes 1 into every row of today. A read
   * opens the value only under this version.
   */
  secretVersion: number;
}

/** How a client proves itself at the token endpoint (plan 12e). `none` is a public client. */
export type ClientAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post"
  | "private_key_jwt";

/**
 * The state of one device grant (plan 12e, RFC 8628). `spent`: the poll
 * took the tokens, and a later poll answers `invalid_grant` (ruling 44).
 * The column is text with no SQL check, so the value needs no migration.
 */
export type DeviceStatus = "pending" | "approved" | "denied" | "spent";

/** An OAuth client (plan 9g). */
export interface OAuthClientRow extends BaseRow {
  /**
   * `registered`: a `cl_` id from `POST /oauth/register`. `api`: a `cl_` id
   * from `api.oauth.clients.create` (plan 12e); the idle sweep keeps it.
   * `cimd`: the id is the https URL of the client's metadata document.
   */
  kind: "registered" | "cimd" | "api";
  /** The client's own name: a claim of the client, not a fact. */
  name: string | null;
  redirectUris: string[];
  /** Moved at most once a day. The sweep deletes a client unseen for 90 days with no consent and no refresh token. */
  lastSeenAt: Date;
  /** The client's auth method at the token endpoint (plan 12e). A row of version 10 reads `none`. */
  authMethod: ClientAuthMethod;
  /** SHA-256 hex of the `cs_` secret (plan 12e). Null for a client with no secret. The clear secret is never stored. */
  secretHash: string | null;
  /** Always null in plan 12e: a secret does not expire (OIDC Registration 3.2, `client_secret_expires_at` 0). */
  secretExpiresAt: Date | null;
  /** SHA-256 hex of the secret before the last rotation (plan 12e). It is valid until `previousSecretUntil`. */
  previousSecretHash: string | null;
  /** The end of the overlap of the previous secret (plan 12e). Null when no rotation is in progress. */
  previousSecretUntil: Date | null;
  /** The client's public key set for `private_key_jwt` (plan 12e). Not together with `jwksUri`. */
  jwks: Record<string, unknown> | null;
  /** The https URL of the client's public key set for `private_key_jwt` (plan 12e). Not together with `jwks`. */
  jwksUri: string | null;
  /** The grants this client may use (plan 12e). A row of version 10 reads `authorization_code` and `refresh_token`. */
  grantTypes: string[];
  /** The scopes this client may ask on the `client_credentials` grant (plan 12e). */
  credentialsScopes: string[];
  /** True when this client may call the introspection endpoint (plan 12e, RFC 7662). */
  introspect: boolean;
  /** The exact URIs of an RP-initiated logout redirect (plan 12e). */
  postLogoutRedirectUris: string[];
  /** The URI that gets the back-channel logout token (plan 12e). Null: no back-channel logout. */
  backchannelLogoutUri: string | null;
  /** True when the logout token of this client must hold `sid` (plan 12e). */
  backchannelLogoutSessionRequired: boolean;
  /** `pairwise`: the `sub` of this client comes from `oauthSubject` (plan 12e, OIDC Core 8). */
  subjectType: "public" | "pairwise";
  /** True when every token of this client must be DPoP-bound (plan 12e, RFC 9449 section 10). */
  dpopBound: boolean;
}

/** The scopes one user allowed one client (plan 9g). A request for any other scope asks again. */
export interface OAuthConsentRow extends BaseRow {
  userId: string;
  clientId: string;
  scopes: string[];
}

/** One refresh token (plan 9g). A rotation spends the row and adds a row to the family. */
export interface OAuthTokenRow extends BaseRow {
  /** SHA-256 hex of the `or_` token. The clear token is never stored. */
  tokenHash: string;
  /** The first row's grant: every rotation of one authorization shares it. */
  familyId: string;
  userId: string;
  clientId: string;
  scopes: string[];
  /** The resource indicator (RFC 8707) of the grant: the `aud` of every access token it gives. */
  resource: string;
  expiresAt: Date;
  /** Set when the token was exchanged. A second exchange deletes the family. */
  usedAt: Date | null;
  /** The spent row that issued this one (plan 12e, the reuse window). Null for the first row of a family. */
  parentId: string | null;
  /** The JWK thumbprint of a public client's DPoP key (plan 12e, RFC 9449 section 5). Null: no binding. */
  dpopJkt: string | null;
}

/**
 * One device grant (plan 12e, RFC 8628). The table holds the hashes of the
 * device code and the user code, never the codes.
 */
export interface OAuthDeviceRow extends BaseRow {
  /** SHA-256 hex of the device code. */
  deviceCodeHash: string;
  /** The keyed hash of the user code under the secret of `secretVersion`. */
  userCodeHash: string;
  /** The version of the app secret that keys `userCodeHash` (spec 22). */
  secretVersion: number;
  clientId: string;
  scopes: string[];
  /** The resource indicator (RFC 8707) of the grant. */
  resource: string;
  status: DeviceStatus;
  /** The user that decided. Null while the grant is pending. */
  userId: string | null;
  /** The session of the decision. Null while the grant is pending. */
  sessionId: string | null;
  /** The poll interval in seconds. A poll that comes too early adds 5 (RFC 8628 section 3.5). */
  interval: number;
  lastPolledAt: Date | null;
  /** The JWK thumbprint of the DPoP key of the device request. Null: no binding. */
  dpopJkt: string | null;
  expiresAt: Date;
}

/** One pairwise subject (plan 12e, OIDC Core 8): a random subject per user and sector. */
export interface OAuthSubjectRow extends BaseRow {
  userId: string;
  /** The host of the client's redirect URI. */
  sector: string;
  subject: string;
}

/** One link of a session to a client that got tokens in it (plan 12e). The logout of the session reaches the client. */
export interface OAuthSessionClientRow extends BaseRow {
  sessionId: string;
  clientId: string;
  userId: string;
  /**
   * The `sid` that the ID tokens of this link carry (ruling 57 of plan 12e).
   * The logout token sends it back, so a new secret version never changes it.
   */
  sid: string;
  /**
   * The issuer of the ID tokens of this link: the entry of a `baseURL` list
   * where the client got them (plan 12i Task 18). The logout token names it.
   * Null for a link of a core before this field.
   */
  issuer: string | null;
}

/** One back-channel logout to deliver (plan 12e): the outbox. The sweep retries a failed delivery. */
export interface OAuthLogoutRow extends BaseRow {
  clientId: string;
  userId: string;
  sessionId: string;
  /** The `sid` of the link that this row replaced: the logout token carries it. */
  sid: string;
  attempts: number;
  nextAttemptAt: Date;
  /** The `issuer` of the link that this row replaced (plan 12i Task 18). Null: the primary. */
  issuer: string | null;
}

/** The acts that write an operator audit row (plan 12f, spec 26 item 8). */
export type OperatorAction =
  | "ban"
  | "unban"
  | "platform_role_grant"
  | "platform_role_revoke"
  | "second_factor_disable"
  | "sessions_end_user"
  | "sessions_end_all"
  | "impersonation_start"
  | "impersonation_stop"
  | "create_admin"
  | "user_create"
  | "user_update"
  | "user_delete"
  | (typeof SSO_AUDIT_ACTIONS)[number];

/** The audit actions of plan 12d (spec 30 item 22). 12f's `OperatorAction` is their union with its own. */
export const SSO_AUDIT_ACTIONS = [
  "sso_connection_create",
  "sso_connection_update",
  "sso_connection_delete",
  "sso_domain_add",
  "sso_domain_verify",
  "sso_domain_update",
  "sso_domain_delete",
  "sso_domain_lost",
  "sso_enforce_off",
  "scim_token_create",
  "scim_token_revoke",
  "scim_user_create",
  "scim_user_update",
  "scim_user_deactivate",
  "scim_user_delete",
  "scim_group_create",
  "scim_group_update",
  "scim_group_delete",
] as const;

/**
 * The actor kinds of an audit row (plan 12f; `scim` is plan 12d). The row
 * type and the audit contract read this one list.
 */
export const AUDIT_ACTOR_KINDS = ["secret", "user", "app", "scim"] as const;

/** One operator act (plan 12f). Append-only: core has no update and no delete of it. */
export interface OperatorAuditRow extends BaseRow {
  /** `scim`: a SCIM token of plan 12d, and `actorId` holds the token's name. */
  actorKind: (typeof AUDIT_ACTOR_KINDS)[number];
  /** The secret's name, the user id, or the app's name. Never the secret. */
  actorId: string;
  action: OperatorAction;
  /** Null for `sessions_end_all` only. Not `userId`, so the account delete keeps the row. */
  targetUserId: string | null;
  reason: string;
  data: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

/** A role that one organization stored (plan 12k). */
export interface OrganizationRoleRow extends BaseRow {
  organizationId: string;
  name: string;
  rank: number;
  /** Any JSON: a stored row can hold any value, so each read parses it. */
  permissions: unknown;
}

/** A named group of members of one organization (plan 12k). */
export interface TeamRow extends BaseRow {
  organizationId: string;
  name: string;
}

/** One member of one team (plan 12k). */
export interface TeamMemberRow extends BaseRow {
  teamId: string;
  organizationId: string;
  userId: string;
}

/** A token that an organization owns (plan 12k). */
export interface OrganizationTokenRow extends BaseRow {
  organizationId: string;
  /** The member who created the token. Not `userId`: the token outlives the person. */
  createdById: string;
  /** 1 to 80 UTF-16 code units, no control character. */
  name: string;
  /** SHA-256 hex of the clear token. The clear token is never stored. */
  tokenHash: string;
  /** The characters after the prefix, so a list tells the tokens apart. */
  hint: string;
  permissions: Record<string, string[]>;
  metadata: Record<string, unknown> | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  rateLimitSeconds: number | null;
  rateLimitMax: number | null;
  remaining: number | null;
  refillAmount: number | null;
  refillSeconds: number | null;
  lastRefillAt: Date | null;
  retiredAt: Date | null;
}

/**
 * One key of another system that a move wrote into a core token (plan 12k).
 * The move writes it in the transaction of the token, and a later run skips
 * each recorded key. So a revoke of a moved token stays a revoke.
 */
export interface MovedTokenRow extends BaseRow {
  /** The system and table of the key, such as `better-auth:apikey`. */
  source: string;
  /** The key's id in that table. */
  sourceId: string;
  /** The id of the core token that the key became. The row stays after a revoke of that token. */
  tokenId: string;
}

/** The second-factor values of an IdP that pass the gate of plan 12c (owner decision 3 of plan 12d). */
export interface SsoMfaList {
  amr?: string[];
  acr?: string[];
  authnContext?: string[];
}

/** One OIDC or SAML connection of one organization to its IdP (plan 12d). */
export interface SsoConnectionRow extends BaseRow {
  organizationId: string;
  kind: "oidc" | "saml";
  label: string;
  enabled: boolean;
  /** True: the first sign-in of a person with no member row adds one. */
  jit: boolean;
  defaultRole: string;
  /** The issuer, the endpoints, or the IdP metadata, by kind. Never a secret. */
  config: Record<string, unknown>;
  /** The OIDC client secret, sealed with the keyring. Never the clear secret. */
  clientSecret: string | null;
  /** The keyring version that seals `clientSecret` (plan 12b, spec 22). */
  secretVersion: number;
  mfa: SsoMfaList | null;
  /** The SCIM group name to role map (design 9.4). Null: no map. */
  scimRoles: Record<string, string> | null;
}

/** One email domain that one organization claims by a DNS proof (plan 12d). */
export interface SsoDomainRow extends BaseRow {
  organizationId: string;
  domain: string;
  /** The value of the TXT record that proves the claim. */
  challenge: string;
  /** The domain while the proof holds, else null. Unique: one organization per claimed domain. */
  claimedDomain: string | null;
  connectionId: string | null;
  /** True: only SSO signs in an address of this domain (owner decision 2). */
  enforce: boolean;
  includeSubdomains: boolean;
  verifiedAt: Date | null;
  checkedAt: Date | null;
  /** The count of failed rechecks in a row. */
  failures: number;
  /** The first failed recheck of the row of failures, so the loss rule reads the span. */
  firstFailureAt: Date | null;
  expiresAt: Date | null;
}

/** The scopes of a SCIM token (plan 12d). */
export type ScimScope =
  | "scim.users.read"
  | "scim.users.write"
  | "scim.groups.read"
  | "scim.groups.write";

/** One SCIM bearer token of one organization (plan 12d). */
export interface ScimTokenRow extends BaseRow {
  organizationId: string;
  name: string;
  /** SHA-256 hex of the clear token. The clear token is never stored. */
  tokenHash: string;
  /** The characters after the prefix, so a list tells the tokens apart. */
  hint: string;
  scopes: ScimScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

/** The SCIM view of one user in one organization (plan 12d, RFC 7643 4.1). */
export interface ScimUserRow extends BaseRow {
  organizationId: string;
  userId: string;
  userName: string;
  /** The lower case of `userName`: RFC 7643 makes userName unique without case. */
  userNameKey: string;
  externalId: string | null;
  active: boolean;
  displayName: string | null;
  /** The other attributes of the SCIM resource. */
  data: Record<string, unknown>;
  /** The ETag version (RFC 7644 3.14). A write spends the version it read. */
  version: number;
}

/** One SCIM group of one organization (plan 12d, RFC 7643 4.2). */
export interface ScimGroupRow extends BaseRow {
  organizationId: string;
  displayName: string;
  /** The lower case of `displayName`. */
  displayNameKey: string;
  externalId: string | null;
  /** The 12k team that the group feeds. Null: no team. */
  teamId: string | null;
  /** The ETag version (RFC 7644 3.14). */
  version: number;
}

/** One member of one SCIM group (plan 12d). */
export interface ScimGroupMemberRow extends BaseRow {
  groupId: string;
  scimUserId: string;
}

export interface Models {
  user: UserRow;
  identity: IdentityRow;
  session: SessionRow;
  verification: VerificationRow;
  passkey: PasskeyRow;
  organization: OrganizationRow;
  member: MemberRow;
  invitation: InvitationRow;
  password: PasswordRow;
  apiToken: ApiTokenRow;
  totp: TotpRow;
  trustedDevice: TrustedDeviceRow;
  jwk: JwkRow;
  oauthClient: OAuthClientRow;
  oauthConsent: OAuthConsentRow;
  oauthToken: OAuthTokenRow;
  oauthDevice: OAuthDeviceRow;
  oauthSubject: OAuthSubjectRow;
  oauthSessionClient: OAuthSessionClientRow;
  oauthLogout: OAuthLogoutRow;
  secondFactor: SecondFactorRow;
  operatorAudit: OperatorAuditRow;
  organizationRole: OrganizationRoleRow;
  team: TeamRow;
  teamMember: TeamMemberRow;
  organizationToken: OrganizationTokenRow;
  movedToken: MovedTokenRow;
  ssoConnection: SsoConnectionRow;
  ssoDomain: SsoDomainRow;
  scimToken: ScimTokenRow;
  scimUser: ScimUserRow;
  scimGroup: ScimGroupRow;
  scimGroupMember: ScimGroupMemberRow;
}

export type ModelName = keyof Models;

export type FieldType = "string" | "boolean" | "integer" | "date" | "json";

export interface FieldDef {
  type: FieldType;
  nullable?: boolean;
  /**
   * An integer that needs 64 bits: bigint on Postgres and MySQL. One source:
   * the Postgres column map read the field names before plan 12g.
   */
  int64?: true;
}

/**
 * The field list derives from the row interface. A field missing here, or one
 * the row does not have, fails the compile. This ties the two lists together.
 */
export interface ModelDef<M extends ModelName = ModelName> {
  fields: { [K in keyof Models[M] & string]: FieldDef };
  unique: readonly (readonly (keyof Models[M] & string)[])[];
  indexes: readonly (readonly (keyof Models[M] & string)[])[];
}

const base = {
  id: { type: "string" },
  createdAt: { type: "date" },
  updatedAt: { type: "date" },
} as const satisfies Record<string, FieldDef>;

/** The one source for model and field metadata. Adapters map this to SQL. */
export const schema: { [M in ModelName]: ModelDef<M> } = {
  user: {
    fields: {
      ...base,
      email: { type: "string", nullable: true },
      emailVerified: { type: "boolean" },
      name: { type: "string", nullable: true },
      image: { type: "string", nullable: true },
      bannedAt: { type: "date", nullable: true },
      banReason: { type: "string", nullable: true },
      banUntil: { type: "date", nullable: true },
      username: { type: "string", nullable: true },
      displayUsername: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      isAnonymous: { type: "boolean" },
    },
    unique: [["email"], ["username"], ["phone"]],
    // The anonymous step of the sweep reads by flag and age, oldest first (ruling 25 H1).
    indexes: [["isAnonymous", "createdAt"]],
  },
  identity: {
    fields: {
      ...base,
      userId: { type: "string" },
      provider: { type: "string" },
      subject: { type: "string" },
      linkedAt: { type: "date" },
    },
    unique: [["provider", "subject"]],
    indexes: [["userId"]],
  },
  session: {
    fields: {
      ...base,
      userId: { type: "string" },
      tokenHash: { type: "string" },
      expiresAt: { type: "date" },
      lastSeenAt: { type: "date" },
      ip: { type: "string", nullable: true },
      userAgent: { type: "string", nullable: true },
      activeOrganizationId: { type: "string", nullable: true },
      freshAt: { type: "date", nullable: true },
      actorId: { type: "string", nullable: true },
      activeTeamId: { type: "string", nullable: true },
      // NOT NULL. The default false lives in migration 0016 only (plan 12p):
      // a field here has no default, and core writes every field on each insert.
      proved: { type: "boolean" },
    },
    unique: [["tokenHash"]],
    indexes: [["userId"], ["activeOrganizationId"]],
  },
  verification: {
    fields: {
      ...base,
      purpose: { type: "string" },
      identifier: { type: "string" },
      valueHash: { type: "string" },
      expiresAt: { type: "date" },
      consumedAt: { type: "date", nullable: true },
      data: { type: "json", nullable: true },
      secretVersion: { type: "integer" },
    },
    unique: [["valueHash"]],
    indexes: [["purpose", "identifier"]],
  },
  passkey: {
    fields: {
      ...base,
      userId: { type: "string" },
      credentialId: { type: "string" },
      publicKey: { type: "string" },
      counter: { type: "integer", int64: true },
      transports: { type: "string", nullable: true },
      deviceType: { type: "string" },
      backedUp: { type: "boolean" },
      name: { type: "string", nullable: true },
      discoverable: { type: "boolean", nullable: true },
      prf: { type: "boolean" },
      largeBlob: { type: "boolean" },
    },
    unique: [["credentialId"]],
    indexes: [["userId"]],
  },
  organization: {
    fields: {
      ...base,
      slug: { type: "string" },
      name: { type: "string" },
      metadata: { type: "json", nullable: true },
    },
    unique: [["slug"]],
    indexes: [],
  },
  member: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      userId: { type: "string" },
      role: { type: "string" },
    },
    unique: [["organizationId", "userId"]],
    indexes: [["userId"]],
  },
  invitation: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      email: { type: "string" },
      role: { type: "string" },
      inviterId: { type: "string" },
      tokenHash: { type: "string" },
      expiresAt: { type: "date" },
      acceptedAt: { type: "date", nullable: true },
      teamIds: { type: "json", nullable: true },
    },
    unique: [["tokenHash"]],
    indexes: [["organizationId", "email"]],
  },
  // plan 8: one password per user. Not an identity row: the identity unique key is (provider, subject).
  password: {
    fields: {
      ...base,
      userId: { type: "string" },
      hash: { type: "string" },
    },
    unique: [["userId"]],
    indexes: [],
  },
  // plan 8b: one row per API token. The table holds the hash, never the token.
  apiToken: {
    fields: {
      ...base,
      userId: { type: "string" },
      name: { type: "string" },
      tokenHash: { type: "string" },
      hint: { type: "string" },
      expiresAt: { type: "date", nullable: true },
      lastUsedAt: { type: "date", nullable: true },
      organizationId: { type: "string", nullable: true },
      permissions: { type: "json", nullable: true },
      metadata: { type: "json", nullable: true },
      rateLimitSeconds: { type: "integer", nullable: true },
      rateLimitMax: { type: "integer", nullable: true },
      remaining: { type: "integer", nullable: true },
      refillAmount: { type: "integer", nullable: true },
      refillSeconds: { type: "integer", nullable: true },
      lastRefillAt: { type: "date", nullable: true },
      retiredAt: { type: "date", nullable: true },
    },
    unique: [["tokenHash"]],
    indexes: [["userId"]],
  },
  // plan 9f: one second factor per user. The table holds the sealed secret, never the secret.
  totp: {
    fields: {
      ...base,
      userId: { type: "string" },
      secret: { type: "string" },
      enabledAt: { type: "date", nullable: true },
      lastStep: { type: "integer", int64: true },
      backupCodes: { type: "json" },
      secretVersion: { type: "integer" },
    },
    unique: [["userId"]],
    indexes: [],
  },
  // plan 9f: one row per trusted device. The table holds the hash, never the token.
  trustedDevice: {
    fields: {
      ...base,
      userId: { type: "string" },
      tokenHash: { type: "string" },
      expiresAt: { type: "date" },
      lastSeenAt: { type: "date" },
    },
    unique: [["tokenHash"]],
    indexes: [["userId"]],
  },
  // plan 9g: the signing keys. The table holds the sealed private key, never the key.
  jwk: {
    fields: {
      ...base,
      publicJwk: { type: "json" },
      privateKey: { type: "string" },
      slot: { type: "string", nullable: true },
      retiredAt: { type: "date", nullable: true },
      secretVersion: { type: "integer" },
    },
    // One signing key. A retired key has slot null, and a null never conflicts.
    unique: [["slot"]],
    indexes: [],
  },
  // plan 9g: the OAuth clients, registered or read from a metadata document.
  oauthClient: {
    fields: {
      ...base,
      kind: { type: "string" },
      name: { type: "string", nullable: true },
      redirectUris: { type: "json" },
      lastSeenAt: { type: "date" },
      // A default makes each row of version 10 read as the public client it
      // was (plan 12e). The defaults live in migration 0011 only: a field
      // here has no default, and core writes every field on each insert.
      authMethod: { type: "string" },
      secretHash: { type: "string", nullable: true },
      secretExpiresAt: { type: "date", nullable: true },
      previousSecretHash: { type: "string", nullable: true },
      previousSecretUntil: { type: "date", nullable: true },
      jwks: { type: "json", nullable: true },
      jwksUri: { type: "string", nullable: true },
      grantTypes: { type: "json" },
      credentialsScopes: { type: "json" },
      introspect: { type: "boolean" },
      postLogoutRedirectUris: { type: "json" },
      backchannelLogoutUri: { type: "string", nullable: true },
      backchannelLogoutSessionRequired: { type: "boolean" },
      subjectType: { type: "string" },
      dpopBound: { type: "boolean" },
    },
    unique: [],
    indexes: [],
  },
  // plan 9g: one consent per user and client.
  oauthConsent: {
    fields: {
      ...base,
      userId: { type: "string" },
      clientId: { type: "string" },
      scopes: { type: "json" },
    },
    // clientId first: the sweep looks up the consents of one client, and the
    // authorize compares both fields, so the one index serves both.
    unique: [["clientId", "userId"]],
    // userId: the grants list reads the consents of one user (plan 9g final
    // fix wave, round 2). The unique key above starts with clientId, so it
    // cannot serve that read.
    indexes: [["userId"]],
  },
  // plan 9g: one row per refresh token. The table holds the hash, never the token.
  oauthToken: {
    fields: {
      ...base,
      tokenHash: { type: "string" },
      familyId: { type: "string" },
      userId: { type: "string" },
      clientId: { type: "string" },
      scopes: { type: "json" },
      resource: { type: "string" },
      expiresAt: { type: "date" },
      usedAt: { type: "date", nullable: true },
      parentId: { type: "string", nullable: true },
      dpopJkt: { type: "string", nullable: true },
    },
    unique: [["tokenHash"]],
    // clientId: the sweep looks up the refresh tokens of one client.
    // parentId: the reuse window finds the child of a spent row (plan 12e).
    indexes: [["userId"], ["familyId"], ["clientId"], ["parentId"]],
  },
  // plan 12e: one row per device grant. The table holds the hashes, never the codes.
  oauthDevice: {
    fields: {
      ...base,
      deviceCodeHash: { type: "string" },
      userCodeHash: { type: "string" },
      secretVersion: { type: "integer" },
      clientId: { type: "string" },
      scopes: { type: "json" },
      resource: { type: "string" },
      status: { type: "string" },
      userId: { type: "string", nullable: true },
      sessionId: { type: "string", nullable: true },
      interval: { type: "integer" },
      lastPolledAt: { type: "date", nullable: true },
      dpopJkt: { type: "string", nullable: true },
      expiresAt: { type: "date" },
    },
    unique: [["deviceCodeHash"], ["userCodeHash"]],
    // expiresAt: the sweep deletes the grants past their expiry.
    indexes: [["expiresAt"]],
  },
  // plan 12e: one pairwise subject per user and sector.
  oauthSubject: {
    fields: {
      ...base,
      userId: { type: "string" },
      sector: { type: "string" },
      subject: { type: "string" },
    },
    // (sector, userId): the token endpoint reads the subject of one user.
    // subject: the userinfo and the logout read the user of one subject.
    unique: [["sector", "userId"], ["subject"]],
    // userId: a user delete removes the user's subjects.
    indexes: [["userId"]],
  },
  // plan 12e: the clients that got tokens in one session.
  oauthSessionClient: {
    fields: {
      ...base,
      sessionId: { type: "string" },
      clientId: { type: "string" },
      userId: { type: "string" },
      sid: { type: "string" },
      issuer: { type: "string", nullable: true },
    },
    unique: [["sessionId", "clientId"]],
    // userId: the end of a user's sessions reads the user's links.
    indexes: [["userId"]],
  },
  // plan 12e: the back-channel logouts to deliver.
  oauthLogout: {
    fields: {
      ...base,
      clientId: { type: "string" },
      userId: { type: "string" },
      sessionId: { type: "string" },
      sid: { type: "string" },
      attempts: { type: "integer" },
      nextAttemptAt: { type: "date" },
      issuer: { type: "string", nullable: true },
    },
    unique: [],
    // nextAttemptAt: the sweep reads the due rows. userId: a flow delivers the user's due rows.
    indexes: [["nextAttemptAt"], ["userId"]],
  },
  // plan 12c: one second factor per user, apart from its methods. The TOTP
  // secret stays in `totp`; the method list and the backup codes are here.
  secondFactor: {
    fields: {
      ...base,
      userId: { type: "string" },
      enabledAt: { type: "date" },
      methods: { type: "json" },
      backupCodes: { type: "json" },
      backupCodesVersion: { type: "integer" },
      secretVersion: { type: "integer" },
    },
    unique: [["userId"]],
    indexes: [],
  },
  // plan 12f: one row per operator act. Append-only. No userId field, so the
  // account delete and the D1 undo of a user create do not read it.
  operatorAudit: {
    fields: {
      ...base,
      actorKind: { type: "string" },
      actorId: { type: "string" },
      action: { type: "string" },
      targetUserId: { type: "string", nullable: true },
      reason: { type: "string" },
      data: { type: "json", nullable: true },
      ip: { type: "string", nullable: true },
      userAgent: { type: "string", nullable: true },
    },
    unique: [],
    // targetUserId: the audit of one user. actorId: the acts of one operator.
    indexes: [["targetUserId"], ["actorId"]],
  },
  // A role that one organization stored (plan 12k). Never the owner rank; never a name of the config.
  organizationRole: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      name: { type: "string" },
      rank: { type: "integer" },
      permissions: { type: "json" },
    },
    unique: [["organizationId", "name"]],
    indexes: [],
  },
  // A named group of members of one organization. A team has no role (owner decision 1 of 2026-10-14).
  team: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      name: { type: "string" },
    },
    unique: [],
    indexes: [["organizationId"]],
  },
  // organizationId is a copy, so a member removal deletes the person's team rows in one statement.
  teamMember: {
    fields: {
      ...base,
      teamId: { type: "string" },
      organizationId: { type: "string" },
      userId: { type: "string" },
    },
    unique: [["teamId", "userId"]],
    indexes: [["userId"], ["organizationId", "userId"]],
  },
  // A token that an organization owns. No userId field: the account delete of plan 12a leaves it,
  // so a script outlives the person (owner decision 2 of 2026-10-14).
  organizationToken: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      createdById: { type: "string" },
      name: { type: "string" },
      tokenHash: { type: "string" },
      hint: { type: "string" },
      permissions: { type: "json" },
      metadata: { type: "json", nullable: true },
      expiresAt: { type: "date", nullable: true },
      lastUsedAt: { type: "date", nullable: true },
      rateLimitSeconds: { type: "integer", nullable: true },
      rateLimitMax: { type: "integer", nullable: true },
      remaining: { type: "integer", nullable: true },
      refillAmount: { type: "integer", nullable: true },
      refillSeconds: { type: "integer", nullable: true },
      lastRefillAt: { type: "date", nullable: true },
      retiredAt: { type: "date", nullable: true },
    },
    unique: [["tokenHash"]],
    indexes: [["organizationId"]],
  },
  // A key of another system that a move made a core token (plan 12k Task 12 review, M2). No
  // userId field and no tie to the token row, so neither the account delete nor a revoke removes it.
  movedToken: {
    fields: {
      ...base,
      source: { type: "string" },
      sourceId: { type: "string" },
      tokenId: { type: "string" },
    },
    unique: [["source", "sourceId"]],
    indexes: [],
  },
  // An IdP connection of one organization (plan 12d). No userId field.
  ssoConnection: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      kind: { type: "string" },
      label: { type: "string" },
      enabled: { type: "boolean" },
      jit: { type: "boolean" },
      defaultRole: { type: "string" },
      config: { type: "json" },
      clientSecret: { type: "string", nullable: true },
      secretVersion: { type: "integer" },
      mfa: { type: "json", nullable: true },
      scimRoles: { type: "json", nullable: true },
    },
    unique: [],
    indexes: [["organizationId"]],
  },
  // A claimed email domain (plan 12d). The unique key on claimedDomain gives a domain to one
  // organization; a null claimedDomain is no claim, so many rows can hold it.
  ssoDomain: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      domain: { type: "string" },
      challenge: { type: "string" },
      claimedDomain: { type: "string", nullable: true },
      connectionId: { type: "string", nullable: true },
      enforce: { type: "boolean" },
      includeSubdomains: { type: "boolean" },
      verifiedAt: { type: "date", nullable: true },
      checkedAt: { type: "date", nullable: true },
      failures: { type: "integer" },
      firstFailureAt: { type: "date", nullable: true },
      expiresAt: { type: "date", nullable: true },
    },
    unique: [["organizationId", "domain"], ["claimedDomain"]],
    indexes: [["connectionId"]],
  },
  // A SCIM token of one organization (plan 12d). No userId field: a directory owns it, not a person.
  scimToken: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      name: { type: "string" },
      tokenHash: { type: "string" },
      hint: { type: "string" },
      scopes: { type: "json" },
      expiresAt: { type: "date", nullable: true },
      lastUsedAt: { type: "date", nullable: true },
    },
    unique: [["tokenHash"]],
    indexes: [["organizationId"]],
  },
  // The SCIM view of one user (plan 12d). Its userId field makes it a user child model, so the
  // account delete removes it.
  scimUser: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      userId: { type: "string" },
      userName: { type: "string" },
      userNameKey: { type: "string" },
      externalId: { type: "string", nullable: true },
      active: { type: "boolean" },
      displayName: { type: "string", nullable: true },
      data: { type: "json" },
      version: { type: "integer" },
    },
    unique: [
      ["organizationId", "userId"],
      ["organizationId", "userNameKey"],
    ],
    indexes: [["organizationId", "externalId"]],
  },
  // A SCIM group of one organization (plan 12d). The role map of the connection is the one
  // source of a group's role, so the group has no role field.
  scimGroup: {
    fields: {
      ...base,
      organizationId: { type: "string" },
      displayName: { type: "string" },
      displayNameKey: { type: "string" },
      externalId: { type: "string", nullable: true },
      teamId: { type: "string", nullable: true },
      version: { type: "integer" },
    },
    unique: [["organizationId", "displayNameKey"]],
    indexes: [["organizationId", "externalId"]],
  },
  // One member of a SCIM group (plan 12d). It names scimUserId, not userId, so it is no user
  // child model.
  scimGroupMember: {
    fields: {
      ...base,
      groupId: { type: "string" },
      scimUserId: { type: "string" },
    },
    unique: [["groupId", "scimUserId"]],
    indexes: [["scimUserId"]],
  },
};
