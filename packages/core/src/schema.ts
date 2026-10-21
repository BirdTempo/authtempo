export const SCHEMA_VERSION = 12;

export interface BaseRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRow extends BaseRow {
  email: string;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  /** When an operator banned the user (plan 12f). Null: no ban. */
  bannedAt: Date | null;
  /** The operator's reason for the ban. Null when no ban holds. */
  banReason: string | null;
  /** The end of the ban. Null with `bannedAt` set: the ban has no end. */
  banUntil: Date | null;
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
   * The sessions that an act left for the sweep (rulings 44 and 63 of plan
   * 12f). Four acts write it: a ban, a revoke of the platform role, an
   * account delete, and a role loss. A role loss is a removal, a leave, or a
   * role change of the platform member row. The identifier is the user id,
   * and the valueHash is the SHA-256 hex of `session-end:<id>`. The data is
   * { reason, before } or { reason, before, targets }. A row with no
   * `targets` names the user's own sessions: only a ban or a revoke writes
   * one. A row with `targets` names the impersonation sessions that the user
   * opened on those users as an operator. The row lives 3650 days. The sweep
   * deletes it when no session from before `before` stays.
   */
  | "session-end";

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
  | "create_admin";

/** One operator act (plan 12f). Append-only: core has no update and no delete of it. */
export interface OperatorAuditRow extends BaseRow {
  actorKind: "secret" | "user" | "app";
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
}

export type ModelName = keyof Models;

export type FieldType = "string" | "boolean" | "integer" | "date" | "json";

export interface FieldDef {
  type: FieldType;
  nullable?: boolean;
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
      email: { type: "string" },
      emailVerified: { type: "boolean" },
      name: { type: "string", nullable: true },
      image: { type: "string", nullable: true },
      bannedAt: { type: "date", nullable: true },
      banReason: { type: "string", nullable: true },
      banUntil: { type: "date", nullable: true },
    },
    unique: [["email"]],
    indexes: [],
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
      counter: { type: "integer" },
      transports: { type: "string", nullable: true },
      deviceType: { type: "string" },
      backedUp: { type: "boolean" },
      name: { type: "string", nullable: true },
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
      lastStep: { type: "integer" },
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
};
