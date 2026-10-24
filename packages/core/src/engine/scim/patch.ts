/**
 * The SCIM PATCH parser (plan 12d Task 10 Behavior 8, RFC 7644 section
 * 3.5.2). The body comes from a directory. So the parser bounds the count of
 * operations, the length of a path, and the depth of a value. It knows each
 * attribute by name. A form that the plan does not name is refused, never
 * ignored. The read-only keys of the no-path form are the one exception (Task
 * 10 Behavior 1). The parser reads only; the caller applies the operations to
 * a copy and writes once.
 */

import { SCIM_ERRORS, type ScimType } from "../../errors.js";
import { asciiLower, readJsonString } from "./filter.js";

export type PatchPath = {
  attr: string;
  sub: string | null;
  filter: { attr: string; value: string } | null;
};
export type PatchOp = { op: "add" | "remove" | "replace"; path: PatchPath | null; value: unknown };

type Refusal = { ok: false; status: number; scimType: ScimType; detail: string };

export const NS_SCIM_PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const NS_SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const NS_SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const NS_SCIM_ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

/** The most operations of one PATCH, after the no-path form gives one per key. */
export const PATCH_OPS_MAX = 100;
/** The longest path. The longest path that core names is under 80 characters. */
export const PATCH_PATH_MAX = 256;
/** The deepest value: a no-path value with `members`, a list of objects, is 3 levels. */
export const PATCH_VALUE_DEPTH_MAX = 3;

/**
 * The facts of one attribute in the Schema document (RFC 7643 section 7,
 * as section 8.7.1 gives them, read 2026-10-21). The discovery documents
 * read them here, so the parser and the documents describe one table.
 */
export interface AttrFacts {
  readonly type: "string" | "boolean" | "complex" | "reference" | "binary";
  readonly multiValued: boolean;
  readonly required: boolean;
  readonly caseExact: boolean;
  readonly mutability: "readWrite" | "readOnly" | "immutable" | "writeOnly";
  readonly returned: "always" | "default" | "never" | "request";
  readonly uniqueness: "none" | "server" | "global";
  readonly referenceTypes?: readonly string[];
  readonly canonicalValues?: readonly string[];
}

export interface SubRule {
  readonly name: string;
  readonly boolean: boolean;
  readonly facts: AttrFacts;
}

export interface AttrRule {
  readonly name: string;
  readonly boolean: boolean;
  readonly subs: ReadonlyMap<string, SubRule> | null;
  // The one filter attribute of `attr[<filter> eq "..."]`. Only a `type`
  // filter takes a sub-attribute after it.
  readonly filter: "type" | "value" | null;
  // A known attribute that a PATCH must not change.
  readonly refuse: { scimType: ScimType; detail: string } | null;
  // The read of the key in the no-path form: as a path, ignored, or the id.
  readonly noPath: "path" | "ignore" | "id";
  // The facts of the Schema document. Null for a common attribute of RFC
  // 7643 section 3.1 (id, externalId, meta, schemas), which no Schema lists.
  // Null for password too, which core never stores.
  readonly facts: AttrFacts | null;
}

function rules(list: AttrRule[]): ReadonlyMap<string, AttrRule> {
  return new Map(list.map((r) => [asciiLower(r.name), r]));
}

/** The facts of most attributes of RFC 7643 section 8.7.1: an optional text that a client writes. */
const PLAIN: AttrFacts = {
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
};

function text(name: string, facts: Partial<AttrFacts> | null = {}): AttrRule {
  return {
    name,
    boolean: false,
    subs: null,
    filter: null,
    refuse: null,
    noPath: "path",
    facts: facts === null ? null : { ...PLAIN, ...facts },
  };
}

function flag(name: string): AttrRule {
  return { ...text(name, { type: "boolean" }), boolean: true };
}

/** One sub-attribute: a name, or a name with the facts that differ from `PLAIN`. */
type SubSpec = string | readonly [name: string, facts: Partial<AttrFacts>];

/**
 * A complex attribute. A sub-attribute takes the mutability of its parent.
 * `primary` is a boolean and `$ref` a reference, as section 8.7.1 has them.
 */
function complex(
  name: string,
  subs: readonly SubSpec[],
  filter: "type" | "value" | null,
  facts: Partial<AttrFacts> = {},
): AttrRule {
  const own: AttrFacts = { ...PLAIN, type: "complex", ...facts };
  const map = new Map(
    subs.map((spec) => {
      const [sub, extra] = typeof spec === "string" ? [spec, {}] : spec;
      const kind =
        sub === "primary"
          ? ({ type: "boolean" } as const)
          : sub === "$ref"
            ? ({ type: "reference" } as const)
            : {};
      const subFacts: AttrFacts = { ...PLAIN, mutability: own.mutability, ...kind, ...extra };
      return [asciiLower(sub), { name: sub, boolean: sub === "primary", facts: subFacts }];
    }),
  );
  return { ...text(name), subs: map, filter, facts: own };
}

function readOnly(name: string, noPath: AttrRule["noPath"]): AttrRule {
  return {
    ...text(name, null),
    refuse: { scimType: "mutability", detail: `${name} is read-only` },
    noPath,
  };
}

/** The sub-attributes of a multi-valued attribute, with the canonical values of its `type`. */
function multi(types: readonly string[] | null, value: Partial<AttrFacts> = {}): SubSpec[] {
  return [
    ["value", value],
    "display",
    types === null ? "type" : ["type", { canonicalValues: types }],
    "primary",
  ];
}

// The core User schema (RFC 7643 sections 3.1 and 4.1). `userName`,
// `externalId`, and `active` are columns, and `password` is refused. Every
// other attribute of this table goes into `scimUser.data` (Task 10 Behavior 1).
export const USER_RULES = rules([
  text("userName", { required: true, uniqueness: "server" }),
  text("externalId", null),
  complex(
    "name",
    ["formatted", "familyName", "givenName", "middleName", "honorificPrefix", "honorificSuffix"],
    null,
  ),
  text("displayName"),
  text("nickName"),
  text("profileUrl", { type: "reference", referenceTypes: ["external"] }),
  text("title"),
  text("userType"),
  text("preferredLanguage"),
  text("locale"),
  text("timezone"),
  flag("active"),
  complex("emails", multi(["work", "home", "other"]), "type", { multiValued: true }),
  complex("phoneNumbers", multi(["work", "home", "mobile", "fax", "pager", "other"]), "type", {
    multiValued: true,
  }),
  complex("ims", multi(["aim", "gtalk", "icq", "xmpp", "msn", "skype", "qq", "yahoo"]), "type", {
    multiValued: true,
  }),
  complex(
    "photos",
    multi(["photo", "thumbnail"], { type: "reference", referenceTypes: ["external"] }),
    "type",
    { multiValued: true },
  ),
  // Section 8.7.1 lists no primary here; section 8.2 sends one, so core reads it as on the others.
  complex(
    "addresses",
    [
      "formatted",
      "streetAddress",
      "locality",
      "region",
      "postalCode",
      "country",
      ["type", { canonicalValues: ["work", "home", "other"] }],
      "primary",
    ],
    "type",
    { multiValued: true },
  ),
  complex("entitlements", multi(null), "type", { multiValued: true }),
  complex("roles", multi(null), "type", { multiValued: true }),
  complex("x509Certificates", multi(null, { type: "binary" }), "type", { multiValued: true }),
  // The ServiceProviderConfig says changePassword.supported is false.
  {
    ...text("password", null),
    refuse: { scimType: "invalidValue", detail: "password is not supported" },
  },
  // Task 10 Behavior 1 (RFC 7643 section 2.2): id, meta, and groups in a
  // request are ignored. A path that names one still answers mutability.
  readOnly("id", "id"),
  readOnly("meta", "ignore"),
  readOnly("schemas", "path"),
  // The Schema lists groups with its sub-attributes; the parser refuses a path to it first.
  {
    ...complex(
      "groups",
      [
        "value",
        ["$ref", { referenceTypes: ["User", "Group"] }],
        "display",
        ["type", { canonicalValues: ["direct", "indirect"] }],
      ],
      null,
      { multiValued: true, mutability: "readOnly" },
    ),
    refuse: { scimType: "mutability", detail: "groups is read-only" },
    noPath: "ignore",
  },
]);

// The enterprise User extension (RFC 7643 section 4.3), read only as `<URN>:attr`.
// manager is the complex attribute of section 4.3 (ruling 24, i5): the id of
// the manager's User, its `$ref`, and its read-only `displayName`. The Schema
// document follows this table.
export const ENTERPRISE_RULES = rules([
  text("employeeNumber"),
  text("costCenter"),
  text("organization"),
  text("division"),
  text("department"),
  complex(
    "manager",
    ["value", ["$ref", { referenceTypes: ["User"] }], ["displayName", { mutability: "readOnly" }]],
    null,
  ),
]);

// The core Group schema (RFC 7643 section 4.2).
// Section 4.2 makes displayName REQUIRED, where section 8.7.1 says false.
// Core needs it and holds it unique in the organization, so the Schema
// says required and server (Task 9b question Q3). Section 8.7.1 lists no
// members.display; it takes the immutable facts of its siblings.
export const GROUP_RULES = rules([
  text("displayName", { required: true, uniqueness: "server" }),
  text("externalId", null),
  complex(
    "members",
    [
      ["value", { mutability: "immutable" }],
      ["display", { mutability: "immutable" }],
      ["type", { mutability: "immutable", canonicalValues: ["User", "Group"] }],
      ["$ref", { mutability: "immutable", referenceTypes: ["User", "Group"] }],
    ],
    "value",
    { multiValued: true },
  ),
  readOnly("id", "id"),
  readOnly("meta", "ignore"),
  readOnly("schemas", "path"),
]);

function rulesOf(resource: "User" | "Group"): ReadonlyMap<string, AttrRule> {
  return resource === "User" ? USER_RULES : GROUP_RULES;
}

const ENTERPRISE_PREFIX = `${asciiLower(NS_SCIM_ENTERPRISE)}:`;
const MANAGER = "manager";
const BODY_KEYS = new Set(["schemas", "Operations"]);
const OP_KEYS = new Set(["op", "path", "value"]);

function refuse(scimType: ScimType, detail: string): Refusal {
  return { ok: false, status: SCIM_ERRORS[scimType], scimType, detail };
}

function tooManyOps(): Refusal {
  return refuse("invalidValue", `the operations hold more than ${PATCH_OPS_MAX} changes`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function depthAtMost(v: unknown, max: number): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (max === 0) return false;
  const children = Array.isArray(v) ? v : Object.values(v);
  return children.every((c) => depthAtMost(c, max - 1));
}

type Target = { ok: true; path: PatchPath; boolean: boolean };

/** Reads one path: `attr`, `attr.sub`, `<URN>:attr`, `attr[<filter> eq "..."]`, or `attr[type eq "..."].sub`. */
function readPath(path: string, resource: "User" | "Group"): Target | Refusal {
  const bad = refuse("invalidPath", "the path is not one that this server reads");
  if (path.length === 0 || path.length > PATCH_PATH_MAX) return bad;
  // Entra ID sends the bare path `manager` (ruling 55 of plan 12d). The core
  // User has no such attribute, so it names the manager of the extension.
  const enterprise =
    resource === "User" && asciiLower(path) === MANAGER
      ? `${ENTERPRISE_PREFIX}${MANAGER}`
      : asciiLower(path);
  if (resource === "User" && enterprise.startsWith(ENTERPRISE_PREFIX)) {
    const rule = ENTERPRISE_RULES.get(enterprise.slice(ENTERPRISE_PREFIX.length));
    if (rule === undefined) return bad;
    return {
      ok: true,
      path: { attr: `${NS_SCIM_ENTERPRISE}:${rule.name}`, sub: null, filter: null },
      boolean: false,
    };
  }
  const dot = path.indexOf(".");
  const open = path.indexOf("[");
  const cut = open >= 0 && (dot < 0 || open < dot) ? open : dot;
  const rule = rulesOf(resource).get(asciiLower(cut < 0 ? path : path.slice(0, cut)));
  if (rule === undefined) return bad;
  if (rule.refuse !== null) return refuse(rule.refuse.scimType, rule.refuse.detail);
  if (cut < 0)
    return { ok: true, path: { attr: rule.name, sub: null, filter: null }, boolean: rule.boolean };
  let filter: { attr: string; value: string } | null = null;
  let rest = path.slice(cut);
  if (cut === open) {
    // An index (`emails[0]`) or any filter but the one of the rule fails here.
    if (rule.filter === null) return bad;
    const space = path.indexOf(" ", open + 1);
    if (space < 0 || asciiLower(path.slice(open + 1, space)) !== rule.filter) return bad;
    if (asciiLower(path.slice(space, space + 4)) !== " eq ") return bad;
    const literal = readJsonString(path, space + 4);
    if (literal === null || path[literal.end] !== "]") return bad;
    filter = { attr: rule.filter, value: literal.value };
    rest = path.slice(literal.end + 1);
    if (rest === "")
      return { ok: true, path: { attr: rule.name, sub: null, filter }, boolean: false };
    if (rule.filter !== "type") return bad;
  }
  if (!rest.startsWith(".") || rule.subs === null) return bad;
  const sub = rule.subs.get(asciiLower(rest.slice(1)));
  if (sub === undefined) return bad;
  return { ok: true, path: { attr: rule.name, sub: sub.name, filter }, boolean: sub.boolean };
}

/**
 * True when a key of the no-path form names an attribute of the User
 * schema or of the enterprise extension: the name before any `.` or `[`.
 * A key of a known attribute keeps the path rules of `readPath`. The
 * enterprise URN alone counts as known, so its refusal stays.
 */
function namesUserAttribute(key: string): boolean {
  const lower = asciiLower(key);
  if (`${lower}:` === ENTERPRISE_PREFIX) return true;
  const enterprise = lower.startsWith(ENTERPRISE_PREFIX);
  const rest = enterprise ? lower.slice(ENTERPRISE_PREFIX.length) : lower;
  const name = /^[^.[]*/.exec(rest)?.[0] ?? "";
  return (enterprise ? ENTERPRISE_RULES : USER_RULES).has(name);
}

/**
 * Reads the value of a boolean target. Entra ID sends `"True"` and `"False"`
 * as text (its SCIM docs); RFC 7644 section 3.5.2 gives the value the type of
 * the attribute, so core reads these two texts as the booleans, and no other.
 */
function readBoolean(value: unknown): boolean | null {
  if (value === true || value === "True") return true;
  if (value === false || value === "False") return false;
  return null;
}

function target(
  op: PatchOp["op"],
  path: string,
  value: unknown,
  resource: "User" | "Group",
): PatchOp | Refusal {
  const t = readPath(path, resource);
  if (!t.ok) return t;
  // The PATCH sample of "Develop a SCIM endpoint" (Microsoft Learn, read
  // 2026-10-22) sends the manager as a list of one object. RFC 7643 section
  // 4.3 makes manager one complex value, so core reads that one object.
  const one =
    t.path.attr === `${NS_SCIM_ENTERPRISE}:${MANAGER}` &&
    t.path.sub === null &&
    Array.isArray(value) &&
    value.length === 1 &&
    isObject(value[0])
      ? value[0]
      : value;
  if (op === "remove" || !t.boolean) return { op, path: t.path, value: one };
  const flagValue = readBoolean(value);
  if (flagValue === null) return refuse("invalidValue", "a boolean attribute takes true or false");
  return { op, path: t.path, value: flagValue };
}

/**
 * Reads a PatchOp message into its operations, or answers the SCIM refusal.
 * `id` is the `id` key of the no-path form, or null when no operation sends
 * one. The caller answers 400 `mutability` only when `id` differs from the id
 * of the target resource. An id that is not a text, or a second id that
 * differs from the first, answers `mutability` here.
 */
export function parsePatch(
  body: unknown,
  resource: "User" | "Group",
):
  | { ok: true; ops: PatchOp[]; id: string | null }
  | { ok: false; status: number; scimType: ScimType; detail: string } {
  if (!isObject(body)) return refuse("invalidSyntax", "the body is not a PatchOp message");
  if (!Object.keys(body).every((k) => BODY_KEYS.has(k))) {
    return refuse("invalidSyntax", "the body holds a key other than schemas and Operations");
  }
  const schemas = body.schemas;
  if (!Array.isArray(schemas) || schemas.length !== 1 || schemas[0] !== NS_SCIM_PATCH_OP) {
    return refuse("invalidSyntax", "schemas must be the PatchOp URN alone");
  }
  const list = body.Operations;
  // A body with no list of operations does not fit the PatchOp schema.
  if (!Array.isArray(list)) return refuse("invalidSyntax", "Operations must be a list");
  if (list.length === 0 || list.length > PATCH_OPS_MAX) {
    return refuse("invalidValue", `Operations must hold 1 to ${PATCH_OPS_MAX} operations`);
  }
  const ops: PatchOp[] = [];
  let id: string | null = null;
  for (const [i, entry] of list.entries()) {
    if (!isObject(entry) || !Object.keys(entry).every((k) => OP_KEYS.has(k))) {
      return refuse("invalidSyntax", `operation ${i} is not an object of op, path, and value`);
    }
    const name = typeof entry.op === "string" ? asciiLower(entry.op) : null;
    // RFC 7644 section 3.5.2 names add, remove, and replace. The JSON Patch
    // ops move and copy have no SCIM path form, so the path is the fault.
    // Entra ID sends the op with a capital (`Replace`), so the op is read in any case.
    if (name === "move" || name === "copy")
      return refuse("invalidPath", `operation ${i}: ${name} is not supported`);
    if (name !== "add" && name !== "remove" && name !== "replace") {
      return refuse("invalidSyntax", `operation ${i}: op must be add, remove, or replace`);
    }
    const hasValue = Object.hasOwn(entry, "value");
    if (name !== "remove" && !hasValue)
      return refuse("invalidValue", `operation ${i}: ${name} needs a value`);
    const value = hasValue ? entry.value : null;
    if (!depthAtMost(value, PATCH_VALUE_DEPTH_MAX))
      return refuse("invalidValue", `operation ${i}: the value is too deep`);
    if (Object.hasOwn(entry, "path")) {
      if (typeof entry.path !== "string")
        return refuse("invalidPath", `operation ${i}: the path must be a text`);
      const op = target(name, entry.path, value, resource);
      if ("ok" in op) return { ...op, detail: `operation ${i}: ${op.detail}` };
      ops.push(op);
    } else {
      // RFC 7644 section 3.5.2.2: a remove with no path fails with noTarget.
      if (name === "remove") return refuse("noTarget", `operation ${i}: remove needs a path`);
      // RFC 7644 sections 3.5.2.1 and 3.5.2.3: with no path, the value is an
      // object of attributes. Entra ID sends this form, and core reads each
      // key as the path of one operation.
      if (!isObject(value) || Object.keys(value).length === 0) {
        return refuse(
          "invalidValue",
          `operation ${i}: with no path, the value must be an object of attributes`,
        );
      }
      for (const [key, part] of Object.entries(value)) {
        // Okta sends the group id in the no-path form of a group rename (its
        // SCIM 2.0 protocol reference). RFC 7643 section 2.2 lets a server
        // ignore a read-only attribute in a request, so core takes the id out
        // and hands it to the caller.
        const noPath = rulesOf(resource).get(asciiLower(key))?.noPath;
        if (noPath === "ignore") continue;
        if (noPath === "id") {
          if (typeof part !== "string" || (id !== null && part !== id))
            return refuse("mutability", `operation ${i}: id is read-only`);
          id = part;
          continue;
        }
        // A key that names no attribute of the User schema is ignored, as POST
        // and PUT ignore it (ruling 50 of plan 12d). Entra ID sends this form
        // with the attributes of its own map. A path to it stays invalidPath.
        if (resource === "User" && !namesUserAttribute(key)) continue;
        const op = target(name, key, part, resource);
        if ("ok" in op) return { ...op, detail: `operation ${i}: ${op.detail}` };
        ops.push(op);
        // One value can hold many keys, so the parser stops at the bound here.
        if (ops.length > PATCH_OPS_MAX) return tooManyOps();
      }
    }
    if (ops.length > PATCH_OPS_MAX) return tooManyOps();
  }
  return { ok: true, ops, id };
}
