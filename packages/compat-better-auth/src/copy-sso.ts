import type { StorageAdapter } from "@authtempo/core";
import { BetterAuthCompatError } from "./compat-error.js";
import { ssoOf } from "./server/map-options.js";
import { registerFields } from "./server/sso-routes.js";
import { boolOf, jsonObjectOf } from "./storage/api-keys.js";
import type { CopiedSsoTable, Names } from "./storage/names.js";
import { rawReadOf } from "./storage/raw.js";
import type { BetterAuthInstance, CompatDatabase } from "./types.js";

// copyBetterAuthSso (plan 12d Task 14 Behavior 5, deviation 11, ruling 61
// P5 and P6). It reads the rows of @better-auth/sso 1.7.2 and
// @better-auth/scim 1.7.2 through the raw read of the compat storage. It
// writes through core's api.sso and api.scim with the app actor. So each
// client secret is sealed with the keyring, and each SCIM user passes the
// address rule. It copies no token. A static credential stays in the scim
// plugin's options, and a managed credential is not copied (README).

/** The actor of every write of the copy, in its audit rows. */
const APP = { kind: "app", name: "copy-better-auth-sso" } as const;

/**
 * The statements of one invocation that a call may send: D1 Free allows 50
 * queries per Worker invocation (D1 limits page, read 2026-10-21, ruling 37
 * of plan 12f). A call stops before a row whose worst cost does not fit,
 * and answers `next`.
 */
export const COPY_BUDGET = 50;
/**
 * The worst statements of one row on the compat D1 storage, after the ready
 * check, plus a margin of 2 or more. copy-sso-d1.test.ts measured them on
 * 2026-10-24, on the fixture rows, with a counting binding. A provider took
 * 18 to 21, a SCIM user 34 (4 for a refused one), a group 6, and a member
 * 15. A row starts only when its worst still fits. On a storage with no
 * statement counter each row counts its worst.
 */
export const COPY_WORST = { providers: 24, users: 36, groups: 8, members: 17 } as const;
/** The rows of one raw read. */
const PAGE = 10;
/** A source id that a cursor and a raw read may hold: no quote can reach the SQL. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const PHASES = ["providers", "users", "groups", "members"] as const;
type Phase = (typeof PHASES)[number];
const CURSOR_RE = /^(providers|users|groups|members):([A-Za-z0-9_.:-]{0,128})$/;
const TABLE: Record<Phase, CopiedSsoTable> = {
  providers: "ssoProvider",
  users: "scimUser",
  groups: "scimGroup",
  members: "scimGroupMember",
};
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export interface CopySsoInput {
  /** The `next` of the call before, or absent for the first call. */
  after?: string | null;
}

export interface CopySsoReport {
  connections: number;
  domains: number;
  scimUsers: number;
  scimGroups: number;
  /** The members that the copy added to the copied groups, one SCIM PATCH each. */
  scimGroupMembers: number;
  /** Each source row that the copy did not write, with the reason. A row copied before reads "present". */
  skipped: { id: string; reason: string }[];
  /** Each copied row whose behavior changes in core, with what the owner must do. */
  changed: { id: string; reason: string }[];
  /** The cursor of the next call, or null when the copy is done. */
  next: string | null;
}

type Row = Record<string, unknown>;

/** The SCIM error of a refused write, as one line: the status, the scimType, and the detail. */
function scimReason(status: number, body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Row;
  const type = typeof b.scimType === "string" ? ` ${b.scimType}` : "";
  const detail = typeof b.detail === "string" ? `: ${b.detail}` : "";
  return `scim ${status}${type}${detail}`;
}

/**
 * Copies the SSO providers, then the SCIM users, then the SCIM groups,
 * then the members of each group, of Better Auth into core, one page per
 * call. Call it again with `next` until `next` is null. A second run copies
 * nothing twice (ruling 61 P5). A provider is present when a connection
 * holds its providerId as the label. A user is present when a SCIM user of
 * the organization has its externalId or userName. A group is present when
 * a SCIM group has its externalId or displayName. A member is present when
 * the group holds it.
 * A verified Better Auth domain moves as a pending domain: the owner
 * verifies again, and the shim's verify reads the record that the owner
 * published. Throws on a storage with no raw read, or a bad `after`.
 */
export async function copyBetterAuthSso(
  auth: Pick<BetterAuthInstance, "options" | "tempo">,
  input: CopySsoInput = {},
): Promise<CopySsoReport> {
  const database = auth.options.database as object;
  const read = rawReadOf(database);
  const named = (database as { names?: Names }).names;
  if (!read || !named)
    throw new BetterAuthCompatError([
      "copyBetterAuthSso: pass the storage of betterAuthSchemaStorage or drizzleAdapter",
    ]);
  const ssoApi = auth.tempo.api.sso;
  const scim = auth.tempo.api.scim;
  const options = ssoOf(auth.options);
  if (!ssoApi || !options)
    throw new BetterAuthCompatError(["copyBetterAuthSso: the app needs plugins[sso]"]);
  const names: Names = named;
  const sso: NonNullable<typeof ssoApi> = ssoApi;
  const mapped: NonNullable<typeof options> = options;
  let phase: Phase = "providers";
  let after = "";
  if (input.after !== undefined && input.after !== null) {
    const m = CURSOR_RE.exec(input.after);
    if (!m)
      throw new BetterAuthCompatError(["copyBetterAuthSso: after is not a cursor of this copy"]);
    phase = m[1] as Phase;
    after = m[2] ?? "";
  }
  const tempoStorage: StorageAdapter = (database as CompatDatabase).storage;
  // The ready check runs first and counts once, as core's call meter does (ruling 37 of plan 12f).
  let outside = (await tempoStorage.readyStatements?.()) ?? 0;
  const start = tempoStorage.statementsSent?.();
  let assumed = 0;
  const used = () => {
    const now = tempoStorage.statementsSent?.();
    return outside + (start === undefined || now === undefined ? assumed : now - start);
  };
  const report: CopySsoReport = {
    connections: 0,
    domains: 0,
    scimUsers: 0,
    scimGroups: 0,
    scimGroupMembers: 0,
    skipped: [],
    changed: [],
    next: null,
  };
  const raw = async (table: CopiedSsoTable, where: string, limit?: number): Promise<Row[]> => {
    outside++;
    const sql = `SELECT * FROM ${names.table(table)}${where ? ` WHERE ${where}` : ""} ORDER BY ${names.column(table, "id")}${limit ? ` LIMIT ${limit}` : ""}`;
    return (await read(sql)).map((r) => {
      const row: Row = {};
      for (const [column, value] of Object.entries(r)) {
        const field = names.fieldOf(table, column);
        if (field !== null) row[field] = value;
      }
      return row;
    });
  };
  const idOf = (row: Row): string => {
    const id = String(row.id);
    if (!ID_RE.test(id))
      throw new BetterAuthCompatError([
        `copyBetterAuthSso: the row id ${JSON.stringify(id)} has a form that no cursor holds`,
      ]);
    return id;
  };
  const copiers: Record<Phase, (row: Row) => Promise<undefined>> = {
    providers: (row) => copyProvider(row),
    users: (row) => copyUser(row),
    groups: (row) => copyGroup(row),
    members: (row) => copyMember(row),
  };
  const skip = (id: string, reason: string): undefined => {
    report.skipped.push({ id, reason });
  };
  const change = (id: string, reason: string): void => {
    report.changed.push({ id, reason });
  };
  const organizationOf = async (id: unknown) =>
    typeof id === "string" && id !== ""
      ? tempoStorage.findOne("organization", [{ field: "id", op: "eq", value: id }])
      : null;

  async function copyProvider(row: Row): Promise<undefined> {
    const id = idOf(row);
    const providerId = String(row.providerId ?? "");
    const present = await tempoStorage.findMany(
      "ssoConnection",
      [{ field: "label", op: "eq", value: providerId }],
      { limit: 1 },
    );
    if (present.length > 0) return skip(id, "present: a connection holds this providerId");
    if (!(await organizationOf(row.organizationId)))
      return skip(id, "organizationId: core keeps each connection in an organization that exists");
    const oidc = jsonObjectOf(row.oidcConfig);
    const saml = jsonObjectOf(row.samlConfig);
    const body: Row = {
      providerId,
      issuer: row.issuer,
      domain: row.domain,
      organizationId: row.organizationId,
    };
    if (oidc) {
      // Better Auth keeps the issuer in the config too, and fills two defaults at the register.
      const { issuer, tokenEndpointAuthentication, userInfoEndpoint, overrideUserInfo, ...rest } =
        oidc;
      if (typeof issuer === "string") body.issuer = issuer;
      if (tokenEndpointAuthentication === "client_secret_basic")
        change(
          id,
          "tokenEndpointAuthentication: core sends client_secret_post; set the IdP client to it",
        );
      else if (tokenEndpointAuthentication !== undefined)
        rest.tokenEndpointAuthentication = tokenEndpointAuthentication;
      if (userInfoEndpoint !== undefined)
        change(
          id,
          "userInfoEndpoint: core reads the claims of the verified ID token and calls no userinfo endpoint",
        );
      if (overrideUserInfo !== undefined && overrideUserInfo !== false)
        rest.overrideUserInfo = overrideUserInfo;
      body.oidcConfig = rest;
    } else if (saml) {
      // Better Auth's SP entity id: core's is its own, so the IdP needs core's metadata.
      const { issuer: _sp, spMetadata, ...rest } = saml;
      if (
        spMetadata !== undefined &&
        !(
          typeof spMetadata === "object" &&
          spMetadata !== null &&
          Object.keys(spMetadata).length === 0
        )
      )
        rest.spMetadata = spMetadata;
      body.samlConfig = rest;
    }
    const fields = registerFields(body, mapped.tokenPrefix);
    if (!fields.ok) return skip(id, fields.refusal.message);
    const created = await sso.connections.create({
      actor: APP,
      organizationId: fields.organizationId,
      kind: fields.kind,
      label: fields.providerId,
      jit: mapped.jit,
      defaultRole: mapped.defaultRole,
      ...fields.fields,
    } as never);
    if (!created.ok) return skip(id, `connection: ${created.code}`);
    const connection = created.value;
    const undo = async (reason: string): Promise<undefined> => {
      await sso.connections.delete({ actor: APP, id: connection.id });
      skip(id, reason);
    };
    const added = await sso.domains.add({
      actor: APP,
      organizationId: fields.organizationId,
      domain: fields.domain,
    });
    if (!added.ok) return undo(`domain: ${added.code}`);
    const routed = await sso.domains.update({
      actor: APP,
      id: added.value.id,
      connectionId: connection.id,
    });
    if (!routed.ok) return undo(`domain: ${routed.code}`);
    report.connections++;
    report.domains++;
    const base = `${auth.tempo.baseURL}${auth.tempo.basePath}`;
    change(
      id,
      connection.kind === "oidc"
        ? `redirectURI: register ${base}/sso/${connection.id}/callback at the IdP`
        : `samlConfig: give the IdP core's SP metadata, ${base}/sso/${connection.id}/metadata`,
    );
    if (!routed.value.verified && boolOf(row.domainVerified, false))
      change(
        id,
        "domain: pending in core; verify it again, and the published Better Auth record proves it",
      );
  }

  async function presentScimUser(
    organizationId: string,
    externalId: string | null,
    userName: string,
  ) {
    if (externalId !== null) {
      const by = await tempoStorage.findMany(
        "scimUser",
        [
          { field: "organizationId", op: "eq", value: organizationId },
          { field: "externalId", op: "eq", value: externalId },
        ],
        { limit: 1 },
      );
      if (by[0]) return by[0];
    }
    const by = await tempoStorage.findMany(
      "scimUser",
      [
        { field: "organizationId", op: "eq", value: organizationId },
        { field: "userNameKey", op: "eq", value: userName.toLowerCase() },
      ],
      { limit: 1 },
    );
    return by[0] ?? null;
  }

  async function copyUser(row: Row): Promise<undefined> {
    const id = idOf(row);
    if (!scim) return skip(id, "core's SCIM is off: the app needs plugins[scim]");
    const organizationId = String(row.provisioningDomainId ?? "");
    if (!(await organizationOf(organizationId)))
      return skip(id, "provisioningDomainId: no organization has this id");
    const userName = String(row.userName ?? "");
    const externalId = typeof row.externalId === "string" ? row.externalId : null;
    if (await presentScimUser(organizationId, externalId, userName))
      return skip(id, "present: a SCIM user of the organization has its externalId or userName");
    const attributes = jsonObjectOf(row.serializedAttributes) ?? { schemas: [USER_SCHEMA] };
    const body = {
      ...attributes,
      userName,
      ...(externalId !== null ? { externalId } : {}),
      ...(typeof row.displayName === "string" && row.displayName !== ""
        ? { displayName: row.displayName }
        : {}),
      active: boolOf(row.active, true),
    };
    const r = await scim.users.create({ actor: APP, organizationId, body });
    if (r.status !== 201) return skip(id, scimReason(r.status, r.body));
    report.scimUsers++;
  }

  /** The SCIM group of the organization that has the source group's externalId, else its displayName. */
  async function presentScimGroup(
    organizationId: string,
    externalId: string | null,
    displayName: string,
  ) {
    const by = await tempoStorage.findMany(
      "scimGroup",
      [
        { field: "organizationId", op: "eq", value: organizationId },
        externalId !== null
          ? { field: "externalId", op: "eq", value: externalId }
          : { field: "displayNameKey", op: "eq", value: displayName.toLowerCase() },
      ],
      { limit: 1 },
    );
    return by[0] ?? null;
  }

  /** A group with no member: the members phase adds each one, so a group of any size fits the budget. */
  async function copyGroup(row: Row): Promise<undefined> {
    const id = idOf(row);
    if (!scim) return skip(id, "core's SCIM is off: the app needs plugins[scim]");
    const organizationId = String(row.provisioningDomainId ?? "");
    if (!(await organizationOf(organizationId)))
      return skip(id, "provisioningDomainId: no organization has this id");
    const displayName = String(row.displayName ?? "");
    const externalId = typeof row.externalId === "string" ? row.externalId : null;
    if (await presentScimGroup(organizationId, externalId, displayName))
      return skip(
        id,
        "present: a SCIM group of the organization has its externalId or displayName",
      );
    const body = {
      schemas: [GROUP_SCHEMA],
      displayName,
      ...(externalId !== null ? { externalId } : {}),
    };
    const r = await scim.groups.create({ actor: APP, organizationId, body });
    if (r.status !== 201) return skip(id, scimReason(r.status, r.body));
    report.scimGroups++;
  }

  /** One member of one group, by a SCIM PATCH of core's group, with core's member rules. */
  async function copyMember(row: Row): Promise<undefined> {
    const id = idOf(row);
    if (!scim) return skip(id, "core's SCIM is off: the app needs plugins[scim]");
    const groupId = String(row.groupId ?? "");
    const userId = String(row.scimUserId ?? "");
    if (!ID_RE.test(groupId) || !ID_RE.test(userId))
      return skip(id, "groupId or scimUserId: a form that no read holds");
    const [group] = await raw("scimGroup", `${names.column("scimGroup", "id")} = '${groupId}'`);
    const [user] = await raw("scimUser", `${names.column("scimUser", "id")} = '${userId}'`);
    if (!group || !user) return skip(id, "the source group or SCIM user is gone");
    const organizationId = String(group.provisioningDomainId ?? "");
    const target = await presentScimGroup(
      organizationId,
      typeof group.externalId === "string" ? group.externalId : null,
      String(group.displayName ?? ""),
    );
    if (!target) return skip(id, `member of group ${groupId}: the group was not copied`);
    const member = await presentScimUser(
      organizationId,
      typeof user.externalId === "string" ? user.externalId : null,
      String(user.userName ?? ""),
    );
    if (!member) return skip(id, `member of group ${groupId}: its SCIM user was not copied`);
    const held = await tempoStorage.findMany(
      "scimGroupMember",
      [
        { field: "groupId", op: "eq", value: target.id },
        { field: "scimUserId", op: "eq", value: member.id },
      ],
      { limit: 1 },
    );
    if (held.length > 0) return skip(id, "present: the group holds this member");
    const r = await scim.groups.patch({
      actor: APP,
      organizationId,
      id: target.id,
      body: {
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: "add", path: "members", value: [{ value: member.id }] }],
      },
    });
    if (r.status !== 200 && r.status !== 204) return skip(id, scimReason(r.status, r.body));
    report.scimGroupMembers++;
  }

  for (;;) {
    const worst = COPY_WORST[phase];
    // The page read and the worst row must fit.
    if (used() + 1 + worst > COPY_BUDGET) {
      report.next = `${phase}:${after}`;
      return report;
    }
    const table = TABLE[phase];
    const rows = await raw(
      table,
      after === "" ? "" : `${names.column(table, "id")} > '${after}'`,
      PAGE,
    );
    if (rows.length === 0) {
      const at = PHASES.indexOf(phase);
      const nextPhase = PHASES[at + 1];
      if (nextPhase === undefined) return report;
      phase = nextPhase;
      after = "";
      continue;
    }
    for (const row of rows) {
      const before = used();
      if (before + worst > COPY_BUDGET) {
        report.next = `${phase}:${after}`;
        return report;
      }
      await copiers[phase](row);
      // A storage with no counter counts the worst of each row.
      if (start === undefined) assumed += worst;
      after = idOf(row);
    }
  }
}
