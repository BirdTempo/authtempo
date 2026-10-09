export const SCHEMA_VERSION = 4;

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
  | "password-reset";

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
};
