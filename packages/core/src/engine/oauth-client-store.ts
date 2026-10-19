import type { ResolvedConfig } from "../config.js";
import { constantTimeEqual, randomToken, sha256Hex } from "../primitives/crypto.js";
import type { ClientAuthMethod, OAuthClientRow } from "../schema.js";
import type { Where } from "../storage/port.js";
import { CLIENT_ID_PREFIX, type ClientFields, validClientMetadata } from "./oauth-clients.js";
import { type OAuthResult, oauthFail, oauthOk } from "./oauth-result.js";

/**
 * The in-process client API of the provider (plan 12e, `api.oauth.clients`).
 * No route serves it: an app calls it from its own admin code.
 *
 * A client secret is `cs_` plus 32 random bytes (256 bits). The row holds its
 * SHA-256 hex, compared in constant time. A keyed hash adds nothing to 256
 * bits, and with no key an app secret rotation never ends a client secret
 * (spec 22 item 11). The secret leaves the server once, in the answer of
 * create or rotate.
 */

export const CLIENT_SECRET_PREFIX = "cs_";
/** The page size of `listClients`: the default and the most. */
const LIST_MAX = 100;
/**
 * The hours that the old secret of a rotation still passes: 0 to 168,
 * default 24. A deploy of the client's new secret needs a window; a week
 * bounds a leaked old secret.
 */
const KEEP_OLD_HOURS_DEFAULT = 24;
const KEEP_OLD_HOURS_MAX = 168;
const HOUR_MS = 3_600_000;
/** A list cursor: the creation time in epoch milliseconds, a dot, and the client id. */
const CURSOR_RE = /^(\d{1,15})\.(.+)$/;

/** The fields that a create or an update takes. A field left out keeps its default or its value. */
export interface ClientInput {
  name?: string | null;
  redirectUris?: string[];
  /** Default `none`. An update cannot change it. */
  authMethod?: ClientAuthMethod;
  grantTypes?: string[];
  jwks?: Record<string, unknown> | null;
  jwksUri?: string | null;
  /** The app scopes that this client may ask on the `client_credentials` grant. No built-in scope. */
  credentialsScopes?: string[];
  /** True when this client may call the introspection endpoint. */
  introspect?: boolean;
  postLogoutRedirectUris?: string[];
  subjectType?: "public" | "pairwise";
  dpopBound?: boolean;
}

/** Every field of a client but the two secret hashes. */
export type ClientSummary = Omit<OAuthClientRow, "secretHash" | "previousSecretHash">;

/** The metadata name of each input field, for `validClientMetadata`. */
const METADATA_NAMES: Readonly<Record<keyof ClientInput, string>> = {
  name: "client_name",
  redirectUris: "redirect_uris",
  authMethod: "token_endpoint_auth_method",
  grantTypes: "grant_types",
  jwks: "jwks",
  jwksUri: "jwks_uri",
  credentialsScopes: "credentials_scopes",
  introspect: "introspect",
  postLogoutRedirectUris: "post_logout_redirect_uris",
  subjectType: "subject_type",
  dpopBound: "dpop_bound_access_tokens",
};

/** A new secret and its hash for a secret method, or null for `none` and `private_key_jwt`. */
export async function newClientSecret(
  method: ClientAuthMethod,
): Promise<{ secret: string; hash: string } | null> {
  if (method !== "client_secret_basic" && method !== "client_secret_post") return null;
  const secret = randomToken(CLIENT_SECRET_PREFIX);
  return { secret, hash: await sha256Hex(secret) };
}

/**
 * True when `secret` is the client's secret, or its previous secret while
 * `previousSecretUntil` is after `now`. Both compares run in every case, so
 * the time does not tell which one passed.
 */
export async function secretMatches(
  row: Pick<OAuthClientRow, "secretHash" | "previousSecretHash" | "previousSecretUntil">,
  secret: string,
  now: Date,
): Promise<boolean> {
  const hash = await sha256Hex(secret);
  const current = constantTimeEqual(hash, row.secretHash ?? "");
  const previous = constantTimeEqual(hash, row.previousSecretHash ?? "");
  const previousLive =
    row.previousSecretUntil !== null && row.previousSecretUntil.getTime() > now.getTime();
  return (
    (row.secretHash !== null && current) ||
    (row.previousSecretHash !== null && previousLive && previous)
  );
}

function summaryOf(row: OAuthClientRow): ClientSummary {
  const { secretHash: _s, previousSecretHash: _p, ...summary } = row;
  return summary;
}

/** The input in metadata names, or null when it holds a key that is not a field of `ClientInput`. */
function metadataOf(input: Record<string, unknown>): Record<string, unknown> | null {
  const m: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(METADATA_NAMES, key)) return null;
    m[METADATA_NAMES[key as keyof ClientInput]] = value;
  }
  return m;
}

/** The input of a row, for an update that changes some fields. */
function inputOf(row: ClientFields): Required<ClientInput> {
  return {
    name: row.name,
    redirectUris: row.redirectUris,
    authMethod: row.authMethod,
    grantTypes: row.grantTypes,
    jwks: row.jwks,
    jwksUri: row.jwksUri,
    credentialsScopes: row.credentialsScopes,
    introspect: row.introspect,
    postLogoutRedirectUris: row.postLogoutRedirectUris,
    subjectType: row.subjectType,
    dpopBound: row.dpopBound,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function clientRow(
  config: ResolvedConfig,
  clientId: unknown,
): Promise<OAuthClientRow | null> {
  if (typeof clientId !== "string") return null;
  return config.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: clientId }]);
}

/** A new client of kind `api`. A secret method answers its secret here, once. */
export async function createClient(
  config: ResolvedConfig,
  input: ClientInput,
): Promise<OAuthResult<{ client: ClientSummary; clientSecret?: string }>> {
  const m = isRecord(input) ? metadataOf(input) : null;
  if (!m) return oauthFail("invalid_client_metadata");
  const fields = validClientMetadata(config, m, "create");
  if (!fields.ok) return fields;
  const now = config.clock.now();
  const secret = await newClientSecret(fields.value.authMethod);
  const row = await config.storage.create("oauthClient", {
    id: randomToken(CLIENT_ID_PREFIX),
    // An operator made this client on purpose: the 90-day idle sweep of plan 9g keeps it.
    kind: "api",
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...fields.value,
    secretHash: secret?.hash ?? null,
    secretExpiresAt: null,
    previousSecretHash: null,
    previousSecretUntil: null,
  });
  return oauthOk({
    client: summaryOf(row),
    ...(secret ? { clientSecret: secret.secret } : {}),
  });
}

/** One client of any kind, or `invalid_client`. */
export async function getClient(
  config: ResolvedConfig,
  input: { clientId: string },
): Promise<OAuthResult<ClientSummary>> {
  const row = await clientRow(config, input?.clientId);
  return row ? oauthOk(summaryOf(row)) : oauthFail("invalid_client");
}

/**
 * The clients of every kind, newest first, `limit` (1 to 100, default 100)
 * per page. `next` is the cursor of the next page, or null on the last page.
 * The port has no OR, so a page past the cursor is two reads: the rest of
 * the cursor's own time, then the older times.
 */
export async function listClients(
  config: ResolvedConfig,
  input: { cursor?: string; limit?: number } = {},
): Promise<OAuthResult<{ clients: ClientSummary[]; next: string | null }>> {
  const limit = input.limit ?? LIST_MAX;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_MAX)
    return oauthFail("invalid_request");
  const cursor = input.cursor === undefined ? null : CURSOR_RE.exec(input.cursor);
  if (input.cursor !== undefined && !cursor) return oauthFail("invalid_request");
  const order = {
    sort: [
      { field: "createdAt" as const, dir: "desc" as const },
      { field: "id" as const, dir: "desc" as const },
    ],
  };
  // One row more than the page: it tells whether a next page exists.
  const want = limit + 1;
  let rows: OAuthClientRow[];
  if (!cursor) {
    rows = await config.storage.findMany("oauthClient", [], { ...order, limit: want });
  } else {
    const at = new Date(Number(cursor[1]));
    const same: Where<"oauthClient">[] = [
      { field: "createdAt", op: "eq", value: at },
      { field: "id", op: "lt", value: cursor[2] },
    ];
    rows = await config.storage.findMany("oauthClient", same, { ...order, limit: want });
    if (rows.length < want)
      rows = rows.concat(
        await config.storage.findMany(
          "oauthClient",
          [{ field: "createdAt", op: "lt", value: at }],
          { ...order, limit: want - rows.length },
        ),
      );
  }
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? `${last.createdAt.getTime()}.${last.id}` : null;
  return oauthOk({ clients: page.map(summaryOf), next });
}

/**
 * Changes the fields that `input` names on a `cl_` client. A CIMD client
 * answers `invalid_client`: its document is the source of its fields. The id, the
 * method, and the secret never change here: `invalid_client_metadata` for
 * `authMethod` or any key that is not a field of `ClientInput`.
 */
export async function updateClient(
  config: ResolvedConfig,
  input: { clientId: string } & Omit<ClientInput, "authMethod">,
): Promise<OAuthResult<ClientSummary>> {
  if (!isRecord(input)) return oauthFail("invalid_client_metadata");
  const { clientId, ...patch } = input;
  const row = await clientRow(config, clientId);
  if (!row || row.kind === "cimd") return oauthFail("invalid_client");
  if ("authMethod" in patch) return oauthFail("invalid_client_metadata");
  const change = metadataOf(patch);
  const whole = metadataOf(inputOf(row));
  if (!change || !whole) return oauthFail("invalid_client_metadata");
  const fields = validClientMetadata(config, { ...whole, ...change }, "create");
  if (!fields.ok) return fields;
  const now = config.clock.now();
  await config.storage.update("oauthClient", [{ field: "id", op: "eq", value: row.id }], {
    ...fields.value,
    updatedAt: now,
  });
  return oauthOk(summaryOf({ ...row, ...fields.value, updatedAt: now }));
}

/**
 * Deletes a client with every row that names it, in one transaction. The
 * rows are the consents, the refresh tokens, the device grants, the session
 * links, and the back-channel logouts to deliver. The last three tables have no index
 * on `clientId`, so their deletes scan; this call is an admin action, not a
 * request path.
 */
export async function deleteClient(
  config: ResolvedConfig,
  input: { clientId: string },
): Promise<OAuthResult<{ ok: true }>> {
  const row = await clientRow(config, input?.clientId);
  if (!row) return oauthFail("invalid_client");
  const byClient = [{ field: "clientId" as const, op: "eq" as const, value: row.id }];
  await config.storage.transaction(async (tx) => {
    await tx.delete("oauthConsent", byClient);
    await tx.delete("oauthToken", byClient);
    await tx.delete("oauthDevice", byClient);
    await tx.delete("oauthSessionClient", byClient);
    await tx.delete("oauthLogout", byClient);
    await tx.delete("oauthClient", [{ field: "id", op: "eq", value: row.id }]);
  });
  return oauthOk({ ok: true });
}

/**
 * A new secret for a secret client. The old one passes for `keepOldHours`
 * more (0 to 168, default 24). A second rotation inside that window drops
 * the oldest secret at once.
 */
export async function rotateClientSecret(
  config: ResolvedConfig,
  input: { clientId: string; keepOldHours?: number },
): Promise<OAuthResult<{ client: ClientSummary; clientSecret: string }>> {
  const row = await clientRow(config, input?.clientId);
  if (!row || row.kind === "cimd") return oauthFail("invalid_client");
  const hours = input.keepOldHours ?? KEEP_OLD_HOURS_DEFAULT;
  if (!Number.isSafeInteger(hours) || hours < 0 || hours > KEEP_OLD_HOURS_MAX)
    return oauthFail("invalid_client_metadata");
  const secret = await newClientSecret(row.authMethod);
  if (!secret || row.secretHash === null) return oauthFail("invalid_client_metadata");
  const now = config.clock.now();
  const data = {
    secretHash: secret.hash,
    previousSecretHash: hours > 0 ? row.secretHash : null,
    previousSecretUntil: hours > 0 ? new Date(now.getTime() + hours * HOUR_MS) : null,
    updatedAt: now,
  };
  // The guard on the read hash: of two rotations at once, one wins. The
  // other answers invalid_request, so no caller holds a secret that never works.
  const n = await config.storage.update(
    "oauthClient",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "secretHash", op: "eq", value: row.secretHash },
    ],
    data,
  );
  if (n !== 1) return oauthFail("invalid_request");
  return oauthOk({ client: summaryOf({ ...row, ...data }), clientSecret: secret.secret });
}
