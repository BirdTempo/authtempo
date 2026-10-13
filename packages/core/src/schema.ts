export const SCHEMA_VERSION = 7;

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
}

export type VerificationPurpose =
  | "magic-link"
  | "oauth-state"
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
   * An OAuth authorization code (plan 9g). identifier: the client id;
   * valueHash: the SHA-256 hex of the `oc_` code; data: { clientId,
   * redirectUri, codeChallenge, scopes, resource, userId, nonce, sessionId }.
   */
  | "oauth-code";

export interface VerificationRow extends BaseRow {
  purpose: VerificationPurpose;
  identifier: string;
  valueHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  data: Record<string, unknown> | null;
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
}

/** A device that skips the second factor until `expiresAt` (plan 9f). */
export interface TrustedDeviceRow extends BaseRow {
  userId: string;
  /** SHA-256 hex of the `td_` token. The clear token is never stored. */
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
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
}

/** An OAuth client (plan 9g). */
export interface OAuthClientRow extends BaseRow {
  /** `registered`: the id is a `cl_` token. `cimd`: the id is the https URL of the client's metadata document. */
  kind: "registered" | "cimd";
  /** The client's own name: a claim of the client, not a fact. */
  name: string | null;
  redirectUris: string[];
  /** Moved at most once a day. The sweep deletes a client unseen for 90 days with no consent and no refresh token. */
  lastSeenAt: Date;
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
    },
    unique: [["tokenHash"]],
    // clientId: the sweep looks up the refresh tokens of one client.
    indexes: [["userId"], ["familyId"], ["clientId"]],
  },
};
