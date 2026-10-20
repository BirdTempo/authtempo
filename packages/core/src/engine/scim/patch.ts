/**
 * The SCIM PATCH parser (plan 12d Task 10 Behavior 8, RFC 7644 section
 * 3.5.2). The body comes from a directory, so the parser bounds the count of
 * operations, the length of a path, and the depth of a value, and it knows
 * each attribute by name. A form that the plan does not name is refused, never
 * ignored. The parser reads only; the caller applies the operations to a copy
 * and writes once.
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
export const NS_SCIM_ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

/** The most operations of one PATCH, after the no-path form gives one per key. */
export const PATCH_OPS_MAX = 100;
/** The longest path. The longest path that core names is under 80 characters. */
export const PATCH_PATH_MAX = 256;
/** The deepest value: a no-path value with `members`, a list of objects, is 3 levels. */
export const PATCH_VALUE_DEPTH_MAX = 3;

interface SubRule {
  readonly name: string;
  readonly boolean: boolean;
}

interface AttrRule {
  readonly name: string;
  readonly boolean: boolean;
  readonly subs: ReadonlyMap<string, SubRule> | null;
  // The one filter attribute of `attr[<filter> eq "..."]`. Only a `type`
  // filter takes a sub-attribute after it.
  readonly filter: "type" | "value" | null;
  // A known attribute that a PATCH must not change.
  readonly refuse: { scimType: ScimType; detail: string } | null;
}

function rules(list: AttrRule[]): ReadonlyMap<string, AttrRule> {
  return new Map(list.map((r) => [asciiLower(r.name), r]));
}

function text(name: string): AttrRule {
  return { name, boolean: false, subs: null, filter: null, refuse: null };
}

function flag(name: string): AttrRule {
  return { name, boolean: true, subs: null, filter: null, refuse: null };
}

function complex(name: string, subs: string[], filter: "type" | "value" | null): AttrRule {
  const map = new Map(subs.map((s) => [asciiLower(s), { name: s, boolean: s === "primary" }]));
  return { name, boolean: false, subs: map, filter, refuse: null };
}

function readOnly(name: string): AttrRule {
  return { ...text(name), refuse: { scimType: "mutability", detail: `${name} is read-only` } };
}

const MULTI_SUBS = ["value", "display", "type", "primary"];

// The core User schema (RFC 7643 sections 3.1 and 4.1). Every attribute but
// the read-only ones goes into `scimUser.data` (Task 10 Behavior 1).
const USER_RULES = rules([
  text("userName"),
  text("externalId"),
  complex(
    "name",
    ["formatted", "familyName", "givenName", "middleName", "honorificPrefix", "honorificSuffix"],
    null,
  ),
  text("displayName"),
  text("nickName"),
  text("profileUrl"),
  text("title"),
  text("userType"),
  text("preferredLanguage"),
  text("locale"),
  text("timezone"),
  flag("active"),
  complex("emails", MULTI_SUBS, "type"),
  complex("phoneNumbers", MULTI_SUBS, "type"),
  complex("ims", MULTI_SUBS, "type"),
  complex("photos", MULTI_SUBS, "type"),
  complex(
    "addresses",
    [
      "formatted",
      "streetAddress",
      "locality",
      "region",
      "postalCode",
      "country",
      "type",
      "primary",
    ],
    "type",
  ),
  complex("entitlements", MULTI_SUBS, "type"),
  complex("roles", MULTI_SUBS, "type"),
  complex("x509Certificates", MULTI_SUBS, "type"),
  // The ServiceProviderConfig says changePassword.supported is false.
  {
    ...text("password"),
    refuse: { scimType: "invalidValue", detail: "password is not supported" },
  },
  readOnly("id"),
  readOnly("meta"),
  readOnly("schemas"),
  readOnly("groups"),
]);

// The enterprise User extension (RFC 7643 section 4.3), read only as `<URN>:attr`.
const ENTERPRISE_RULES = rules([
  text("employeeNumber"),
  text("costCenter"),
  text("organization"),
  text("division"),
  text("department"),
  text("manager"),
]);

// The core Group schema (RFC 7643 section 4.2).
const GROUP_RULES = rules([
  text("displayName"),
  text("externalId"),
  complex("members", ["value", "display", "type", "$ref"], "value"),
  readOnly("id"),
  readOnly("meta"),
  readOnly("schemas"),
]);

const ENTERPRISE_PREFIX = `${asciiLower(NS_SCIM_ENTERPRISE)}:`;
const BODY_KEYS = new Set(["schemas", "Operations"]);
const OP_KEYS = new Set(["op", "path", "value"]);

function refuse(scimType: ScimType, detail: string): Refusal {
  return { ok: false, status: SCIM_ERRORS[scimType], scimType, detail };
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
  if (resource === "User" && asciiLower(path).startsWith(ENTERPRISE_PREFIX)) {
    const rule = ENTERPRISE_RULES.get(asciiLower(path.slice(ENTERPRISE_PREFIX.length)));
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
  const rule = (resource === "User" ? USER_RULES : GROUP_RULES).get(
    asciiLower(cut < 0 ? path : path.slice(0, cut)),
  );
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
  if (op === "remove" || !t.boolean) return { op, path: t.path, value };
  const flagValue = readBoolean(value);
  if (flagValue === null) return refuse("invalidValue", "a boolean attribute takes true or false");
  return { op, path: t.path, value: flagValue };
}

/** Reads a PatchOp message into its operations, or answers the SCIM refusal. */
export function parsePatch(
  body: unknown,
  resource: "User" | "Group",
):
  | { ok: true; ops: PatchOp[] }
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
  if (!Array.isArray(list) || list.length === 0 || list.length > PATCH_OPS_MAX) {
    return refuse("invalidValue", `Operations must hold 1 to ${PATCH_OPS_MAX} operations`);
  }
  const ops: PatchOp[] = [];
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
        const op = target(name, key, part, resource);
        if ("ok" in op) return { ...op, detail: `operation ${i}: ${op.detail}` };
        ops.push(op);
      }
    }
    if (ops.length > PATCH_OPS_MAX)
      return refuse("invalidValue", `the operations hold more than ${PATCH_OPS_MAX} changes`);
  }
  return { ok: true, ops };
}
