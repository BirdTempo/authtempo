import { BetterAuthCompatError } from "../compat-error.js";

export type BetterAuthTable =
  | "user"
  | "session"
  | "account"
  | "verification"
  | "organization"
  | "member"
  | "invitation"
  | "passkey";

export const BETTER_AUTH_TABLES: readonly BetterAuthTable[] = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "passkey",
];

/**
 * The Better Auth 1.7 field names this package reads or writes, per table,
 * plus the `ta` columns migration 0001 adds. Better Auth's other columns
 * (accessToken, refreshToken, idToken, scope, logo, aaguid) stay as they are:
 * an insert leaves them null and an update never names them.
 */
export const TABLE_FIELDS: Record<BetterAuthTable, readonly string[]> = {
  user: [
    "id",
    "name",
    "email",
    "emailVerified",
    "image",
    "createdAt",
    "updatedAt",
    "taBannedAt",
    "taBanReason",
    "taBanUntil",
  ],
  session: [
    "id",
    "expiresAt",
    "token",
    "createdAt",
    "updatedAt",
    "ipAddress",
    "userAgent",
    "userId",
    "activeOrganizationId",
    "taLastSeenAt",
    "taFreshAt",
    "taActorId",
    "activeTeamId",
  ],
  account: [
    "id",
    "issuer",
    "accountId",
    "providerId",
    "userId",
    "password",
    "createdAt",
    "updatedAt",
    "taLinkedAt",
  ],
  verification: [
    "id",
    "identifier",
    "value",
    "expiresAt",
    "createdAt",
    "updatedAt",
    "taPurpose",
    "taValueHash",
    "taConsumedAt",
    "taData",
    "taSecretVersion",
  ],
  organization: ["id", "name", "slug", "logo", "createdAt", "metadata", "taUpdatedAt"],
  member: ["id", "organizationId", "userId", "role", "createdAt", "taUpdatedAt"],
  invitation: [
    "id",
    "organizationId",
    "email",
    "role",
    "status",
    "expiresAt",
    "createdAt",
    "inviterId",
    "taTokenHash",
    "taAcceptedAt",
    "taUpdatedAt",
    "teamId",
  ],
  passkey: [
    "id",
    "name",
    "publicKey",
    "userId",
    "credentialID",
    "counter",
    "deviceType",
    "backedUp",
    "transports",
    "createdAt",
    "aaguid",
    "taUpdatedAt",
  ],
};

/**
 * Better Auth fields that only some apps have, per table: the admin
 * plugin's ban fields. Only migration 0009 names them, to copy a ban into
 * core's columns (ruling 62 M1). They take the same naming rules, and
 * `fieldOf` does not know them, because no statement reads or writes them.
 */
export const OPTIONAL_FIELDS: Partial<Record<BetterAuthTable, readonly string[]>> = {
  user: ["banned", "banReason", "banExpires"],
};

export interface NamingOptions {
  /** How a field with no explicit column is named. Default "camel", Better Auth's own default. */
  casing?: "camel" | "snake";
  /** SQL table names that differ from the model name, for example consumere's `users`. */
  tables?: Partial<Record<BetterAuthTable, string>>;
  /** SQL column names by Better Auth field name. They win over `casing`. */
  columns?: Partial<Record<BetterAuthTable, Record<string, string>>>;
  /** Postgres only: the schema of the Better Auth tables, for example consumerc's `auth`. */
  pgSchema?: string;
}

export interface Names {
  readonly pgSchema: string | null;
  /** Quoted, and qualified with the Postgres schema when one is set. */
  table(t: BetterAuthTable): string;
  rawTable(t: BetterAuthTable): string;
  /** Quoted. */
  column(t: BetterAuthTable, field: string): string;
  rawColumn(t: BetterAuthTable, field: string): string;
  /** The Better Auth field of a SQL column, or null when the table field list does not know it. */
  fieldOf(t: BetterAuthTable, rawColumn: string): string | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string, path: string): string {
  if (!IDENT.test(name)) {
    throw new BetterAuthCompatError([
      `${path}: "${name}" is not a plain SQL identifier (letters, digits, and _ only)`,
    ]);
  }
  return name;
}

/** `emailVerified` to `email_verified`, `credentialID` to `credential_id`, as Drizzle schemas name them. */
export function snake(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function resolveNames(options: NamingOptions = {}): Names {
  const casing = options.casing ?? "camel";
  const pgSchema = options.pgSchema === undefined ? null : ident(options.pgSchema, "pgSchema");
  const tables = new Map<BetterAuthTable, string>();
  const forward = new Map<BetterAuthTable, Map<string, string>>();
  const back = new Map<BetterAuthTable, Map<string, string>>();
  for (const t of BETTER_AUTH_TABLES) {
    tables.set(t, ident(options.tables?.[t] ?? t, `tables.${t}`));
    const f = new Map<string, string>();
    const b = new Map<string, string>();
    for (const field of TABLE_FIELDS[t]) {
      const column = ident(
        options.columns?.[t]?.[field] ?? (casing === "snake" ? snake(field) : field),
        `columns.${t}.${field}`,
      );
      f.set(field, column);
      b.set(column, field);
    }
    for (const field of OPTIONAL_FIELDS[t] ?? [])
      f.set(
        field,
        ident(
          options.columns?.[t]?.[field] ?? (casing === "snake" ? snake(field) : field),
          `columns.${t}.${field}`,
        ),
      );
    forward.set(t, f);
    back.set(t, b);
  }
  const quote = (s: string) => `"${s}"`;
  const rawTable = (t: BetterAuthTable) => tables.get(t) ?? t;
  const rawColumn = (t: BetterAuthTable, field: string) => {
    const c = forward.get(t)?.get(field);
    if (c === undefined) throw new Error(`authtempo compat: no column for ${t}.${field}`);
    return c;
  };
  return {
    pgSchema,
    table: (t) => (pgSchema ? `${quote(pgSchema)}.${quote(rawTable(t))}` : quote(rawTable(t))),
    rawTable,
    column: (t, field) => quote(rawColumn(t, field)),
    rawColumn,
    fieldOf: (t, c) => back.get(t)?.get(c) ?? null,
  };
}
