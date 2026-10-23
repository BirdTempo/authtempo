import { SCIM_SCOPES } from "@authtempo/core";
import type { ScimMarkerOptions, SsoOptions } from "../types.js";

// The option rules of `sso` and `scim` (plan 12d Task 14). The keys come
// from @better-auth/sso 1.7.2's SSOOptions (index-sM6JWXeV.d.mts:320) and
// @better-auth/scim 1.7.2's SCIMOptions (dist/index.d.mts:336), read
// 2026-10-22. Each key maps onto core, is a note, or is refused with its reason.

/** The refusals and notes of one plugin, as `<path>: <reason>`. checkOptions merges them. */
export interface SsoCheck {
  refusals: string[];
  notes: string[];
}

/** Spec 30: the section that each refusal of the two maps names. */
const SPEC = "(spec 30)";
/** Better Auth's default clock skew, 5 minutes (dist/index.mjs:53). Core takes at most 300 seconds. */
export const BETTER_AUTH_CLOCK_SKEW_MS = 300_000;
/** Better Auth's default and core's cap of a SAML Response: 256 KB (dist/index.mjs:58). */
export const SAML_RESPONSE_MAX = 262_144;
/** Better Auth's default prefix of the record of a domain proof (dist/index.mjs:2502). */
export const DEFAULT_TOKEN_PREFIX = "better-auth-token";
/** The form of a SCIM connection id and a credential id: the audit actor name of its writes. */
const SCIM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** One DNS label part: the token prefix sits in `_<prefix>-<providerId>`. */
const PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

type Visit = (value: unknown, path: string, out: SsoCheck) => void;

const refuse = (out: SsoCheck, path: string, why: string) => out.refusals.push(`${path}: ${why}`);
const note = (out: SsoCheck, path: string, why: string) => out.notes.push(`${path}: ${why}`);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function object(rules: Record<string, Visit>): Visit {
  return (value, path, out) => {
    if (!isObject(value)) {
      refuse(out, path, "expected an object");
      return;
    }
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const rule = rules[key];
      if (rule) rule(v, `${path}.${key}`, out);
      else refuse(out, `${path}.${key}`, "authtempo has no such option");
    }
  };
}
const only =
  (accepted: unknown, why: string): Visit =>
  (v, p, out) => {
    if (v !== accepted) refuse(out, p, why);
  };
const refused =
  (why: string): Visit =>
  (_v, p, out) =>
    refuse(out, p, why);
const noted =
  (why: string): Visit =>
  (_v, p, out) =>
    note(out, p, why);
const boolean: Visit = (v, p, out) => {
  if (typeof v !== "boolean") refuse(out, p, "expected a boolean");
};

const NO_SLO = `core has no SAML single logout ${SPEC}`;
const NO_IDP_START = `core refuses a Response that no request of this browser binds ${SPEC}`;
const OWN_TABLE =
  "core keeps connections in its own table; copyBetterAuthSso reads the Better Auth table by the names of betterAuthSchemaStorage";

const ssoRules = object({
  resolveUser: refused(
    `core resolves the user by the verified domain and the identity; an app resolver is not mapped ${SPEC}`,
  ),
  guardProviderMutation: refused(
    `core runs its manager guard on each change of a connection; an app guard is not mapped ${SPEC}`,
  ),
  provisionUser: (v, p, out) => {
    if (typeof v !== "function") refuse(out, p, "expected a function");
    else
      note(
        out,
        p,
        "runs as hooks.sso.beforeSignIn, before the first write; user is null for a new user, and no IdP token is passed",
      );
  },
  provisionUserOnEveryLogin: boolean,
  organizationProvisioning: object({
    disabled: only(
      false,
      `core adds the member of the connection's organization at each SSO sign-in ${SPEC}`,
    ),
    defaultRole: (v, p, out) => {
      if (v !== "member" && v !== "admin") refuse(out, p, 'expected "member" or "admin"');
    },
    getRole: refused(
      `core gives one role per connection; a role per user comes from the SCIM role map ${SPEC}`,
    ),
  }),
  defaultSSO: refused(
    `core keeps each connection in its own table; register it through /sso/register ${SPEC}`,
  ),
  defaultOverrideUserInfo: only(false, `core keeps the profile of a user that exists ${SPEC}`),
  disableImplicitSignUp: boolean,
  modelName: refused(OWN_TABLE),
  fields: refused(OWN_TABLE),
  schema: refused(OWN_TABLE),
  providersLimit: (v, p, out) => {
    if (typeof v === "function") refuse(out, p, "a function is refused; pass a positive integer");
    else if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
      refuse(out, p, "expected a positive integer");
  },
  trustEmailVerified: only(
    false,
    `the domain proof is the only proof of an address; core reads no email_verified ${SPEC}`,
  ),
  domainVerification: object({
    enabled: only(true, `core proves each domain by DNS before it routes a sign-in ${SPEC}`),
    tokenPrefix: (v, p, out) => {
      if (typeof v !== "string" || !PREFIX_RE.test(v))
        refuse(out, p, "core takes 1 to 41 lower-case letters, digits, and inner hyphens");
    },
  }),
  redirectURI: refused(
    `core gives each connection its own callback, <basePath>/sso/<connectionId>/callback; a shared callback is refused ${SPEC}`,
  ),
  resolvePrivateKey: refused(`core sends the client secret; private_key_jwt is refused ${SPEC}`),
  saml: object({
    enableInResponseToValidation: only(true, `core binds each Response to its request ${SPEC}`),
    allowIdpInitiated: only(false, NO_IDP_START),
    requestTTL: noted("core keeps a SAML request for its own fixed time"),
    clockSkew: (v, p, out) => {
      if (
        typeof v !== "number" ||
        !Number.isSafeInteger(v) ||
        v < 0 ||
        v > BETTER_AUTH_CLOCK_SKEW_MS ||
        v % 1000 !== 0
      )
        refuse(out, p, "core takes whole seconds from 0 to 300000 ms");
    },
    requireTimestamps: boolean,
    algorithms: object({
      onDeprecated: only("reject", `core refuses SHA-1 and every deprecated algorithm ${SPEC}`),
      allowedSignatureAlgorithms: refused(`core keeps its own list of algorithms ${SPEC}`),
      allowedDigestAlgorithms: refused(`core keeps its own list of algorithms ${SPEC}`),
      allowedKeyEncryptionAlgorithms: refused(`core takes no encrypted assertion ${SPEC}`),
      allowedDataEncryptionAlgorithms: refused(`core takes no encrypted assertion ${SPEC}`),
    }),
    maxResponseSize: (v, p, out) => {
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > SAML_RESPONSE_MAX)
        refuse(out, p, `core caps a SAML Response at ${SAML_RESPONSE_MAX} bytes`);
    },
    maxMetadataSize: noted("core caps the IdP metadata at its own size"),
    enableSingleLogout: only(false, NO_SLO),
    logoutRequestTTL: refused(NO_SLO),
    wantLogoutRequestSigned: refused(NO_SLO),
    wantLogoutResponseSigned: refused(NO_SLO),
    idpInitiatedCallbackUrl: refused(NO_IDP_START),
  }),
});

/** The checks of `sso(options)`. */
export function checkSso(options: SsoOptions, out: SsoCheck): void {
  ssoRules(options, "plugins[sso]", out);
  if (options.domainVerification?.enabled !== true)
    note(
      out,
      "plugins[sso].domainVerification",
      "not enabled: core still proves each domain by DNS before it routes a sign-in",
    );
}

/** One SCIM credential: a bearer with the hash of its token, a known id, and the four scopes at most. */
const credential: Visit = (v, p, out) => {
  if (!isObject(v)) {
    refuse(out, p, "expected an object");
    return;
  }
  for (const [key, value] of Object.entries(v)) {
    if (value === undefined) continue;
    const path = `${p}.${key}`;
    if (key === "type") {
      if (value !== "bearer") refuse(out, path, 'expected "bearer"');
    } else if (key === "id") {
      if (typeof value !== "string" || !SCIM_ID_RE.test(value))
        refuse(out, path, "core takes 1 to 64 letters, digits, _, ., and -");
    } else if (key === "tokenHash") {
      if (value === null) refuse(out, `${p}.token`, "expected a non-empty string");
    } else if (key === "scopes") {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        new Set(value).size !== value.length ||
        !value.every((s) => (SCIM_SCOPES as readonly unknown[]).includes(s))
      )
        refuse(out, path, `expected distinct scopes of ${SCIM_SCOPES.join(", ")}`);
    } else if (key === "expiresAt") {
      if (!(value instanceof Date) || Number.isNaN(value.getTime()))
        refuse(out, path, "expected a Date");
    } else refuse(out, path, "authtempo has no such option");
  }
  if (v.type === undefined) refuse(out, `${p}.type`, "required");
  if (v.id === undefined) refuse(out, `${p}.id`, "required");
  if (!("tokenHash" in v)) refuse(out, `${p}.token`, "required");
};

/** The checks of `scim(options)`, on the marker's options: each token is a hash there. */
export function checkScim(options: ScimMarkerOptions, out: SsoCheck): void {
  const p = "plugins[scim]";
  object({
    connections: (v, path, o) => {
      if (!Array.isArray(v)) {
        refuse(o, path, "expected a list");
        return;
      }
      const ids = new Set<string>();
      const hashes = new Set<string>();
      v.forEach((c: unknown, i) => {
        const cp = `${path}[${i}]`;
        if (!isObject(c)) {
          refuse(o, cp, "expected an object");
          return;
        }
        for (const key of Object.keys(c))
          if (!["id", "credentials", "provisioningDomainId"].includes(key) && c[key] !== undefined)
            refuse(o, `${cp}.${key}`, "authtempo has no such option");
        if (typeof c.id !== "string" || !SCIM_ID_RE.test(c.id))
          refuse(o, `${cp}.id`, "core takes 1 to 64 letters, digits, _, ., and -");
        else if (ids.has(c.id)) refuse(o, `${cp}.id`, "given twice; pass one");
        else ids.add(c.id);
        if (c.provisioningDomainId !== undefined && typeof c.provisioningDomainId !== "string")
          refuse(o, `${cp}.provisioningDomainId`, "expected the id of an organization");
        if (!Array.isArray(c.credentials) || c.credentials.length === 0) {
          refuse(o, `${cp}.credentials`, "expected a list of one credential or more");
          return;
        }
        const credentialIds = new Set<unknown>();
        c.credentials.forEach((k: unknown, j) => {
          const kp = `${cp}.credentials[${j}]`;
          credential(k, kp, o);
          if (!isObject(k)) return;
          if (credentialIds.has(k.id)) refuse(o, `${kp}.id`, "given twice; pass one");
          credentialIds.add(k.id);
          if (typeof k.tokenHash === "string") {
            if (hashes.has(k.tokenHash)) refuse(o, `${kp}.token`, "the same token is given twice");
            hashes.add(k.tokenHash);
          }
        });
      });
    },
    authentication: refused(
      `core checks a SCIM bearer itself: a credential of connections or a core SCIM token ${SPEC}`,
    ),
    managedConnections: refused(
      `core's SCIM tokens replace it: api.scim.tokens and the /scim/tokens routes ${SPEC}`,
    ),
    identity: refused(
      `core links a SCIM user by the verified domain of the address; explicit linking is refused ${SPEC}`,
    ),
    projection: refused(
      `core maps groups by its own role map and teams (scim.groups); a projection is code that core cannot run ${SPEC}`,
    ),
    compatibility: object({
      microsoftEntra: object({
        acceptLegacyGroupSchema: (v, path, o) => {
          if (typeof v !== "boolean") refuse(o, path, "expected a boolean");
          else note(o, path, "accepted: core accepts the shapes of Microsoft Entra ID always");
        },
      }),
    }),
  })(options, p, out);
  if (options.connections === undefined) refuse(out, `${p}.connections`, "required");
}
