export const SCHEMA_VERSION = 1;

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
  | "passkey-challenge";

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

export interface Models {
  user: UserRow;
  identity: IdentityRow;
  session: SessionRow;
  verification: VerificationRow;
  passkey: PasskeyRow;
}

export type ModelName = keyof Models;

export type FieldType = "string" | "boolean" | "integer" | "date" | "json";

export interface FieldDef {
  type: FieldType;
  nullable?: boolean;
}

export interface ModelDef {
  fields: Record<string, FieldDef>;
  unique: readonly (readonly string[])[];
  indexes: readonly (readonly string[])[];
}

const base = {
  id: { type: "string" },
  createdAt: { type: "date" },
  updatedAt: { type: "date" },
} as const satisfies Record<string, FieldDef>;

/** The one source for model and field metadata. Adapters map this to SQL. */
export const schema: Record<ModelName, ModelDef> = {
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
    indexes: [["userId"]],
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
};
