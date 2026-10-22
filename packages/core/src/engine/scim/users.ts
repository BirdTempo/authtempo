/**
 * The SCIM Users of an organization (plan 12d Task 10, RFC 7643 section
 * 4.1, RFC 7644 section 3). A directory creates, reads, changes,
 * deactivates, and deletes the SCIM view of its staff here. The view is one
 * `scimUser` row per user and organization, beside the core user.
 *
 * The one rule that stops a token from taking an account is the address
 * rule (Behavior 2): a create, and a change of the address, needs an address
 * in a verified domain of the token's organization. The organization comes
 * from the token, never from the path or the body.
 *
 * Each write is one transaction with its audit row, as the last statement
 * (`writeAuditIn`). The before hooks run before the first lock and the
 * first write, so a refusal writes nothing on any store. The after hooks
 * run after the commit.
 */

import type { ResolvedConfig } from "../../config.js";
import type { ScimType } from "../../errors.js";
import { newId } from "../../primitives/ids.js";
import { hasControlChar } from "../../primitives/text.js";
import type {
  MemberRow,
  OperatorAuditRow,
  OrganizationRow,
  ScimUserRow,
  SessionRow,
  UserRow,
} from "../../schema.js";
import { findManyIn } from "../../storage/batch.js";
import { type Meter, meterOf } from "../../storage/meter.js";
import { type StorageAdapter, StorageError } from "../../storage/port.js";
import { createSteps, verifySteps } from "../create-steps.js";
import { OLD_ADDRESS_PROOFS } from "../email-change.js";
import { hookGuard, runAfter, runBefore, stopWith } from "../hooks.js";
import { endFamilies, familyEnds } from "../oauth-family.js";
import { endAllAccessPage } from "../operator/access-end.js";
import {
  auditDraft,
  impersonationStops,
  type OperatorAuditDraft,
  SSO_AUDIT_REASON,
  writeAuditIn,
} from "../operator/audit.js";
import { writesPlatformRole } from "../operator/guards.js";
import { OPERATOR_CALL_BUDGET } from "../operator/sessions.js";
import {
  addMemberIn,
  atMemberLimit,
  holdsMember,
  publicOrganization,
  removeMemberIn,
} from "../organizations.js";
import { isOwner, rankOf } from "../ranks.js";
import { later } from "../second-factor.js";
import { sessionsEnded } from "../sessions.js";
import { afterAudit, claimingDomain, inOrganizationDomains } from "../sso/domains.js";
import { lockOrganization } from "../teams.js";
import { holdSessions, holdUser } from "../user-hold.js";
import {
  ensureEmailIdentity,
  findOrCreateUserByEmail,
  normalizeEmail,
  validUserName,
} from "../users.js";
import { scimBase } from "./discovery.js";
import { asciiLower, parseScimFilter, scimKey } from "./filter.js";
import {
  type AttrFacts,
  type AttrRule,
  ENTERPRISE_RULES,
  NS_SCIM_ENTERPRISE,
  NS_SCIM_USER,
  type PatchOp,
  parsePatch,
  USER_RULES,
} from "./patch.js";
import { scimRoleOf } from "./roles.js";
import { type AttributeNotation, pageParams, selectAttributes } from "./select.js";
import type { ScimCaller } from "./tokens.js";

// One source for the URNs: patch.ts (ruling 23 of plan 12d).
export { NS_SCIM_ENTERPRISE, NS_SCIM_USER };

/** The largest `scimUser.data` as JSON, in bytes. A larger resource answers 400 `invalidValue`. */
export const SCIM_DATA_MAX = 16_384;

/** The longest `userName` and `externalId`: a SCIM id of a directory is far shorter. */
const ID_TEXT_MAX = 256;

/** One answer of the SCIM server: the route sends it as `application/scim+json`. */
export interface ScimResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The app as the caller of `api.scim.users`, in place of a token, for one organization. */
export interface ScimAppCaller {
  organizationId: string;
  actor: { kind: "app"; name: string };
}

/** A token of the SCIM routes, or the app through `api.scim.users`. */
export type ScimUserCaller = ScimCaller | ScimAppCaller;

/**
 * The storage calls of a SCIM route before its handler, at the worst: the
 * token read, the limiter count of the token, and the `lastUsedAt` update.
 * The ready check of the storage comes on top. The D1 test
 * `scim-users-budget.test.ts` counts the whole invocation on the binding.
 */
export const SCIM_ROUTE_CALLS_BEFORE = 3;

/** The SCIM error of an answer, in the shape of RFC 7644 section 3.12. */
export function scimFail(status: number, detail: string, scimType?: ScimType): ScimResult {
  return {
    status,
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(status),
      ...(scimType === undefined ? {} : { scimType }),
      detail,
    },
  };
}

/** A lost race on the version of the row: the conditional update matched no row. */
export class VersionLost extends Error {
  constructor() {
    super("authtempo: the SCIM version moved");
    this.name = "VersionLost";
  }
}

/** The detail of the address rule (Behavior 2). */
const ADDRESS_RULE = "the address is not in a verified domain of this organization";

/** The weak ETag of a version (RFC 7644 section 3.14). */
export function etagOf(version: number): string {
  return `W/"${version}"`;
}

/** True when `If-Match` names the version: its weak ETag, or `*`. */
export function matches(ifMatch: string | null, version: number): boolean {
  if (ifMatch === null) return true;
  const sent = ifMatch.trim();
  return sent === "*" || sent === etagOf(version);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A lone surrogate is not text, and Postgres JSON refuses a NUL.
const LONE_SURROGATE_RE = /\p{Cs}/u;
const badText = (s: string): boolean => s.includes("\u0000") || LONE_SURROGATE_RE.test(s);

/** A refusal of a resource body. */
export type Refused = { ok: false; answer: ScimResult };

export function refused(detail: string, scimType: ScimType): Refused {
  return { ok: false, answer: scimFail(400, detail, scimType) };
}

/**
 * Reads a boolean. Entra ID sends `"True"` and `"False"` as text in a PATCH
 * and in the `primary` of a list (ruling 23 of plan 12d). RFC 7644 section
 * 3.5.2 gives a value the type of its attribute, so core reads these two texts
 * as the booleans, and no other text.
 */
function readBoolean(value: unknown): boolean | null {
  if (value === true || value === "True") return true;
  if (value === false || value === "False") return false;
  return null;
}

/**
 * One value of one attribute or sub-attribute by its facts, or a refusal.
 * Null and an empty list are no value (RFC 7643 section 2.5): the answer is
 * undefined.
 */
function simpleValue(value: unknown, facts: AttrFacts, name: string): unknown | Refused {
  if (value === null) return undefined;
  if (facts.type === "boolean") {
    const b = readBoolean(value);
    return b === null ? refused(`${name} takes true or false`, "invalidValue") : b;
  }
  if (typeof value !== "string" || badText(value))
    return refused(`${name} takes a text`, "invalidValue");
  return value;
}

export function isRefused(v: unknown): v is Refused {
  return isObject(v) && v.ok === false && "answer" in v;
}

/** One complex value: an object of known sub-attributes, by their canonical names. */
function complexValue(item: unknown, rule: AttrRule, name: string): unknown | Refused {
  if (item === null) return undefined;
  if (!isObject(item) || rule.subs === null)
    return refused(`${name} takes an object of its sub-attributes`, "invalidValue");
  const out: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(item)) {
    const sub = rule.subs.get(asciiLower(key));
    // A sub-attribute that the schema does not know is ignored (ruling 45 of plan 12d).
    if (sub === undefined) continue;
    // A read-only sub-attribute in a request is ignored (RFC 7643 section 2.2).
    if (sub.facts.mutability === "readOnly") continue;
    const v = simpleValue(part, sub.facts, `${name}.${sub.name}`);
    if (isRefused(v)) return v;
    if (v !== undefined) out[sub.name] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The value of one attribute by its rule, or undefined for no value, or a refusal. */
function attributeValue(value: unknown, rule: AttrRule, name: string): unknown | Refused {
  const facts = rule.facts;
  if (facts === null) return simpleValue(value, { ...PLAIN_TEXT }, name);
  if (facts.type !== "complex") return simpleValue(value, facts, name);
  if (!facts.multiValued) return complexValue(value, rule, name);
  if (value === null) return undefined;
  if (!Array.isArray(value)) return refused(`${name} takes a list`, "invalidValue");
  const items: Record<string, unknown>[] = [];
  for (const item of value) {
    const v = complexValue(item, rule, name);
    if (isRefused(v)) return v;
    if (v !== undefined) items.push(v as Record<string, unknown>);
  }
  // RFC 7643 section 2.4: the primary value true appears at most once.
  if (items.filter((i) => i.primary === true).length > 1)
    return refused(`${name} holds more than one primary value`, "invalidValue");
  return items.length === 0 ? undefined : items;
}

const PLAIN_TEXT: AttrFacts = {
  type: "string",
  multiValued: false,
  required: false,
  caseExact: true,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
};

/** The User of a request, after its checks: the columns, the data, and the address. */
export interface UserDoc {
  userName: string;
  externalId: string | null;
  active: boolean;
  displayName: string | null;
  data: Record<string, unknown>;
  /** The address of the core user, normalized. */
  address: string;
}

/** The enterprise extension of a request: an object of the attributes of RFC 7643 section 4.3. */
function enterpriseValue(value: unknown): Record<string, unknown> | undefined | Refused {
  if (value === null) return undefined;
  if (!isObject(value))
    return refused("the enterprise extension takes an object of its attributes", "invalidValue");
  const out: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(value)) {
    const rule = ENTERPRISE_RULES.get(asciiLower(key));
    // An Okta custom attribute can take the enterprise namespace; it is not stored.
    if (rule === undefined) continue;
    // Entra ID shows the manager as the id text in its User sample ("Develop
    // a SCIM endpoint", Microsoft Learn, read 2026-10-22). RFC 7643 section
    // 4.3 makes it complex, so core reads a text as the manager's `value`.
    const read =
      rule.name === "manager" && typeof part === "string" ? { value: part } : (part as unknown);
    const v = attributeValue(read, rule, rule.name);
    if (isRefused(v)) return v;
    if (v !== undefined) out[rule.name] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** A text of a column: no control character, at most `max` characters. */
export function columnText(value: unknown, name: string, max: number): string | Refused {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return refused(`${name} takes a text of 1 to ${max} characters`, "invalidValue");
  if (hasControlChar(value) || badText(value))
    return refused(`${name} holds a character that is not allowed`, "invalidValue");
  return value;
}

/**
 * The address of a User (Behavior 1): the primary email, else the first
 * email, else `userName` when it is an address. Null when none is an address.
 */
function addressOf(userName: string, data: Record<string, unknown>): string | null {
  const emails = Array.isArray(data.emails) ? (data.emails as Record<string, unknown>[]) : [];
  const picked = emails.find((e) => e.primary === true) ?? emails[0];
  const text = typeof picked?.value === "string" ? picked.value : userName;
  return normalizeEmail(text);
}

const ENTERPRISE_KEY = asciiLower(NS_SCIM_ENTERPRISE);
const USER_KEY = asciiLower(NS_SCIM_USER);

/**
 * Reads a User resource of a POST or a PUT body, or the result of a PATCH
 * (Behavior 1). `schemas` holds the core User URN, and the enterprise URN
 * at most; another URN in `schemas` answers `invalidSyntax`. `password`
 * answers `invalidValue`. `id`, `meta`, and `groups` are ignored (RFC 7643
 * section 2.2). An attribute that the schema does not know is ignored: core
 * stores nothing of it and answers the resource as stored (ruling 45 of plan
 * 12d). RFC 7644 section 3.1 reads a request "in the context of its own
 * schema", and RFC 7643 section 2 lets the server decide which attributes it
 * ignores. Entra ID and Okta send attributes of their own maps, and a refusal
 * would stop the provisioning of each such user.
 */
export function readUser(body: unknown): { ok: true; doc: UserDoc } | Refused {
  if (!isObject(body)) return refused("the body is not a User resource", "invalidSyntax");
  const schemas = body.schemas;
  if (
    !Array.isArray(schemas) ||
    !schemas.every((s) => typeof s === "string") ||
    !schemas.some((s) => asciiLower(s) === USER_KEY) ||
    !schemas.every((s) => asciiLower(s) === USER_KEY || asciiLower(s) === ENTERPRISE_KEY)
  )
    return refused(
      "schemas must hold the core User URN, and the enterprise URN at most",
      "invalidSyntax",
    );
  let userName: unknown;
  let externalId: string | null = null;
  let active = true;
  let displayName: string | null = null;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const lower = asciiLower(key);
    if (lower === "schemas") continue;
    if (lower === ENTERPRISE_KEY) {
      const v = enterpriseValue(value);
      if (isRefused(v)) return v;
      if (v !== undefined) data[NS_SCIM_ENTERPRISE] = v;
      continue;
    }
    const rule = USER_RULES.get(lower);
    // An unknown attribute, or a URN key that `schemas` does not name, is ignored.
    if (rule === undefined) continue;
    if (rule.name === "password") return refused("password is not supported", "invalidValue");
    if (rule.name === "id" || rule.name === "meta" || rule.name === "groups") continue;
    if (rule.name === "userName") {
      userName = value;
      continue;
    }
    if (rule.name === "externalId" || rule.name === "displayName") {
      if (value === null) continue;
      const text = columnText(value, rule.name, ID_TEXT_MAX);
      if (typeof text !== "string") return text;
      if (rule.name === "externalId") externalId = text;
      else displayName = text;
      continue;
    }
    const v = attributeValue(value, rule, rule.name);
    if (isRefused(v)) return v;
    if (rule.name === "active") {
      if (v !== undefined) active = v as boolean;
      continue;
    }
    if (v !== undefined) data[rule.name] = v;
  }
  if (userName === undefined || userName === null)
    return refused("userName is required", "invalidValue");
  const name = columnText(userName, "userName", ID_TEXT_MAX);
  if (typeof name !== "string") return name;
  if (new TextEncoder().encode(JSON.stringify(data)).length > SCIM_DATA_MAX)
    return refused(`the attributes take more than ${SCIM_DATA_MAX} bytes`, "invalidValue");
  const address = addressOf(name, data);
  if (address === null)
    return refused(
      "the user needs an address: a primary email, an email, or a userName that is an address",
      "invalidValue",
    );
  return { ok: true, doc: { userName: name, externalId, active, displayName, data, address } };
}

/** The resource of a row in the form of a request, for the operations of a PATCH. */
function requestForm(row: ScimUserRow): Record<string, unknown> {
  return {
    schemas: [
      NS_SCIM_USER,
      ...(Object.hasOwn(row.data, NS_SCIM_ENTERPRISE) ? [NS_SCIM_ENTERPRISE] : []),
    ],
    userName: row.userName,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    active: row.active,
    ...structuredClone(row.data),
  };
}

/** The key of `object` that equals `name` with no case, or `name`. */
function keyIn(object: Record<string, unknown>, name: string): string {
  return Object.keys(object).find((k) => asciiLower(k) === asciiLower(name)) ?? name;
}

function noTarget(detail: string): Refused {
  return refused(detail, "noTarget");
}

/** The items of a list that the filter of a path matches: by its attribute, with no case. */
function matching(list: unknown[], filter: { attr: string; value: string }): number[] {
  const out: number[] = [];
  for (const [i, item] of list.entries()) {
    if (!isObject(item)) continue;
    const v = item[keyIn(item, filter.attr)];
    if (typeof v === "string" && asciiLower(v) === asciiLower(filter.value)) out.push(i);
  }
  return out;
}

/**
 * Applies the operations of one PATCH to a copy of the resource (RFC 7644
 * section 3.5.2). Each operation applies in order, and the caller writes
 * the result once, so one failed operation writes nothing. A replace of an
 * attribute that does not exist adds it, as section 3.5.2.3 says.
 */
export function applyPatch(
  resource: Record<string, unknown>,
  ops: readonly PatchOp[],
): { ok: true; value: Record<string, unknown> } | Refused {
  const doc = structuredClone(resource);
  for (const op of ops) {
    const path = op.path;
    if (path === null) return refused("each operation needs a path", "invalidPath");
    let container: Record<string, unknown> = doc;
    let key = path.attr;
    const enterprise = `${NS_SCIM_ENTERPRISE}:`;
    if (path.attr.startsWith(enterprise)) {
      const ext = keyIn(doc, NS_SCIM_ENTERPRISE);
      if (!isObject(doc[ext])) {
        if (op.op === "remove") continue;
        doc[ext] = {};
      }
      container = doc[ext] as Record<string, unknown>;
      key = path.attr.slice(enterprise.length);
      // The extension joins the schemas of the resource with its first attribute.
      const schemas = Array.isArray(doc.schemas) ? doc.schemas : [];
      if (!schemas.some((s) => typeof s === "string" && asciiLower(s) === ENTERPRISE_KEY))
        doc.schemas = [...schemas, NS_SCIM_ENTERPRISE];
    }
    key = keyIn(container, key);
    const multi = USER_RULES.get(asciiLower(key))?.facts?.multiValued === true;
    const current = container[key];
    if (path.filter === null && path.sub === null) {
      if (op.op === "remove") delete container[key];
      else if (multi) {
        const added = Array.isArray(op.value) ? op.value : [op.value];
        container[key] = op.op === "add" && Array.isArray(current) ? [...current, ...added] : added;
      } else if (isObject(current) && isObject(op.value))
        container[key] = { ...current, ...op.value };
      else container[key] = op.value;
      continue;
    }
    if (path.filter === null) {
      // A sub-attribute of one complex value, such as name.givenName.
      if (multi)
        return refused("a sub-attribute of a multi-valued attribute needs a filter", "invalidPath");
      const object = isObject(current) ? current : {};
      const sub = keyIn(object, path.sub ?? "");
      if (op.op === "remove") delete object[sub];
      else object[sub] = op.value;
      container[key] = object;
      continue;
    }
    const list = Array.isArray(current) ? [...current] : [];
    const hits = matching(list, path.filter);
    if (op.op === "remove") {
      if (hits.length === 0) return noTarget("no value of the attribute matches the filter");
      if (path.sub === null) container[key] = list.filter((_, i) => !hits.includes(i));
      else
        for (const i of hits) {
          const item = list[i] as Record<string, unknown>;
          delete item[keyIn(item, path.sub)];
        }
      if (path.sub !== null) container[key] = list;
      continue;
    }
    if (hits.length === 0) {
      const added =
        path.sub === null
          ? isObject(op.value)
            ? { ...op.value, [path.filter.attr]: path.filter.value }
            : op.value
          : { [path.filter.attr]: path.filter.value, [path.sub]: op.value };
      container[key] = [...list, added];
      continue;
    }
    for (const i of hits) {
      const item = list[i] as Record<string, unknown>;
      if (path.sub === null)
        list[i] = isObject(op.value)
          ? { ...op.value, [path.filter.attr]: path.filter.value }
          : op.value;
      else item[keyIn(item, path.sub)] = op.value;
    }
    container[key] = list;
  }
  return { ok: true, value: doc };
}

/** The groups of a user, read-only (Behavior 1): the scimGroup rows of its scimGroupMember rows. */
async function groupsOf(
  storage: StorageAdapter,
  scimUserIds: readonly string[],
): Promise<Map<string, { id: string; displayName: string }[]>> {
  const out = new Map<string, { id: string; displayName: string }[]>();
  if (scimUserIds.length === 0) return out;
  const members = await findManyIn(storage, "scimGroupMember", "scimUserId", scimUserIds);
  if (members.length === 0) return out;
  const groups = await findManyIn(storage, "scimGroup", "id", [
    ...new Set(members.map((m) => m.groupId)),
  ]);
  for (const m of members) {
    const g = groups.find((x) => x.id === m.groupId);
    if (!g) continue;
    out.set(m.scimUserId, [
      ...(out.get(m.scimUserId) ?? []),
      { id: g.id, displayName: g.displayName },
    ]);
  }
  return out;
}

/** The location of a User: `<baseURL><basePath>/scim/v2/Users/<id>`. */
function locationOf(config: ResolvedConfig, id: string): string {
  return `${scimBase(config)}/Users/${id}`;
}

/**
 * The SCIM User of a row (Behavior 1). The data come back as stored. `meta`
 * holds the version as a weak ETag, and the answer carries it in `ETag`.
 * `groups` is read-only, from the scimGroupMember rows.
 */
export function toScimUser(
  config: ResolvedConfig,
  row: ScimUserRow,
  groups: readonly { id: string; displayName: string }[],
): Record<string, unknown> {
  const { [NS_SCIM_ENTERPRISE]: enterprise, ...data } = row.data;
  return {
    schemas: [NS_SCIM_USER, ...(enterprise === undefined ? [] : [NS_SCIM_ENTERPRISE])],
    id: row.id,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    userName: row.userName,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...data,
    active: row.active,
    ...(groups.length === 0
      ? {}
      : {
          groups: groups.map((g) => ({
            value: g.id,
            $ref: `${scimBase(config)}/Groups/${g.id}`,
            display: g.displayName,
            type: "direct",
          })),
        }),
    ...(enterprise === undefined ? {} : { [NS_SCIM_ENTERPRISE]: enterprise }),
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: locationOf(config, row.id),
      version: etagOf(row.version),
    },
  };
}

/** The top-level names of a User for `attributes`, with their sub-attributes (RFC 7644 section 3.10). */
const KNOWN: ReadonlySet<string> = new Set([
  "id",
  "schemas",
  "meta",
  ...[...USER_RULES.values()].filter((r) => r.name !== "password").map((r) => asciiLower(r.name)),
  ENTERPRISE_KEY,
]);
const NOTATION: AttributeNotation = {
  core: USER_KEY,
  subs: new Map([
    ...[...USER_RULES.values()]
      .filter((r) => r.subs !== null)
      .map((r) => [asciiLower(r.name), new Set(r.subs?.keys() ?? [])] as const),
    [ENTERPRISE_KEY, new Set(ENTERPRISE_RULES.keys())],
  ]),
};

/** The answer of one User with its ETag and its attribute selection. */
function oneAnswer(
  config: ResolvedConfig,
  row: ScimUserRow,
  groups: readonly { id: string; displayName: string }[],
  status: number,
  url: URL | null,
): ScimResult {
  const resource = toScimUser(config, row, groups);
  const headers: Record<string, string> = { etag: etagOf(row.version) };
  if (status === 201) headers.location = locationOf(config, row.id);
  if (url === null) return { status, body: resource, headers };
  const picked = selectAttributes(resource, url, KNOWN, NOTATION);
  if (!picked.ok) return { status: 400, body: null, headers: {} };
  return { status, body: picked.value, headers };
}

/** The refusal of `selectAttributes`, read once for the answer. */
async function selectRefusal(url: URL): Promise<ScimResult | null> {
  const probe = selectAttributes({}, url, KNOWN, NOTATION);
  if (probe.ok) return null;
  return { status: probe.response.status, body: await probe.response.json() };
}

/** The row of the caller's organization, or null. An id of another organization reads as unknown. */
async function rowOf(
  storage: StorageAdapter,
  caller: ScimUserCaller,
  id: string,
): Promise<ScimUserRow | null> {
  return storage.findOne("scimUser", [
    { field: "id", op: "eq", value: id },
    { field: "organizationId", op: "eq", value: caller.organizationId },
  ]);
}

const NOT_FOUND = (): ScimResult => scimFail(404, "no User of this organization has the id");

/** The audit actions of a SCIM write of a User or a Group. */
export type ScimWriteAction =
  | "scim_user_create"
  | "scim_user_update"
  | "scim_user_deactivate"
  | "scim_user_delete"
  | "scim_group_create"
  | "scim_group_update"
  | "scim_group_delete";

/**
 * The audit draft of a SCIM write: the token by its name, or the app by its
 * name. The reason is the fixed text of the action (`SSO_AUDIT_REASON`). A
 * group write names no user.
 */
export function draftOf(
  caller: ScimUserCaller,
  action: ScimWriteAction,
  targetUserId: string | null,
  data: Record<string, unknown>,
): OperatorAuditDraft {
  const reason = SSO_AUDIT_REASON[action];
  if ("actor" in caller) {
    const d = auditDraft(caller.actor, {
      action,
      reason,
      targetUserId,
      data,
      ip: null,
      userAgent: null,
    });
    if (!d.ok) stopWith(d.code);
    return d.value;
  }
  return {
    actorKind: "scim",
    actorId: caller.tokenName,
    action,
    targetUserId,
    reason,
    data,
    ip: null,
    userAgent: null,
  };
}

/** The meter of one SCIM call: the calls before it, and the ready check of the storage. */
export async function meterFor(config: ResolvedConfig, caller: ScimUserCaller): Promise<Meter> {
  const ready = (await config.storage.readyStatements?.()) ?? 1;
  return meterOf(config.storage, ("actor" in caller ? 0 : SCIM_ROUTE_CALLS_BEFORE) + ready);
}

/** The name that a User gives a core user with no name: displayName, else name.formatted. */
function nameFrom(doc: UserDoc): string | null {
  const name = isObject(doc.data.name) ? doc.data.name : {};
  const parts = [name.givenName, name.familyName].filter((p) => typeof p === "string");
  const text =
    doc.displayName ??
    (typeof name.formatted === "string" ? name.formatted : parts.join(" ").trim() || null);
  return text !== null && validUserName(text) ? text : null;
}

/** Fills the name of a core user that has none, in the write's transaction. */
async function fillName(tx: StorageAdapter, user: UserRow, doc: UserDoc, now: Date): Promise<void> {
  const name = nameFrom(doc);
  if (user.name !== null || name === null) return;
  await tx.update(
    "user",
    [
      { field: "id", op: "eq", value: user.id },
      { field: "name", op: "eq", value: null },
    ],
    { name, updatedAt: later(now, user.updatedAt) },
  );
}

/** A refusal of a hook or a rule of core, as a SCIM error: the status of the code, and the code. */
export function failAnswer(r: { status: number; code: string; message?: string }): ScimResult {
  return scimFail(r.status, r.message ?? r.code);
}

/** The column values of a doc, with the key form of userName. */
function columns(doc: UserDoc) {
  return {
    userName: doc.userName,
    userNameKey: scimKey(doc.userName),
    externalId: doc.externalId,
    active: doc.active,
    displayName: doc.displayName,
    data: doc.data,
  };
}

/** The 409 of a unique key of scimUser (Behavior 3). */
function uniqueAnswer(err: unknown): ScimResult | null {
  if (!(err instanceof StorageError) || err.code !== "unique_violation") return null;
  if (err.model === "scimUser")
    return scimFail(
      409,
      err.fields.includes("userId")
        ? "the user has a SCIM resource in this organization"
        : "another User of this organization has the userName",
      "uniqueness",
    );
  if (err.model === "user" || err.model === "identity")
    return scimFail(409, "another user has the address", "uniqueness");
  return null;
}

/** The member add of a SCIM write, after its checks: the after step writes it. */
interface Join {
  organization: OrganizationRow;
  member: MemberRow;
}

/**
 * The checks of a member add (Behavior 3 and 6), before the first lock and
 * the first write. A row that exists stays, and the answer is null. Then
 * the member limit and `organization.beforeAddMember` with `via: "scim"`.
 * A create gives `scim.defaultRole`: a new User is in no group. A
 * reactivate (`scimUserId`) gives the role of the User's groups by the role
 * map (plan 12d Task 11 Behavior 2, ruling 53 P7). It gives back no team.
 */
async function joinChecks(
  config: ResolvedConfig,
  tx: StorageAdapter,
  organizationId: string,
  user: UserRow,
  now: Date,
  scimUserId: string | null,
): Promise<Join | null> {
  const o = config.organizations;
  if (!o || !config.scim) stopWith("not_found");
  if (await holdsMember(tx, organizationId, user.id)) return null;
  const organization = await tx.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) stopWith("not_found");
  if (await atMemberLimit(tx, o, organizationId)) stopWith("member_limit");
  const member: MemberRow = {
    id: newId(now),
    organizationId,
    userId: user.id,
    role:
      scimUserId === null
        ? config.scim.defaultRole
        : await scimRoleOf(config, tx, organizationId, scimUserId),
    createdAt: now,
    updatedAt: now,
  };
  await runBefore("organization.beforeAddMember", config.hooks.organization.beforeAddMember, {
    organization: publicOrganization(organization),
    member: { userId: user.id, role: member.role },
    memberUser: user,
    by: null,
    via: "scim",
    invitation: null,
  });
  return { organization, member };
}

/** The member add that `joinChecks` passed, through `addMemberIn` with its locks. */
async function joinWrite(
  config: ResolvedConfig,
  tx: StorageAdapter,
  join: Join,
  user: UserRow,
): Promise<MemberRow | null> {
  const o = config.organizations;
  if (!o) stopWith("not_found");
  const added = await addMemberIn(config, tx, o, { ...join, user, by: null, via: "scim" }, true);
  if (added.ok) return join.member;
  // A parallel add wrote the row after the read: it stays as it is.
  if (added.code === "already_member") return null;
  stopWith(added.code);
}

/** The after hooks of a member add. */
async function afterJoin(config: ResolvedConfig, join: Join, member: MemberRow, user: UserRow) {
  await runAfter(
    "organization.afterAddMember",
    config.hooks.organization.afterAddMember,
    {
      organization: publicOrganization(join.organization),
      member: {
        id: member.id,
        userId: user.id,
        role: member.role,
        email: user.email,
        name: user.name,
        createdAt: member.createdAt,
      },
      memberUser: user,
      by: null,
      via: "scim",
      invitation: null,
    },
    member.id,
  );
}

/** `hooks.scim.afterChange` once per write, after the commit (Behavior 9). */
async function afterChange(
  config: ResolvedConfig,
  organizationId: string,
  action: "create" | "update" | "deactivate" | "delete",
  id: string,
): Promise<void> {
  await runAfter(
    "scim.afterChange",
    config.hooks.scim.afterChange,
    { organizationId, resource: "User", action, id },
    id,
  );
}

/**
 * Creates a User (Behavior 3), `POST /Users`. One transaction: the user at
 * the address, or a new user with a verified address, no password, and the
 * `email` identity. An unverified user at the address is claimed. Then the
 * member row with `scim.defaultRole`, or the row that exists stays. Then the
 * scimUser row at version 1, and the audit row `scim_user_create`.
 */
export async function scimCreateUser(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  body: unknown,
): Promise<ScimResult> {
  const read = readUser(body);
  if (!read.ok) return read.answer;
  const doc = read.doc;
  // The address rule (Behavior 2): the one rule that stops a token from
  // creating or taking an account at an address its organization does not own.
  if (!(await inOrganizationDomains(config.storage, caller.organizationId, doc.address)))
    return scimFail(400, ADDRESS_RULE, "invalidValue");
  const now = config.clock.now();
  const verified = verifySteps(config, "scim");
  const made = createSteps(config, "scim", { signUpRule: false });
  const ended: SessionRow[] = [];
  let join: Join | null = null;
  let joined: MemberRow | null = null;
  let row: ScimUserRow | null = null;
  let audit: OperatorAuditRow | null = null;
  try {
    // The checks and the hook of the member add run before the first write.
    const before = async (tx: StorageAdapter, user: UserRow) => {
      join = null;
      // A user with no member row before the create gets one, unless the User is inactive.
      if (doc.active) join = await joinChecks(config, tx, caller.organizationId, user, now, null);
    };
    // After the claim or the create: the locks, the member row, the scimUser row, the audit row.
    const after = async (tx: StorageAdapter, user: UserRow) => {
      await holdUser(tx, user.id);
      await fillName(tx, user, doc, now);
      const j = join;
      joined = j ? await joinWrite(config, tx, j, user) : null;
      const scimUser: ScimUserRow = {
        id: newId(now),
        organizationId: caller.organizationId,
        userId: user.id,
        ...columns(doc),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      row = await tx.create("scimUser", scimUser);
      audit = await writeAuditIn(
        tx,
        draftOf(caller, "scim_user_create", user.id, {
          organizationId: caller.organizationId,
          scimUserId: scimUser.id,
        }),
        now,
      );
      return true;
    };
    const resolved = await hookGuard(async () => {
      const r = await findOrCreateUserByEmail(
        config.storage,
        doc.address,
        now,
        verified,
        after,
        ended,
        before,
        {
          ...made,
          async user(tx, user) {
            // A SCIM create is an act of the organization, as an invitation is:
            // `open` and `invited` let it make a user, and `false` does not.
            if (config.signUp === false) stopWith("sign_up_closed");
            return made.user(tx, user);
          },
        },
      );
      return { ok: true as const, value: r };
    });
    if (!resolved.ok) return failAnswer(resolved);
    const { user } = resolved.value;
    await made.after(user);
    await verified.after(user);
    await sessionsEnded(config, ended, "claim", verified.stops);
    const member = joined as MemberRow | null;
    const j = join as Join | null;
    if (member && j) await afterJoin(config, j, member, user);
  } catch (err) {
    const answer = uniqueAnswer(err);
    if (answer) return answer;
    throw err;
  }
  const created = row as ScimUserRow | null;
  if (created === null) throw new Error("authtempo: the SCIM create wrote no row");
  await afterChange(config, caller.organizationId, "create", created.id);
  const row1 = audit as OperatorAuditRow | null;
  if (row1) await afterAudit(config, row1);
  return oneAnswer(config, created, [], 201, null);
}

/** Reads one User of the caller's organization (Behavior 4), `GET /Users/:id`. */
export async function scimGetUser(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  id: string,
  url: URL,
): Promise<ScimResult> {
  const bad = await selectRefusal(url);
  if (bad) return bad;
  const row = await rowOf(config.storage, caller, id);
  if (!row) return NOT_FOUND();
  const groups = await groupsOf(config.storage, [row.id]);
  return oneAnswer(config, row, groups.get(row.id) ?? [], 200, url);
}

/**
 * Lists the Users of the caller's organization (Behavior 4), by `id`, with
 * the filter of Task 9 Behavior 6 and its paging. `emails.value` compares
 * with the address of the core user.
 */
export async function scimListUsers(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  url: URL,
): Promise<ScimResult> {
  const page = pageParams(url);
  if (!page.ok) return { status: page.response.status, body: await page.response.json() };
  const bad = await selectRefusal(url);
  if (bad) return bad;
  const text = url.searchParams.get("filter");
  const filter = text === null ? null : parseScimFilter(text, "User");
  if (text !== null && filter === null)
    return scimFail(400, "the filter is not one that this server reads", "invalidFilter");
  const org = { field: "organizationId" as const, op: "eq" as const, value: caller.organizationId };
  let rows: ScimUserRow[];
  if (filter === null)
    rows = await config.storage.findMany("scimUser", [org], { sort: { field: "id", dir: "asc" } });
  else if (filter.attr === "emails.value") {
    const email = normalizeEmail(filter.value);
    const user =
      email === null
        ? null
        : await config.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
    rows = user
      ? await config.storage.findMany("scimUser", [
          org,
          { field: "userId", op: "eq", value: user.id },
        ])
      : [];
  } else {
    const where =
      filter.attr === "userName"
        ? { field: "userNameKey" as const, op: "eq" as const, value: scimKey(filter.value) }
        : filter.attr === "externalId"
          ? { field: "externalId" as const, op: "eq" as const, value: filter.value }
          : { field: "id" as const, op: "eq" as const, value: filter.value };
    rows = await config.storage.findMany("scimUser", [org, where], {
      sort: { field: "id", dir: "asc" },
    });
  }
  const slice = rows.slice(page.startIndex - 1, page.startIndex - 1 + page.count);
  const groups = await groupsOf(
    config.storage,
    slice.map((r) => r.id),
  );
  const resources: Record<string, unknown>[] = [];
  for (const row of slice) {
    const picked = selectAttributes(
      toScimUser(config, row, groups.get(row.id) ?? []),
      url,
      KNOWN,
      NOTATION,
    );
    if (picked.ok) resources.push(picked.value);
  }
  return {
    status: 200,
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: rows.length,
      startIndex: page.startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    },
  };
}

/** The names of the attributes that differ between a row and a doc, never their values. */
function changedNames(row: ScimUserRow, doc: UserDoc): string[] {
  const out: string[] = [];
  if (row.userName !== doc.userName) out.push("userName");
  if (row.externalId !== doc.externalId) out.push("externalId");
  if (row.displayName !== doc.displayName) out.push("displayName");
  if (row.active !== doc.active) out.push("active");
  const keys = new Set([...Object.keys(row.data), ...Object.keys(doc.data)]);
  for (const k of [...keys].sort())
    if (JSON.stringify(row.data[k]) !== JSON.stringify(doc.data[k])) out.push(k);
  return out;
}

/** The write of one change of a User: a replace, a patch, or a delete. */
type Change = { kind: "update"; doc: UserDoc } | { kind: "delete" };

/**
 * One write of a User row that exists (Behaviors 5, 6, and 7). The write
 * spends the version it read: one conditional update where `version` is the
 * read version. A lost race answers 412 when the request sent `If-Match`,
 * else the engine reads again and tries once more, then answers 409.
 */
async function changeUser(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  id: string,
  ifMatch: string | null,
  next: (row: ScimUserRow) => Promise<Change | ScimResult>,
): Promise<ScimResult> {
  const meter = await meterFor(config, caller);
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await rowOf(config.storage, caller, id);
    meter.step(1);
    if (!row) return NOT_FOUND();
    if (!matches(ifMatch, row.version))
      return scimFail(412, "the version of the User is not the one of If-Match");
    const change = await next(row);
    if (!("kind" in change)) return change;
    try {
      return await writeChange(config, caller, row, change, meter);
    } catch (err) {
      if (!(err instanceof VersionLost)) throw err;
      if (ifMatch !== null)
        return scimFail(412, "the version of the User is not the one of If-Match");
    }
  }
  return scimFail(409, "the User changed twice during the write; send it again");
}

/**
 * The organization owns the address of its own staff, not of a person who
 * also uses the app in other organizations (Behavior 5).
 */
async function addressMove(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  user: UserRow,
  address: string,
): Promise<ScimResult | null> {
  const others = await config.storage.findMany(
    "member",
    [
      { field: "userId", op: "eq", value: user.id },
      { field: "organizationId", op: "ne", value: caller.organizationId },
    ],
    { limit: 1 },
  );
  if (others.length > 0)
    return scimFail(
      400,
      "the user is a member of another organization, so the address stays",
      "mutability",
    );
  if (!(await inOrganizationDomains(config.storage, caller.organizationId, address)))
    return scimFail(400, ADDRESS_RULE, "invalidValue");
  if (await config.storage.findOne("user", [{ field: "email", op: "eq", value: address }]))
    return scimFail(409, "another user has the address", "uniqueness");
  return null;
}

/** Moves the address of the core user in the write's transaction (Behavior 5). */
async function moveAddress(
  tx: StorageAdapter,
  user: UserRow,
  address: string,
  now: Date,
): Promise<void> {
  const moved = await tx.update(
    "user",
    [
      { field: "id", op: "eq", value: user.id },
      { field: "email", op: "eq", value: user.email },
    ],
    { email: address, emailVerified: true, updatedAt: later(now, user.updatedAt) },
  );
  if (moved === 0) stopWith("conflict");
  // The `email` identity follows the address: it marks the mailbox that signs in by magic link.
  const renamed = await tx.update(
    "identity",
    [
      { field: "provider", op: "eq", value: "email" },
      { field: "userId", op: "eq", value: user.id },
      { field: "subject", op: "eq", value: user.email },
    ],
    { subject: address, updatedAt: now },
  );
  if (renamed === 0) await ensureEmailIdentity(tx, user.id, address, now);
  // A live proof of the old mailbox would make a new user there after the move.
  await tx.delete("verification", [
    { field: "purpose", op: "in", value: OLD_ADDRESS_PROOFS },
    { field: "identifier", op: "eq", value: user.email },
  ]);
}

/** The write of `changeUser` after its reads and its checks. */
async function writeChange(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  row: ScimUserRow,
  change: Change,
  meter: Meter,
): Promise<ScimResult> {
  const o = config.organizations;
  if (!o) return NOT_FOUND();
  const storage = config.storage;
  const user = await storage.findOne("user", [{ field: "id", op: "eq", value: row.userId }]);
  const organization = await storage.findOne("organization", [
    { field: "id", op: "eq", value: caller.organizationId },
  ]);
  meter.step(2);
  if (!user || !organization) return NOT_FOUND();
  const doc = change.kind === "update" ? change.doc : null;
  const active = doc?.active ?? false;
  const deactivate = row.active && !active;
  const reactivate = !row.active && active;
  const move = doc !== null && doc.address !== user.email;
  if (move) {
    const refusal = await addressMove(config, caller, user, doc.address);
    if (refusal) return refusal;
    meter.step(3);
  }
  const member = await storage.findOne("member", [
    { field: "organizationId", op: "eq", value: caller.organizationId },
    { field: "userId", op: "eq", value: user.id },
  ]);
  // The address that the domain claim reads is the one before a move.
  const claimed = deactivate
    ? (await claimingDomain(storage, user.email))?.organizationId === caller.organizationId
    : false;
  meter.step(deactivate ? 3 : 1);
  // SCIM never removes an owner, so the last-owner rule of spec 8.6 holds. A
  // member row with the platform role stays too: its loss is the role loss of
  // the member routes (question Q2 of plan 12d Task 10).
  const kept =
    member !== null &&
    (isOwner(o, rankOf(o.ranks, member.role)) ||
      writesPlatformRole(config, organization, member.role));
  const removes = deactivate && member !== null && !kept;
  if (deactivate && kept) console.info("authtempo: scim kept the member row of an owner", row.id);
  const now = config.clock.now();
  const ends = {
    ended: config.hooks.session.afterEnd ? ([] as SessionRow[]) : undefined,
    families: familyEnds(),
  };
  const stops = impersonationStops(config, "deprovision");
  const memberUser = user;
  const removeEvent =
    member === null
      ? null
      : {
          organization: publicOrganization(organization),
          member: {
            id: member.id,
            userId: user.id,
            role: member.role,
            email: user.email,
            name: user.name,
            createdAt: member.createdAt,
          },
          memberUser,
          by: null,
          via: "scim" as const,
        };
  const names = doc === null ? [] : changedNames(row, doc);
  const action =
    change.kind === "delete"
      ? "scim_user_delete"
      : deactivate
        ? "scim_user_deactivate"
        : "scim_user_update";
  let join: Join | null = null;
  let joined: MemberRow | null = null;
  const written = await hookGuard(() =>
    storage.transaction(async (tx) => {
      join = null;
      // The before hooks first: no lock and no write comes before them.
      if (move && doc)
        await runBefore("user.beforeUpdate", config.hooks.user.beforeUpdate, {
          user,
          patch: { email: doc.address },
          via: "scim",
        });
      if (removes && removeEvent)
        await runBefore(
          "organization.beforeRemoveMember",
          config.hooks.organization.beforeRemoveMember,
          removeEvent,
        );
      if (reactivate) join = await joinChecks(config, tx, caller.organizationId, user, now, row.id);
      // The lock order of user-hold.ts: the user row, the sessions, the organization row, the
      // member rows, the scimGroupMember rows.
      await holdUser(tx, user.id);
      // The role of a reactivate comes from the groups again, after the hold (ruling 59 M2 of
      // plan 12d). A group write holds each user whose role it computes, so it committed
      // before this read, or it waits for this commit and then reads the new member row.
      // The before hook saw the role of the first read: a group write in between answers 409.
      const first = join as Join | null;
      if (
        first &&
        (await scimRoleOf(config, tx, caller.organizationId, row.id)) !== first.member.role
      )
        stopWith("conflict");
      if (deactivate || change.kind === "delete") await holdSessions(tx, user.id);
      const versioned = [
        { field: "id" as const, op: "eq" as const, value: row.id },
        { field: "version" as const, op: "eq" as const, value: row.version },
      ];
      const n =
        change.kind === "delete"
          ? await tx.delete("scimUser", versioned)
          : await tx.update("scimUser", versioned, {
              ...columns(change.doc),
              version: row.version + 1,
              updatedAt: later(now, row.updatedAt),
            });
      if (n === 0) throw new VersionLost();
      // The scimGroupMember rows of a delete come after the member row, as in a group write
      // (ruling 59 M1 of plan 12d). The other order formed a deadlock on Postgres.
      const dropGroups = async () => {
        if (change.kind === "delete")
          await tx.delete("scimGroupMember", [{ field: "scimUserId", op: "eq", value: row.id }]);
      };
      if (!deactivate) await dropGroups();
      if (move && doc) await moveAddress(tx, user, doc.address, now);
      if (doc) await fillName(tx, { ...user, email: doc.address }, doc, now);
      if (deactivate) {
        // The lock of the token create (ruling 32 of plan 12k): a create that holds it
        // commits first, and the token delete sees its row.
        if (!(await lockOrganization(tx, organization))) stopWith("not_found");
        // The member row lock comes before the scimGroupMember rows. It costs one statement on
        // Postgres; D1 and memory have no row lock.
        if (removes && member)
          await tx.lockInOrder?.("member", [{ field: "id", op: "eq", value: member.id }]);
        await dropGroups();
        if (removes && member && (await removeMemberIn(tx, member, true)) === 0)
          stopWith("conflict");
        if (claimed) {
          // A deprovisioned person loses every credential (ruling 25 N1 of plan
          // 12d): the API tokens and the organization tokens that the person made.
          await tx.delete("apiToken", [{ field: "userId", op: "eq", value: user.id }]);
          await tx.delete("organizationToken", [
            { field: "organizationId", op: "eq", value: caller.organizationId },
            { field: "createdById", op: "eq", value: user.id },
          ]);
          // The sessions, challenges, handoff codes, and OAuth tokens, inside the
          // call budget. The sessions that do not fit stay for the sweep. Three calls
          // stay: the user write below (2 on D1: the undo read and the update) and
          // the audit row.
          const page = await endAllAccessPage(
            tx,
            config,
            user.id,
            ends,
            now,
            meter,
            OPERATOR_CALL_BUDGET - 3,
            "revoked",
            stops,
          );
          // The door of the sessions and families that stay (`revokedFor`, ruling 50
          // of plan 12d) reads the pending-end rows only for one from before this
          // write. The time is at or after the `before` of the row (ruling 55).
          if (page.left && page.before) {
            const at = Math.max(config.clock.now().getTime(), page.before.getTime());
            await tx.update("user", [{ field: "id", op: "eq", value: user.id }], {
              updatedAt: later(new Date(at), user.updatedAt),
            });
            meter.step(2);
          }
        }
      }
      const j = join as Join | null;
      if (j) joined = await joinWrite(config, tx, j, user);
      const data: Record<string, unknown> = {
        organizationId: caller.organizationId,
        scimUserId: row.id,
      };
      if (names.length > 0) data.changed = names;
      return {
        ok: true as const,
        value: await writeAuditIn(tx, draftOf(caller, action, user.id, data), now),
      };
    }),
  ).catch((err: unknown) => {
    const answer = uniqueAnswer(err);
    if (answer) return { ok: "stop" as const, answer };
    throw err;
  });
  if (written.ok === "stop") return written.answer;
  if (!written.ok) return failAnswer(written);
  await sessionsEnded(config, ends.ended, "revoked", stops);
  await endFamilies(config, ends.families);
  if (removes && removeEvent && member)
    await runAfter(
      "organization.afterRemoveMember",
      config.hooks.organization.afterRemoveMember,
      removeEvent,
      member.id,
    );
  const j = join as Join | null;
  const added = joined as MemberRow | null;
  if (j && added) await afterJoin(config, j, added, user);
  if (move && doc)
    await runAfter(
      "user.afterUpdate",
      config.hooks.user.afterUpdate,
      {
        user: { ...user, email: doc.address, emailVerified: true },
        previous: user,
        via: "scim",
      },
      user.id,
    );
  await afterChange(
    config,
    caller.organizationId,
    change.kind === "delete" ? "delete" : deactivate ? "deactivate" : "update",
    row.id,
  );
  await afterAudit(config, written.value);
  if (change.kind === "delete") return { status: 204, body: null };
  const after: ScimUserRow = {
    ...row,
    ...columns(change.doc),
    version: row.version + 1,
    updatedAt: later(now, row.updatedAt),
  };
  const groups = await groupsOf(storage, [row.id]);
  return oneAnswer(config, after, groups.get(row.id) ?? [], 200, null);
}

/** Replaces a User (Behavior 5), `PUT /Users/:id`. */
export async function scimReplaceUser(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  id: string,
  body: unknown,
  ifMatch: string | null,
): Promise<ScimResult> {
  const read = readUser(body);
  if (!read.ok) return read.answer;
  const doc = read.doc;
  return changeUser(config, caller, id, ifMatch, async () => ({ kind: "update", doc }));
}

/**
 * Patches a User (Behavior 5), `PATCH /Users/:id`. Every operation applies
 * to a copy, and the write runs once, so the operations are atomic (RFC 7644
 * section 3.5.2). An id of the no-path form that differs from the target
 * answers `mutability` (ruling 24 of plan 12d).
 */
export async function scimPatchUser(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  id: string,
  body: unknown,
  ifMatch: string | null,
): Promise<ScimResult> {
  const parsed = parsePatch(body, "User");
  if (!parsed.ok) return scimFail(parsed.status, parsed.detail, parsed.scimType);
  if (parsed.id !== null && parsed.id !== id) return scimFail(400, "id is read-only", "mutability");
  return changeUser(config, caller, id, ifMatch, async (row) => {
    const applied = applyPatch(requestForm(row), parsed.ops);
    if (!applied.ok) return applied.answer;
    const read = readUser(applied.value);
    if (!read.ok) return read.answer;
    return { kind: "update", doc: read.doc };
  });
}

/**
 * Deletes a User (Behavior 7), `DELETE /Users/:id`: the deactivate, then the
 * delete of the scimUser row and its scimGroupMember rows, in one
 * transaction. The core user stays: an account may hold data of other
 * organizations, and only the person deletes an account (spec 8.15).
 */
export async function scimDeleteUser(
  config: ResolvedConfig,
  caller: ScimUserCaller,
  id: string,
  ifMatch: string | null,
): Promise<ScimResult> {
  return changeUser(config, caller, id, ifMatch, async () => ({ kind: "delete" }));
}

/** The scimUser rows that the account delete reads, for their scimGroupMember rows (ruling 25). */
export async function scimUserIdsOf(tx: StorageAdapter, userId: string): Promise<string[]> {
  const rows = await tx.findMany("scimUser", [{ field: "userId", op: "eq", value: userId }]);
  return rows.map((r) => r.id);
}
