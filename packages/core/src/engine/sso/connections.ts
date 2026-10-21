import type { ResolvedConfig, ResolvedSso } from "../../config.js";
import { ERRORS } from "../../errors.js";
import { openSealed, seal } from "../../primitives/aead.js";
import { isPublicHost } from "../../primitives/host.js";
import { newId } from "../../primitives/ids.js";
import { currentSecret, secretFor } from "../../primitives/keyring.js";
import { hasControlChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import { readCertificate } from "../../saml/der.js";
import type { OperatorAuditRow, SsoConnectionRow, SsoMfaList } from "../../schema.js";
import { DEFAULT_OIDC_SCOPE, isIssuer, type OidcEndpoints } from "../../social/oidc.js";
import { isHttpsUrl } from "../../social/provider.js";
import { findManyIn } from "../../storage/batch.js";
import type { StorageAdapter } from "../../storage/port.js";
import { writeAuditIn } from "../operator/audit.js";
import { isOwner } from "../organizations.js";
import { roleRowDef } from "../permissions.js";
import { holdsRolePart, ROLE_RE, rankOf } from "../ranks.js";
import { lockOrganization } from "../teams.js";
import { afterAudit, type SsoActMeta } from "./domains.js";
import { type SsoActor, ssoDraft } from "./guard.js";
import { dropDiscovery } from "./oidc.js";
import { importIdpMetadata } from "./saml-sp.js";

/**
 * The OIDC and SAML connections of an organization (plan 12d Task 3, spec
 * 30 items 5 to 9). This file holds the create, the update, the delete,
 * the list, and the sealed client secret. A route calls them with the
 * actor of the manager guard, and `api.sso.connections` with the app.
 */

/** The `info` of the key that seals a client secret. One app secret gives one key per use. */
export const CONNECTION_SEAL_INFO = "authtempo sso client secret";

/** The text bounds of the fields, in UTF-16 code units. */
const LABEL_MAX = 80;
const NAME_MAX = 255;
const CLIENT_SECRET_MAX = 1024;
const ENTITY_ID_MAX = 1024;
const URL_MAX = 2048;
const SCOPE_MAX = 1024;
/** The most values of one key of the MFA list. */
const MFA_VALUES_MAX = 16;
/** The most entries of the SCIM role map. */
const SCIM_ROLES_MAX = 100;
/** The most role names, apart from the static roles, that one write may name: two reads of `IN_CHUNK`. */
const ROLE_NAMES_MAX = 100;
/** The most certificates of a SAML connection: the signing key and the next one during a rollover. */
const CERTIFICATES_MAX = 2;
/** The longest PEM text of one certificate. */
const CERTIFICATE_MAX = 16 * 1024;
/** The role of a new member of a JIT sign-in when the input names none. */
const DEFAULT_ROLE = "member";

/** The keys of each kind of input. A key of another kind answers `invalid_body`. */
const COMMON_KEYS = [
  "organizationId",
  "kind",
  "label",
  "enabled",
  "jit",
  "defaultRole",
  "mfa",
  "scimRoles",
] as const;
const OIDC_KEYS = ["issuer", "clientId", "clientSecret", "scope", "endpoints"] as const;
const SAML_KEYS = [
  "idpMetadata",
  "idpEntityId",
  "ssoUrl",
  "certificates",
  "subjectAttribute",
  "attributes",
] as const;
const MFA_KEYS = ["amr", "acr", "authnContext"] as const;

/** The MFA list as an input. A key with no value is no list. */
export type SsoMfaInput = { [K in keyof SsoMfaList]?: string[] | undefined };

/**
 * Every field of a connection input, each one optional. An update takes any
 * of them. A field with the value `undefined` is absent.
 */
export interface ConnectionFields {
  organizationId?: string | undefined;
  kind?: "oidc" | "saml" | undefined;
  label?: string | undefined;
  enabled?: boolean | undefined;
  jit?: boolean | undefined;
  defaultRole?: string | undefined;
  mfa?: SsoMfaInput | null | undefined;
  scimRoles?: Record<string, string> | null | undefined;
  issuer?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  scope?: string | undefined;
  endpoints?: OidcEndpoints | null | undefined;
  idpMetadata?: string | undefined;
  idpEntityId?: string | undefined;
  ssoUrl?: string | undefined;
  certificates?: string[] | undefined;
  subjectAttribute?: string | null | undefined;
  attributes?: { email: string; name?: string | null | undefined } | undefined;
}

/** The fields of a new connection (spec 30 items 5 and 9). */
export type ConnectionInput = {
  organizationId: string;
  label: string;
  enabled?: boolean;
  jit?: boolean;
  defaultRole?: string;
  mfa?: SsoMfaInput | null;
  scimRoles?: Record<string, string> | null;
} & (
  | {
      kind: "oidc";
      issuer: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
      endpoints?: OidcEndpoints | null;
    }
  | ({
      kind: "saml";
      subjectAttribute?: string | null;
      attributes?: { email: string; name?: string | null };
    } & ({ idpMetadata: string } | { idpEntityId: string; ssoUrl: string; certificates: string[] }))
);

/** The stored `config` of an OIDC connection. Never a secret. */
interface OidcStored {
  issuer: string;
  clientId: string;
  scope: string;
  endpoints: OidcEndpoints | null;
}

/** The stored `config` of a SAML connection: the PEM texts of the certificates, which are public. */
export interface SamlStored {
  idpEntityId: string;
  ssoUrl: string;
  certificates: string[];
  subjectAttribute: string | null;
  attributes: { email: string; name: string | null };
}

/** One connection, as the routes and `api.sso.connections` answer it. It never holds the client secret. */
export interface SsoConnectionSummary {
  id: string;
  organizationId: string;
  kind: "oidc" | "saml";
  label: string;
  enabled: boolean;
  jit: boolean;
  defaultRole: string;
  /** Every key of the list, an empty list for a key with no value. */
  mfa: Required<SsoMfaList> | null;
  scimRoles: Record<string, string> | null;
  oidc?: OidcStored;
  saml?: {
    idpEntityId: string;
    ssoUrl: string;
    certificates: { notAfter: string }[];
    subjectAttribute: string | null;
    attributes: { email: string; name: string | null };
    spEntityId: string;
    acsUrl: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * The SP entity id of a SAML connection (spec 30 item 9). It holds the
 * connection id, so a Response for one connection fails the audience check
 * of another (spec 30 item 25).
 */
export function spEntityId(config: ResolvedConfig, connectionId: string): string {
  return `${config.baseURL}${config.basePath}/sso/${connectionId}/metadata`;
}

/** The ACS URL of a SAML connection (spec 30 item 9). It holds the connection id too. */
export function acsUrl(config: ResolvedConfig, connectionId: string): string {
  return `${config.baseURL}${config.basePath}/sso/${connectionId}/acs`;
}

/**
 * The answer form of a row. It names each field, so no new column of the
 * row reaches an answer by accident: the sealed secret and its version
 * never do.
 */
export function publicConnection(
  config: ResolvedConfig,
  row: SsoConnectionRow,
): SsoConnectionSummary {
  const base = {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled,
    jit: row.jit,
    defaultRole: row.defaultRole,
    mfa: row.mfa
      ? { amr: row.mfa.amr ?? [], acr: row.mfa.acr ?? [], authnContext: row.mfa.authnContext ?? [] }
      : null,
    scimRoles: row.scimRoles,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.kind === "oidc") {
    // Core writes the config of a row, and its kind names the form.
    const c = row.config as unknown as OidcStored;
    return {
      ...base,
      oidc: { issuer: c.issuer, clientId: c.clientId, scope: c.scope, endpoints: c.endpoints },
    };
  }
  const c = row.config as unknown as SamlStored;
  const certificates: { notAfter: string }[] = [];
  for (const pem of c.certificates) {
    const info = readCertificate(pem);
    if (info) certificates.push({ notAfter: info.notAfter.toISOString() });
  }
  return {
    ...base,
    saml: {
      idpEntityId: c.idpEntityId,
      ssoUrl: c.ssoUrl,
      certificates,
      subjectAttribute: c.subjectAttribute,
      attributes: { email: c.attributes.email, name: c.attributes.name },
      spEntityId: spEntityId(config, row.id),
      acsUrl: acsUrl(config, row.id),
    },
  };
}

/** `invalid_body` with a message that names the field. */
function refuse(message: string): Result<never> {
  return { ok: false, code: "invalid_body", status: ERRORS.invalid_body, message };
}

/** A string of `min` to `max` code units with no control character. */
function isText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    !hasControlChar(value)
  );
}

/** A plain object: not null, not a list. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An https URL that core fetches or sends a browser to, with a public host.
 * An organization owner writes this URL, and core fetches it. That is a
 * server-side request from a tenant's input (spec 8.13).
 */
function isPublicUrl(config: ResolvedConfig, value: unknown): value is string {
  if (!isHttpsUrl(value) || value.length > URL_MAX) return false;
  const u = new URL(value);
  return u.username === "" && u.password === "" && isPublicHost(u.hostname, config.baseURL);
}

/** The SSO config, or `not_found` while SSO is off. */
function ssoOn(config: ResolvedConfig): Result<ResolvedSso> {
  return config.sso ? ok(config.sso) : fail("not_found");
}

/** `not_found` while the kind is off: `sso.oidc` for OIDC, `sso.saml` for SAML. */
function kindOn(sso: ResolvedSso, kind: "oidc" | "saml"): Result<true> {
  return (kind === "oidc" ? sso.oidc : sso.saml !== null) ? ok(true) : fail("not_found");
}

/** The checked fields of one input. Each key is set only when the input sets it. */
interface Checked {
  label?: string;
  enabled?: boolean;
  jit?: boolean;
  defaultRole?: string;
  mfa?: SsoMfaList | null;
  scimRoles?: Record<string, string> | null;
  oidc: Partial<OidcStored>;
  saml: Partial<SamlStored>;
  clientSecret?: string;
  /** The keys of the input, for the audit row. Never a value. */
  changed: string[];
}

/** The MFA list of an input, with every key, or a refusal that names the field. */
function checkMfa(value: unknown): Result<SsoMfaList | null> {
  if (value === null) return ok(null);
  const rule = `mfa holds amr, acr, and authnContext, each a list of at most ${MFA_VALUES_MAX} strings of 1 to ${NAME_MAX} characters`;
  if (!isRecord(value)) return refuse(rule);
  const out: SsoMfaList = {};
  for (const [key, list] of Object.entries(value)) {
    if (list === undefined) continue;
    if (!(MFA_KEYS as readonly string[]).includes(key)) return refuse(rule);
    if (
      !Array.isArray(list) ||
      list.length > MFA_VALUES_MAX ||
      !list.every((v) => isText(v, 1, NAME_MAX))
    )
      return refuse(rule);
    out[key as keyof SsoMfaList] = [...(list as string[])];
  }
  return ok(out);
}

/** The SCIM role map of an input: names only here; the roles are checked in the transaction. */
function checkScimRoles(value: unknown): Result<Record<string, string> | null> {
  if (value === null) return ok(null);
  const rule = `scimRoles maps at most ${SCIM_ROLES_MAX} group names of 1 to ${NAME_MAX} characters to roles`;
  if (!isRecord(value)) return refuse(rule);
  const entries = Object.entries(value);
  if (entries.length > SCIM_ROLES_MAX) return refuse(rule);
  for (const [group, role] of entries) {
    if (!isText(group, 1, NAME_MAX)) return refuse(rule);
    if (typeof role !== "string" || !ROLE_RE.test(role))
      return refuse("scimRoles maps each group name to a role name");
  }
  // fromEntries defines each key as an own property, so a group named `__proto__` stays data.
  return ok(Object.fromEntries(entries) as Record<string, string>);
}

/** The OIDC endpoints of an input, each an https URL with a public host. */
function checkEndpoints(config: ResolvedConfig, value: unknown): Result<OidcEndpoints | null> {
  if (value === null) return ok(null);
  const rule =
    "endpoints holds authorizeUrl, tokenUrl, and jwksUrl, each an https URL of a public host";
  if (!isRecord(value)) return refuse(rule);
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length !== 3) return refuse(rule);
  const { authorizeUrl, tokenUrl, jwksUrl } = value;
  if (![authorizeUrl, tokenUrl, jwksUrl].every((u) => isPublicUrl(config, u))) return refuse(rule);
  return ok({
    authorizeUrl: authorizeUrl as string,
    tokenUrl: tokenUrl as string,
    jwksUrl: jwksUrl as string,
  });
}

/** The attribute names of the SAML address and name. */
function checkAttributes(value: unknown): Result<SamlStored["attributes"]> {
  const rule = `attributes holds email and name, each a name of 1 to ${NAME_MAX} characters; name may be null`;
  if (!isRecord(value)) return refuse(rule);
  for (const key of Object.keys(value))
    if (value[key] !== undefined && key !== "email" && key !== "name") return refuse(rule);
  const name = value.name ?? null;
  if (!isText(value.email, 1, NAME_MAX) || (name !== null && !isText(name, 1, NAME_MAX)))
    return refuse(rule);
  return ok({ email: value.email, name });
}

/**
 * Checks each field of `input` that is set, by the rules of its kind (plan
 * 12d Task 3 Behaviors 2, 3, and 5). A field of the other kind, or a key
 * that no connection has, answers `invalid_body` with the field's name.
 * `organizationId`, `kind`, and `id` pass through: the caller reads them.
 */
function checkFields(
  config: ResolvedConfig,
  kind: "oidc" | "saml",
  input: Record<string, unknown>,
): Result<Checked> {
  const own = kind === "oidc" ? OIDC_KEYS : SAML_KEYS;
  const out: Checked = { oidc: {}, saml: {}, changed: [] };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || key === "id") continue;
    if (
      !(COMMON_KEYS as readonly string[]).includes(key) &&
      !(own as readonly string[]).includes(key)
    )
      return refuse(`${key} is not a field of an ${kind} connection`);
    if (key !== "organizationId" && key !== "kind") out.changed.push(key);
  }
  out.changed.sort();
  // A copy: the metadata import below sets three fields, and the caller's object stays as it is.
  const v: Record<string, unknown> = { ...input };
  if (v.label !== undefined) {
    if (!isText(v.label, 1, LABEL_MAX))
      return refuse(`label must be 1 to ${LABEL_MAX} characters with no control character`);
    out.label = v.label;
  }
  for (const key of ["enabled", "jit"] as const) {
    const flag = v[key];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") return refuse(`${key} must be true or false`);
    out[key] = flag;
  }
  if (v.defaultRole !== undefined) {
    if (typeof v.defaultRole !== "string" || !ROLE_RE.test(v.defaultRole))
      return refuse("defaultRole must be a role name");
    out.defaultRole = v.defaultRole;
  }
  if (v.mfa !== undefined) {
    const mfa = checkMfa(v.mfa);
    if (!mfa.ok) return mfa;
    out.mfa = mfa.value;
  }
  if (v.scimRoles !== undefined) {
    const roles = checkScimRoles(v.scimRoles);
    if (!roles.ok) return roles;
    out.scimRoles = roles.value;
  }
  if (kind === "oidc") {
    if (v.issuer !== undefined) {
      if (!isIssuer(v.issuer) || v.issuer.length > URL_MAX)
        return refuse("issuer must be an https URL with no query, fragment, or credentials");
      // An organization owner writes this URL, and core fetches it. That is a server-side
      // request from a tenant's input (spec 8.13).
      if (!isPublicHost(new URL(v.issuer).hostname, config.baseURL))
        return refuse("issuer must name a public host");
      out.oidc.issuer = v.issuer;
    }
    if (v.endpoints !== undefined) {
      const endpoints = checkEndpoints(config, v.endpoints);
      if (!endpoints.ok) return endpoints;
      out.oidc.endpoints = endpoints.value;
    }
    if (v.clientId !== undefined) {
      if (!isText(v.clientId, 1, NAME_MAX))
        return refuse(`clientId must be 1 to ${NAME_MAX} characters with no control character`);
      out.oidc.clientId = v.clientId;
    }
    if (v.clientSecret !== undefined) {
      if (!isText(v.clientSecret, 1, CLIENT_SECRET_MAX))
        return refuse(
          `clientSecret must be 1 to ${CLIENT_SECRET_MAX} characters with no control character`,
        );
      out.clientSecret = v.clientSecret;
    }
    if (v.scope !== undefined) {
      if (!isText(v.scope, 1, SCOPE_MAX) || !v.scope.split(" ").includes("openid"))
        return refuse("scope must hold openid, with one space between the scopes");
      out.oidc.scope = v.scope;
    }
    return ok(out);
  }
  // The IdP metadata (plan 12d Task 8 Behavior 6) gives the three fields. They pass the
  // rules below, as fields that an owner types do, so the two inputs keep one rule.
  if (v.idpMetadata !== undefined) {
    if (v.idpEntityId !== undefined || v.ssoUrl !== undefined || v.certificates !== undefined)
      return refuse("idpMetadata replaces idpEntityId, ssoUrl, and certificates");
    if (typeof v.idpMetadata !== "string") return refuse("idpMetadata must be an XML text");
    const imported = importIdpMetadata(v.idpMetadata);
    if (!imported.ok) return imported;
    Object.assign(v, imported.value);
    out.changed = out.changed.filter((k) => k !== "idpMetadata");
    out.changed.push("idpEntityId", "ssoUrl", "certificates");
    out.changed.sort();
  }
  if (v.idpEntityId !== undefined) {
    if (!isText(v.idpEntityId, 1, ENTITY_ID_MAX))
      return refuse(
        `idpEntityId must be 1 to ${ENTITY_ID_MAX} characters with no control character`,
      );
    out.saml.idpEntityId = v.idpEntityId;
  }
  if (v.ssoUrl !== undefined) {
    // The browser goes to this URL, never core. The host rule keeps an IdP off a local name too.
    if (!isPublicUrl(config, v.ssoUrl))
      return refuse("ssoUrl must be an https URL of a public host");
    out.saml.ssoUrl = v.ssoUrl;
  }
  if (v.certificates !== undefined) {
    const list = v.certificates;
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > CERTIFICATES_MAX ||
      !list.every(
        (pem) =>
          typeof pem === "string" && pem.length <= CERTIFICATE_MAX && readCertificate(pem) !== null,
      )
    )
      return refuse(
        `certificates holds 1 or ${CERTIFICATES_MAX} PEM certificates of an RSA or P-256 key, each at most ${CERTIFICATE_MAX} bytes`,
      );
    out.saml.certificates = [...(list as string[])];
  }
  if (v.subjectAttribute !== undefined) {
    if (v.subjectAttribute !== null && !isText(v.subjectAttribute, 1, NAME_MAX))
      return refuse(`subjectAttribute must be null or 1 to ${NAME_MAX} characters`);
    out.saml.subjectAttribute = v.subjectAttribute;
  }
  if (v.attributes !== undefined) {
    const attributes = checkAttributes(v.attributes);
    if (!attributes.ok) return attributes;
    out.saml.attributes = attributes.value;
  }
  return ok(out);
}

/**
 * The role rule of `defaultRole` and of each value of `scimRoles` (plan 12d
 * Task 3 Behavior 2, ruling 25 N2). It runs in the write's transaction. The
 * role is one that the organization knows, static or dynamic. It ranks
 * below owner and never holds the platform role. So no JIT sign-in and no SCIM group gives
 * an owner or a platform operator. The role rows of the organization come
 * in one `in` read per 50 names. The answer is the refusal, or null.
 */
async function roleFault(
  config: ResolvedConfig,
  tx: StorageAdapter,
  organizationId: string,
  roles: readonly (readonly [field: string, role: string])[],
): Promise<Result<never> | null> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  const unknown = new Set<string>();
  for (const [field, role] of roles) {
    if (o.platformRole !== null && holdsRolePart(role, o.platformRole))
      return refuse(`${field} must not hold the platform role`);
    if (isOwner(o, rankOf(o.ranks, role))) return refuse(`${field} must rank below owner`);
    for (const part of role.split(",")) if (!Object.hasOwn(o.roles, part)) unknown.add(part);
  }
  if (unknown.size === 0) return null;
  if (unknown.size > ROLE_NAMES_MAX)
    return refuse(`defaultRole and scimRoles name at most ${ROLE_NAMES_MAX} dynamic roles`);
  const known = new Set<string>();
  if (o.dynamicRoles !== null)
    // A row with a bad shape grants nothing, so it is no role here either.
    for (const row of await findManyIn(
      tx,
      "organizationRole",
      "name",
      [...unknown],
      [{ field: "organizationId", op: "eq", value: organizationId }],
    ))
      if (roleRowDef(o, row) !== null) known.add(row.name);
  for (const [field, role] of roles)
    if (role.split(",").some((part) => !Object.hasOwn(o.roles, part) && !known.has(part)))
      return refuse(`${field} names a role that the organization does not have`);
  return null;
}

/** The role fields of a write, by field name: the default role, then each value of the map. */
function rolesOf(defaultRole: string, scimRoles: Record<string, string> | null) {
  return [
    ["defaultRole", defaultRole] as const,
    ...Object.values(scimRoles ?? {}).map((role) => ["scimRoles", role] as const),
  ];
}

/** The client secret sealed under the current version, bound to the connection id. */
async function sealSecret(config: ResolvedConfig, connectionId: string, plain: string) {
  return seal(
    currentSecret(config.keyring),
    CONNECTION_SEAL_INFO,
    new TextEncoder().encode(plain),
    connectionId,
  );
}

/**
 * The client secret of a connection, or null (plan 12d Task 3 Behavior 4).
 * It opens the sealed value under the version that the row names, with
 * the row id as the bound data. A SAML row has no secret. A version that
 * the config does not hold answers null, and so does a value that does
 * not open. Each writes one log line that names the row, never a value.
 */
export async function connectionSecret(
  config: ResolvedConfig,
  row: SsoConnectionRow,
): Promise<string | null> {
  if (row.clientSecret === null) return null;
  const secret = secretFor(config.keyring, row.secretVersion, row.id);
  if (secret === null) return null;
  const plain = await openSealed(secret, CONNECTION_SEAL_INFO, row.clientSecret, row.id);
  if (plain === null) {
    console.error("authtempo: an sso client secret did not open", row.id);
    return null;
  }
  return new TextDecoder().decode(plain);
}

/**
 * Moves the client secret of one row to the current version (plan 12b
 * rewrap, ruling 31 of plan 12d). It opens the value under the row's
 * version and seals it again under the current one. One conditional
 * update writes it only while the row still holds the value that was read.
 * `updatedAt` stays, so a reseal is no change for the lock of an update.
 * False: the value did not open, or a concurrent write changed it first.
 */
export async function rewrapConnectionRow(
  config: ResolvedConfig,
  row: SsoConnectionRow,
): Promise<boolean> {
  if (row.clientSecret === null) return false;
  const plain = await connectionSecret(config, row);
  if (plain === null) return false;
  const n = await config.storage.update(
    "ssoConnection",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "clientSecret", op: "eq", value: row.clientSecret },
    ],
    {
      clientSecret: await sealSecret(config, row.id, plain),
      secretVersion: config.keyring.current,
    },
  );
  return n > 0;
}

/** The audit draft of one connection act. `data` names the changed keys, never a value. */
function connectionDraft(
  actor: SsoActor,
  action: "sso_connection_create" | "sso_connection_update" | "sso_connection_delete",
  row: Pick<SsoConnectionRow, "id" | "organizationId" | "kind">,
  changed: string[],
  meta: SsoActMeta,
) {
  return ssoDraft(actor, action, {
    targetUserId: null,
    data: { organizationId: row.organizationId, connectionId: row.id, kind: row.kind, changed },
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
}

/**
 * Creates a connection (plan 12d Task 3). The kind must be on (`sso.oidc`
 * or `sso.saml`), else `not_found`. Each field passes its rule, else
 * `invalid_body` with the field's name. An OIDC client secret is sealed
 * under the current version of the keyring, bound to the new id. One
 * transaction holds the organization row and checks the roles. It counts
 * the connections of the organization against
 * `sso.limits.connectionsPerOrganization` (`connection_limit`). Then it
 * writes the row and its `sso_connection_create` audit row. The defaults
 * are `enabled` and `jit` true, `defaultRole` `member`, no MFA list, and
 * no role map. An OIDC connection takes `DEFAULT_OIDC_SCOPE` and discovery
 * for the endpoints. A SAML connection takes the persistent `NameID` as
 * the subject, and the attribute `email` for the address.
 */
export async function createConnection(
  config: ResolvedConfig,
  actor: SsoActor,
  input: ConnectionFields & { organizationId: string; kind: "oidc" | "saml"; label: string },
  meta: SsoActMeta = {},
): Promise<Result<SsoConnectionSummary>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const kind: unknown = input.kind;
  if (kind !== "oidc" && kind !== "saml") return refuse("kind must be oidc or saml");
  const on = kindOn(sso.value, kind);
  if (!on.ok) return on;
  const fields = checkFields(config, kind, input as unknown as Record<string, unknown>);
  if (!fields.ok) return fields;
  const f = fields.value;
  if (f.label === undefined) return refuse("label is required");
  const now = config.clock.now();
  const id = newId(now);
  let stored: OidcStored | SamlStored;
  let clientSecret: string | null = null;
  if (kind === "oidc") {
    const { issuer, clientId } = f.oidc;
    if (issuer === undefined) return refuse("issuer is required");
    if (clientId === undefined) return refuse("clientId is required");
    if (f.clientSecret === undefined) return refuse("clientSecret is required");
    stored = {
      issuer,
      clientId,
      scope: f.oidc.scope ?? DEFAULT_OIDC_SCOPE,
      endpoints: f.oidc.endpoints ?? null,
    };
    clientSecret = await sealSecret(config, id, f.clientSecret);
  } else {
    const { idpEntityId, ssoUrl, certificates } = f.saml;
    if (idpEntityId === undefined) return refuse("idpEntityId is required");
    if (ssoUrl === undefined) return refuse("ssoUrl is required");
    if (certificates === undefined) return refuse("certificates is required");
    stored = {
      idpEntityId,
      ssoUrl,
      certificates,
      subjectAttribute: f.saml.subjectAttribute ?? null,
      attributes: f.saml.attributes ?? { email: "email", name: null },
    };
  }
  const row: SsoConnectionRow = {
    id,
    createdAt: now,
    updatedAt: now,
    organizationId: input.organizationId,
    kind,
    label: f.label,
    enabled: f.enabled ?? true,
    jit: f.jit ?? true,
    defaultRole: f.defaultRole ?? DEFAULT_ROLE,
    config: { ...stored },
    clientSecret,
    // Every create writes the version: the column has no default (ruling 26 Q1 of plan 12d).
    secretVersion: config.keyring.current,
    mfa: f.mfa ?? null,
    scimRoles: f.scimRoles ?? null,
  };
  const created = await config.storage.transaction(
    async (tx): Promise<Result<OperatorAuditRow>> => {
      const organization = await tx.findOne("organization", [
        { field: "id", op: "eq", value: input.organizationId },
      ]);
      // The lock holds the count below against a parallel create (the 12k limit form).
      if (!organization || !(await lockOrganization(tx, organization))) return fail("not_found");
      const fault = await roleFault(
        config,
        tx,
        organization.id,
        rolesOf(row.defaultRole, row.scimRoles),
      );
      if (fault) return fault;
      const limit = sso.value.limits.connectionsPerOrganization;
      const held = await tx.findMany(
        "ssoConnection",
        [{ field: "organizationId", op: "eq", value: organization.id }],
        { limit },
      );
      if (held.length >= limit) return fail("connection_limit");
      await tx.create("ssoConnection", row);
      const draft = connectionDraft(actor, "sso_connection_create", row, f.changed, meta);
      if (!draft.ok) return draft;
      return ok(await writeAuditIn(tx, draft.value, now));
    },
  );
  if (!created.ok) return created;
  await afterAudit(config, created.value);
  return ok(publicConnection(config, row));
}

/**
 * The organization of a connection, or null when no row has the id. A
 * route reads it to run the manager guard for that organization.
 */
export async function connectionOrganization(
  config: ResolvedConfig,
  id: string,
): Promise<string | null> {
  if (!config.sso) return null;
  const row = await config.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: id }]);
  return row?.organizationId ?? null;
}

/**
 * Changes a connection (plan 12d Task 3 Behavior 7). Any field of its
 * kind; the rules of the create hold. `kind` and `organizationId` never
 * change: another value answers `invalid_body`. A new client secret is
 * sealed again under the current version. `enabled: false` answers
 * `invalid_body` while an enforced domain routes to the connection. Such a
 * domain with no way in through SSO would lock its staff out, so the owner
 * turns `enforce` off first. One transaction checks the roles. It writes
 * the row only when its `updatedAt` is the one read, else `conflict`. Then
 * it checks the enforced domains, and it writes one `sso_connection_update`
 * audit row with the changed keys.
 */
export async function updateConnection(
  config: ResolvedConfig,
  actor: SsoActor,
  input: ConnectionFields & { id: string },
  meta: SsoActMeta = {},
): Promise<Result<SsoConnectionSummary>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const held = await config.storage.findOne("ssoConnection", [
    { field: "id", op: "eq", value: input.id },
  ]);
  if (!held) return fail("not_found");
  const on = kindOn(sso.value, held.kind);
  if (!on.ok) return on;
  if (
    (input.kind !== undefined && input.kind !== held.kind) ||
    (input.organizationId !== undefined && input.organizationId !== held.organizationId)
  )
    return refuse("kind and organizationId do not change");
  const fields = checkFields(config, held.kind, input as unknown as Record<string, unknown>);
  if (!fields.ok) return fields;
  const f = fields.value;
  const now = config.clock.now();
  const changes: Partial<SsoConnectionRow> = { updatedAt: now };
  if (f.label !== undefined) changes.label = f.label;
  if (f.enabled !== undefined) changes.enabled = f.enabled;
  if (f.jit !== undefined) changes.jit = f.jit;
  if (f.defaultRole !== undefined) changes.defaultRole = f.defaultRole;
  if (f.mfa !== undefined) changes.mfa = f.mfa;
  if (f.scimRoles !== undefined) changes.scimRoles = f.scimRoles;
  const parts = held.kind === "oidc" ? f.oidc : f.saml;
  if (Object.keys(parts).length > 0) changes.config = { ...held.config, ...parts };
  if (f.clientSecret !== undefined) {
    changes.clientSecret = await sealSecret(config, held.id, f.clientSecret);
    changes.secretVersion = config.keyring.current;
  }
  const row: SsoConnectionRow = { ...held, ...changes };
  const updated = await config.storage
    .transaction(async (tx): Promise<Result<OperatorAuditRow>> => {
      if (f.defaultRole !== undefined || f.scimRoles !== undefined) {
        const fault = await roleFault(
          config,
          tx,
          held.organizationId,
          rolesOf(row.defaultRole, row.scimRoles),
        );
        if (fault) return fault;
      }
      const n = await tx.update(
        "ssoConnection",
        [
          { field: "id", op: "eq", value: held.id },
          { field: "updatedAt", op: "eq", value: held.updatedAt },
        ],
        changes,
      );
      if (n === 0) return fail("conflict");
      // The row write comes first: it holds the lock that `updateDomain` takes (ruling 34 of
      // plan 12d). A parallel enforce waits for this commit, or this read sees its commit.
      if (f.enabled === false) {
        const enforced = await tx.findMany(
          "ssoDomain",
          [
            { field: "connectionId", op: "eq", value: held.id },
            { field: "enforce", op: "eq", value: true },
          ],
          { limit: 1 },
        );
        // The throw undoes the row write.
        if (enforced.length > 0) throw new EnforcedDomainError();
      }
      const draft = connectionDraft(actor, "sso_connection_update", held, f.changed, meta);
      if (!draft.ok) return draft;
      return ok(await writeAuditIn(tx, draft.value, now));
    })
    .catch((e: unknown): Result<never> => {
      if (e instanceof EnforcedDomainError)
        return refuse("enabled false needs enforce off on each domain routed to the connection");
      throw e;
    });
  if (!updated.ok) return updated;
  // A new issuer or new endpoints must not meet the old discovery result of this isolate.
  dropDiscovery(held.id);
  await afterAudit(config, updated.value);
  return ok(publicConnection(config, row));
}

/** Thrown inside the transaction of an update when `enabled: false` meets an enforced domain. The throw undoes the row write. */
class EnforcedDomainError extends Error {
  constructor() {
    super("authtempo: an enforced domain routes to the connection");
    this.name = "EnforcedDomainError";
  }
}

/**
 * Deletes a connection (plan 12d Task 3 Behavior 7). One transaction
 * deletes the row, sets `connectionId: null` and `enforce: false` on each
 * domain routed to it, and writes one `sso_connection_delete` audit row.
 * An enforced domain with no connection would lock its staff out, so the
 * delete and the domain update commit together or not at all. The delete
 * works while the kind of the connection is off, so an owner can clean up.
 */
export async function deleteConnection(
  config: ResolvedConfig,
  actor: SsoActor,
  input: { id: string },
  meta: SsoActMeta = {},
): Promise<Result<{ ok: true }>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const now = config.clock.now();
  const deleted = await config.storage.transaction(
    async (tx): Promise<Result<OperatorAuditRow>> => {
      const row = await tx.findOne("ssoConnection", [{ field: "id", op: "eq", value: input.id }]);
      if (!row) return fail("not_found");
      const n = await tx.delete("ssoConnection", [{ field: "id", op: "eq", value: row.id }]);
      if (n === 0) return fail("not_found");
      await tx.update("ssoDomain", [{ field: "connectionId", op: "eq", value: row.id }], {
        connectionId: null,
        enforce: false,
        updatedAt: now,
      });
      const draft = connectionDraft(actor, "sso_connection_delete", row, [], meta);
      if (!draft.ok) return draft;
      return ok(await writeAuditIn(tx, draft.value, now));
    },
  );
  if (!deleted.ok) return deleted;
  dropDiscovery(input.id);
  await afterAudit(config, deleted.value);
  return ok({ ok: true });
}

/** The connections of an organization, oldest first. An organization that does not exist answers `not_found`. */
export async function listConnections(
  config: ResolvedConfig,
  _actor: SsoActor,
  input: { organizationId: string },
): Promise<Result<SsoConnectionSummary[]>> {
  const sso = ssoOn(config);
  if (!sso.ok) return sso;
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: input.organizationId },
  ]);
  if (!organization) return fail("not_found");
  const rows = await config.storage.findMany(
    "ssoConnection",
    [{ field: "organizationId", op: "eq", value: organization.id }],
    { sort: { field: "id", dir: "asc" } },
  );
  return ok(rows.map((row) => publicConnection(config, row)));
}
