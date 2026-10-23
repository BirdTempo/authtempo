import type { Auth, SsoConnectionSummary, SsoDomainSummary } from "@authtempo/core";
import { scimRequestAs, verifyDomainByRecord } from "@authtempo/core/compat";
import { sha256 } from "@noble/hashes/sha2.js";
import { BETTER_AUTH_CODES, messageOf } from "../errors.js";
import { equalHex, toHex } from "../hash.js";
import type { Mapped } from "./map-options.js";
import { PROVIDER_ID_RE, verificationIdentifier } from "./map-options.js";

// The paths of @better-auth/sso and @better-auth/scim 1.7.2 on core's SSO
// and SCIM routes (plan 12d Task 14, ruling 61 P1, P4, P5, P7, F6). Each
// path finds the connection by its label, which holds the Better Auth
// providerId. Then it calls core's manager routes with the caller's own
// headers, so core's session, limiter, manager guard, and audit row hold.
// The paths and the bodies were read in the 1.7.2 tarball on 2026-10-22
// (index-sM6JWXeV.d.mts:683 to :1600 and dist/index.mjs:2502 to :3530).

/** The NameID format that core asks for when no attribute names the subject (core saml-sp.ts). */
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
/** The signature and digest methods that core verifies (core saml/dsig.ts). */
const SIGNATURE_METHODS = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
]);
const DIGEST_METHODS = new Set(["http://www.w3.org/2001/04/xmlenc#sha256"]);
const SHA1 = /sha1$/;
/**
 * The start of the value of core's own TXT record (core engine/sso/domains.ts
 * DOMAIN_VALUE_PREFIX). The token of Better Auth's record is the rest. A
 * test pins the two forms against a domain that core adds.
 */
const CORE_VALUE_PREFIX = "authtempo-domain=";
const DNS_LABEL_MAX = 63;
/** The organizations of one caller that `GET /sso/providers` reads. */
const PROVIDER_ORGANIZATIONS_MAX = 100;

type Json = Record<string, unknown>;
type Refusal = { status: number; code: string; message: string };
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A field that core has no feature for: 501 NOT_SUPPORTED, with the path and the reason. */
const unsupported = (path: string, why: string): Refusal => ({
  status: 501,
  code: "NOT_SUPPORTED",
  message: `${path}: ${why}`,
});
/** A field of the wrong type: 400 VALIDATION_ERROR, with the path. */
const invalid = (path: string, why: string): Refusal => ({
  status: 400,
  code: BETTER_AUTH_CODES.invalid_body,
  message: `${path}: ${why}`,
});

/** The core fields of one provider body, or the first refusal. */
type Fields = { ok: true; fields: Json } | { ok: false; refusal: Refusal };

/**
 * The OIDC config of a register or an update (ruling 61 P1). `current` is
 * the connection of an update: its endpoints fill a partial set.
 */
function oidcFields(
  issuer: string | undefined,
  o: Json,
  current: SsoConnectionSummary["oidc"] | null,
): Fields {
  const out: Json = {};
  const p = "oidcConfig";
  const endpointKeys = ["authorizationEndpoint", "tokenEndpoint", "jwksEndpoint"] as const;
  for (const [key, v] of Object.entries(o)) {
    if (v === undefined) continue;
    const path = `${p}.${key}`;
    switch (key) {
      case "clientId":
      case "clientSecret":
        if (typeof v !== "string" || v === "")
          return { ok: false, refusal: invalid(path, "expected a non-empty string") };
        out[key] = v;
        break;
      case "skipDiscovery":
        if (typeof v !== "boolean")
          return { ok: false, refusal: invalid(path, "expected a boolean") };
        break;
      case "authorizationEndpoint":
      case "tokenEndpoint":
      case "jwksEndpoint":
        if (typeof v !== "string") return { ok: false, refusal: invalid(path, "expected a URL") };
        break;
      case "discoveryEndpoint": {
        const base = issuer ?? current?.issuer;
        if (
          base === undefined ||
          v !== `${base.replace(/\/$/, "")}/.well-known/openid-configuration`
        )
          return {
            ok: false,
            refusal: unsupported(
              path,
              "core reads the discovery document at <issuer>/.well-known/openid-configuration only",
            ),
          };
        break;
      }
      case "scopes":
        if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s !== ""))
          return { ok: false, refusal: invalid(path, "expected a list of scopes") };
        out.scope = v.join(" ");
        break;
      case "pkce":
        if (v !== true)
          return {
            ok: false,
            refusal: unsupported(path, "core sends PKCE with S256 at every start"),
          };
        break;
      case "tokenEndpointAuthentication":
        if (v !== "client_secret_post")
          return {
            ok: false,
            refusal: unsupported(
              path,
              "core sends the client secret in the token request body (client_secret_post); set the IdP client to it",
            ),
          };
        break;
      case "overrideUserInfo":
        if (v !== false)
          return {
            ok: false,
            refusal: unsupported(path, "core keeps the profile of a user that exists"),
          };
        break;
      case "mapping": {
        const m = mappingRefusal(path, v, { email: "email", name: "name", image: "picture" });
        if (m) return { ok: false, refusal: m };
        break;
      }
      case "userInfoEndpoint":
        return {
          ok: false,
          refusal: unsupported(
            path,
            "core reads the claims of the verified ID token; it calls no userinfo endpoint",
          ),
        };
      case "privateKeyId":
      case "privateKeyAlgorithm":
        return {
          ok: false,
          refusal: unsupported(path, "core sends the client secret; private_key_jwt is refused"),
        };
      case "allowIdpInitiated":
        if (v !== false)
          return {
            ok: false,
            refusal: unsupported(path, "core binds each callback to the start of this browser"),
          };
        break;
      default:
        return { ok: false, refusal: unsupported(path, "authtempo has no such field") };
    }
  }
  // Core takes the three endpoints together, or none, and then reads the discovery document.
  const given = endpointKeys.filter((k) => typeof o[k] === "string");
  if (given.length > 0) {
    const was = current?.endpoints ?? null;
    const at = (k: (typeof endpointKeys)[number], from: keyof NonNullable<typeof was>) =>
      typeof o[k] === "string" ? (o[k] as string) : (was?.[from] ?? null);
    const authorizeUrl = at("authorizationEndpoint", "authorizeUrl");
    const tokenUrl = at("tokenEndpoint", "tokenUrl");
    const jwksUrl = at("jwksEndpoint", "jwksUrl");
    if (authorizeUrl === null || tokenUrl === null || jwksUrl === null)
      return {
        ok: false,
        refusal: unsupported(
          `${p}.${endpointKeys.find((k) => !given.includes(k))}`,
          "core takes authorizationEndpoint, tokenEndpoint, and jwksEndpoint together, or none for discovery",
        ),
      };
    out.endpoints = { authorizeUrl, tokenUrl, jwksUrl };
  } else if (o.skipDiscovery === true && current === null)
    return {
      ok: false,
      refusal: unsupported(
        `${p}.skipDiscovery`,
        "core needs authorizationEndpoint, tokenEndpoint, and jwksEndpoint to skip discovery",
      ),
    };
  if (issuer !== undefined) out.issuer = issuer;
  return { ok: true, fields: out };
}

/** A mapping must name the claims or attributes that core reads, each under its own name. */
function mappingRefusal(path: string, v: unknown, own: Record<string, string>): Refusal | null {
  if (!isObject(v)) return invalid(path, "expected an object");
  for (const [key, value] of Object.entries(v)) {
    if (value === undefined) continue;
    const at = `${path}.${key}`;
    if (key === "emailVerified")
      return unsupported(
        at,
        "the domain proof is the only proof of an address; core reads no email_verified",
      );
    if (key === "extraFields") return unsupported(at, "core keeps no extra field of a user");
    if (!Object.hasOwn(own, key)) return unsupported(at, "authtempo has no such field");
    if (value !== own[key]) return unsupported(at, `core reads the claim "${own[key]}" only`);
  }
  return null;
}

/** The SAML config of a register or an update (ruling 61 P1). */
function samlFields(s: Json): Fields {
  const out: Json = {};
  const p = "samlConfig";
  const certificatesOf = (v: unknown, path: string): string[] | Refusal => {
    const list = typeof v === "string" ? [v] : v;
    if (!Array.isArray(list) || list.length === 0 || !list.every((c) => typeof c === "string"))
      return invalid(path, "expected a PEM certificate or a list of them");
    return list as string[];
  };
  let metadata = false;
  let topCert: string[] | null = null;
  for (const [key, v] of Object.entries(s)) {
    if (v === undefined) continue;
    const path = `${p}.${key}`;
    switch (key) {
      case "issuer":
        // Better Auth's SP entity id: core's is its own (ruling 61 P1), and the answer gives it.
        break;
      case "entryPoint":
        if (typeof v !== "string") return { ok: false, refusal: invalid(path, "expected a URL") };
        out.ssoUrl = v;
        break;
      case "cert": {
        const c = certificatesOf(v, path);
        if (!Array.isArray(c)) return { ok: false, refusal: c };
        topCert = c;
        break;
      }
      case "idpMetadata": {
        if (!isObject(v)) return { ok: false, refusal: invalid(path, "expected an object") };
        for (const [k, value] of Object.entries(v)) {
          if (value === undefined) continue;
          const at = `${path}.${k}`;
          if (k === "metadata") {
            if (typeof value !== "string")
              return { ok: false, refusal: invalid(at, "expected the IdP metadata XML") };
            out.idpMetadata = value;
            metadata = true;
          } else if (k === "entityID") {
            if (typeof value !== "string")
              return { ok: false, refusal: invalid(at, "expected the IdP entity id") };
            out.idpEntityId = value;
          } else if (k === "cert") {
            const c = certificatesOf(value, at);
            if (!Array.isArray(c)) return { ok: false, refusal: c };
            out.certificates = c;
          } else if (k === "isAssertionEncrypted") {
            if (value !== false)
              return { ok: false, refusal: unsupported(at, "core takes no encrypted assertion") };
          } else if (
            ["privateKey", "privateKeyPass", "encPrivateKey", "encPrivateKeyPass"].includes(k)
          )
            return {
              ok: false,
              refusal: unsupported(at, "core takes no encrypted assertion and signs no request"),
            };
          else if (k === "singleLogoutService")
            return { ok: false, refusal: unsupported(at, "core has no SAML single logout") };
          else if (k === "singleSignOnService")
            return {
              ok: false,
              refusal: unsupported(at, "pass entryPoint, or the IdP metadata XML"),
            };
          else return { ok: false, refusal: unsupported(at, "authtempo has no such field") };
        }
        break;
      }
      case "mapping": {
        if (!isObject(v)) return { ok: false, refusal: invalid(path, "expected an object") };
        const attributes: Json = {};
        for (const [k, value] of Object.entries(v)) {
          if (value === undefined) continue;
          const at = `${path}.${k}`;
          if (k === "email" || k === "name") {
            if (typeof value !== "string")
              return { ok: false, refusal: invalid(at, "expected an attribute name") };
            attributes[k] = value;
          } else if (k === "emailVerified")
            return {
              ok: false,
              refusal: unsupported(
                at,
                "the domain proof is the only proof of an address; core reads no email_verified",
              ),
            };
          else if (k === "firstName" || k === "lastName")
            return {
              ok: false,
              refusal: unsupported(at, "core reads one name attribute; map it with name"),
            };
          else if (k === "extraFields")
            return { ok: false, refusal: unsupported(at, "core keeps no extra field of a user") };
          else return { ok: false, refusal: unsupported(at, "authtempo has no such field") };
        }
        if (typeof attributes.email !== "string")
          return { ok: false, refusal: invalid(`${path}.email`, "required") };
        out.attributes = attributes;
        break;
      }
      case "identifierFormat":
        if (v !== PERSISTENT)
          return {
            ok: false,
            refusal: unsupported(path, `core asks for the NameID format ${PERSISTENT} only`),
          };
        out.subjectAttribute = null;
        break;
      case "wantAssertionsSigned":
        if (v !== true)
          return {
            ok: false,
            refusal: unsupported(path, "core refuses a Response with no valid signature"),
          };
        break;
      case "authnRequestsSigned":
        if (v !== false)
          return {
            ok: false,
            refusal: unsupported(
              path,
              "core sends an unsigned AuthnRequest bound to a request row",
            ),
          };
        break;
      case "signatureAlgorithm":
        if (typeof v !== "string" || !SIGNATURE_METHODS.has(v))
          return {
            ok: false,
            refusal: unsupported(
              path,
              typeof v === "string" && SHA1.test(v)
                ? "core refuses SHA-1"
                : `core verifies ${[...SIGNATURE_METHODS].join(" and ")} only`,
            ),
          };
        break;
      case "digestAlgorithm":
        if (typeof v !== "string" || !DIGEST_METHODS.has(v))
          return {
            ok: false,
            refusal: unsupported(
              path,
              typeof v === "string" && SHA1.test(v)
                ? "core refuses SHA-1"
                : "core verifies SHA-256 digests only",
            ),
          };
        break;
      case "privateKey":
        return {
          ok: false,
          refusal: unsupported(path, "core takes no encrypted assertion and signs no request"),
        };
      case "spMetadata":
        return {
          ok: false,
          refusal: unsupported(path, "core writes the SP metadata of each connection itself"),
        };
      case "audience":
        return {
          ok: false,
          refusal: unsupported(path, "core's audience is the SP entity id of the connection"),
        };
      case "callbackUrl":
      case "idpInitiatedCallbackUrl":
        return {
          ok: false,
          refusal: unsupported(
            path,
            "core refuses a Response that no request of this browser binds",
          ),
        };
      default:
        return { ok: false, refusal: unsupported(path, "authtempo has no such field") };
    }
  }
  if (topCert !== null) {
    if (out.certificates !== undefined)
      return {
        ok: false,
        refusal: unsupported(
          `${p}.cert`,
          "pass the certificates once, in cert or in idpMetadata.cert",
        ),
      };
    out.certificates = topCert;
  }
  if (metadata)
    for (const key of ["ssoUrl", "certificates", "idpEntityId"] as const)
      if (out[key] !== undefined)
        return {
          ok: false,
          refusal: unsupported(
            `${p}.${key === "ssoUrl" ? "entryPoint" : key === "certificates" ? "cert" : "idpMetadata.entityID"}`,
            "core reads the IdP metadata XML alone; pass one form",
          ),
        };
  return { ok: true, fields: out };
}

/** The register body: the provider fields, the domain, and the organization. `copyBetterAuthSso` reads a row by it too. */
export function registerFields(
  body: Json,
  tokenPrefix: string,
):
  | {
      ok: true;
      providerId: string;
      domain: string;
      organizationId: string;
      kind: "oidc" | "saml";
      fields: Json;
    }
  | { ok: false; refusal: Refusal } {
  for (const [key, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (
      ![
        "providerId",
        "issuer",
        "domain",
        "organizationId",
        "oidcConfig",
        "samlConfig",
        "overrideUserInfo",
      ].includes(key)
    )
      return { ok: false, refusal: unsupported(key, "authtempo has no such field") };
  }
  const { providerId, issuer, domain, organizationId, oidcConfig, samlConfig } = body;
  if (typeof providerId !== "string" || !PROVIDER_ID_RE.test(providerId))
    return {
      ok: false,
      refusal: invalid("providerId", "expected 1 to 64 letters, digits, _, and -"),
    };
  if (verificationIdentifier(tokenPrefix, providerId).length > DNS_LABEL_MAX)
    return {
      ok: false,
      refusal: invalid(
        "providerId",
        `the record identifier must fit one DNS label of ${DNS_LABEL_MAX} characters`,
      ),
    };
  if (typeof issuer !== "string" || issuer === "")
    return { ok: false, refusal: invalid("issuer", "expected a URL") };
  if (typeof domain !== "string" || domain === "")
    return { ok: false, refusal: invalid("domain", "expected a domain") };
  if (domain.includes(","))
    return {
      ok: false,
      refusal: unsupported(
        "domain",
        "core proves one domain per provider; register one provider per domain",
      ),
    };
  if (typeof organizationId !== "string" || organizationId === "")
    return {
      ok: false,
      refusal: unsupported(
        "organizationId",
        "core keeps each connection in an organization; pass its id",
      ),
    };
  if (body.overrideUserInfo !== undefined && body.overrideUserInfo !== false)
    return {
      ok: false,
      refusal: unsupported("overrideUserInfo", "core keeps the profile of a user that exists"),
    };
  if ((oidcConfig === undefined) === (samlConfig === undefined))
    return {
      ok: false,
      refusal: invalid("oidcConfig", "pass oidcConfig or samlConfig, one of them"),
    };
  if (oidcConfig !== undefined) {
    if (!isObject(oidcConfig))
      return { ok: false, refusal: invalid("oidcConfig", "expected an object") };
    const f = oidcFields(issuer, oidcConfig, null);
    return f.ok
      ? { ok: true, providerId, domain, organizationId, kind: "oidc", fields: f.fields }
      : f;
  }
  if (!isObject(samlConfig))
    return { ok: false, refusal: invalid("samlConfig", "expected an object") };
  const f = samlFields(samlConfig);
  return f.ok
    ? { ok: true, providerId, domain, organizationId, kind: "saml", fields: f.fields }
    : f;
}

/** The last four characters of a client id, as Better Auth answers it (dist/index.mjs:920). */
const lastFour = (id: string) => (id.length <= 4 ? id : id.slice(-4));

/**
 * One provider in Better Auth's answer shape (index-sM6JWXeV.d.mts:794).
 * The fields that core does not keep answer core's fixed behavior: PKCE,
 * client_secret_post, signed assertions, and the persistent NameID.
 */
function providerOf(
  mapped: Mapped,
  c: SsoConnectionSummary,
  domain: SsoDomainSummary | null,
): Json {
  const spMetadataUrl = `${mapped.origin}${mapped.basePath}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(c.label)}`;
  const oidc = c.oidc;
  const saml = c.saml;
  return {
    providerId: c.label,
    type: c.kind,
    // Better Auth's issuer of a SAML provider is the SP entity id; core's is its own.
    issuer: oidc ? oidc.issuer : (saml?.spEntityId ?? ""),
    domain: domain?.domain ?? null,
    organizationId: c.organizationId,
    domainVerified: domain?.verified ?? false,
    oidcConfig: oidc
      ? {
          discoveryEndpoint: `${oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
          clientIdLastFour: lastFour(oidc.clientId),
          pkce: true,
          authorizationEndpoint: oidc.endpoints?.authorizeUrl,
          tokenEndpoint: oidc.endpoints?.tokenUrl,
          userInfoEndpoint: undefined,
          jwksEndpoint: oidc.endpoints?.jwksUrl,
          scopes: oidc.scope.split(" "),
          tokenEndpointAuthentication: "client_secret_post",
        }
      : undefined,
    samlConfig: saml
      ? {
          entryPoint: saml.ssoUrl,
          callbackUrl: undefined,
          idpInitiatedCallbackUrl: undefined,
          audience: saml.spEntityId,
          wantAssertionsSigned: true,
          authnRequestsSigned: false,
          identifierFormat: saml.subjectAttribute === null ? PERSISTENT : undefined,
          signatureAlgorithm: undefined,
          digestAlgorithm: undefined,
          // Core keeps the end date of each certificate only.
          certificate: saml.certificates.map((x) => ({ notAfter: x.notAfter })),
          acsUrl: saml.acsUrl,
        }
      : undefined,
    spMetadataUrl,
  };
}

/** The token of Better Auth's record: core's current challenge of a pending row. */
function tokenOf(domain: SsoDomainSummary): string | null {
  const value = domain.record?.value;
  return value?.startsWith(CORE_VALUE_PREFIX) ? value.slice(CORE_VALUE_PREFIX.length) : null;
}

/**
 * What a domain proof answers (ruling 61 P7): the token, and both records.
 * Publish both: the verify of the shim reads Better Auth's, and core's own
 * routes read core's.
 */
function proofOf(mapped: Mapped, providerId: string, domain: SsoDomainSummary): Json {
  const token = tokenOf(domain);
  if (token === null || domain.record === null) return {};
  const identifier = verificationIdentifier(mapped.sso?.tokenPrefix ?? "", providerId);
  return {
    domainVerificationToken: token,
    domainVerificationRecords: [
      { name: `${identifier}.${domain.domain}`, type: "TXT", value: `${identifier}=${token}` },
      domain.record,
    ],
  };
}

/** One call of the shim: the core calls with the caller's headers, and the cookies that core set. */
class Calls {
  readonly cookies: string[] = [];
  constructor(
    private readonly auth: Auth,
    private readonly mapped: Mapped,
    private readonly request: Request,
  ) {}

  /** A request to core's path `to` with the caller's headers: the cookie, the Origin, and the client IP. */
  requestTo(to: string, body?: Json): Request {
    const headers = new Headers(this.request.headers);
    headers.delete("content-length");
    if (body !== undefined) headers.set("content-type", "application/json");
    else headers.delete("content-type");
    return new Request(`${this.mapped.origin}${this.mapped.basePath}${to}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async core(to: string, body?: Json): Promise<Response> {
    return this.keep(await this.auth.handle(this.requestTo(to, body)));
  }

  keep(res: Response): Response {
    for (const c of res.headers.getSetCookie()) this.cookies.push(c);
    return res;
  }

  /** A JSON answer with the cookies that core set, such as a renewed session. */
  answer(body: unknown, status = 200): Response {
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of this.cookies) headers.append("set-cookie", c);
    return new Response(body === null ? null : JSON.stringify(body), { status, headers });
  }

  fail(r: Refusal): Response {
    return this.answer({ code: r.code, message: r.message }, r.status);
  }

  /** Core's refusal in Better Auth's form, with core's status. */
  async refusal(res: Response): Promise<Response> {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown; message?: unknown } | null;
    const error = typeof body?.error === "string" ? body.error : "unexpected";
    const code = Object.hasOwn(BETTER_AUTH_CODES, error)
      ? BETTER_AUTH_CODES[error as keyof typeof BETTER_AUTH_CODES]
      : BETTER_AUTH_CODES.unexpected;
    const message = typeof body?.message === "string" ? body.message : messageOf(code);
    return this.answer({ code, message }, res.status);
  }
}

const NOT_FOUND: Refusal = {
  status: 404,
  code: "NOT_FOUND",
  message: "No SSO provider has this providerId",
};

/**
 * The connection whose label is `providerId`, read by the label (ruling 61
 * P5). Only the shim writes a label of the providerId form: register and
 * the copy write it, and `coreLabelRefusal` keeps core's label routes off
 * it. So this read finds only rows that the shim made.
 */
async function connectionRow(mapped: Mapped, providerId: string) {
  if (!PROVIDER_ID_RE.test(providerId)) return null;
  const rows = await mapped.config.storage.findMany(
    "ssoConnection",
    [{ field: "label", op: "eq", value: providerId }],
    { limit: 2 },
  );
  // Register keeps one row per label; a second row is a race that register undoes.
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

/**
 * The connection of `providerId` and the domain routed to it, each read
 * through core's manager routes with the caller's session. Core's session
 * check and manager guard answer first: 401, or 403 for a caller who does
 * not manage the organization.
 */
async function managedProvider(
  calls: Calls,
  mapped: Mapped,
  providerId: unknown,
): Promise<
  | {
      connection: SsoConnectionSummary;
      domain: SsoDomainSummary | null;
      domains: SsoDomainSummary[];
    }
  | Response
> {
  if (typeof providerId !== "string") return calls.fail(invalid("providerId", "expected a string"));
  const row = await connectionRow(mapped, providerId);
  if (!row) return calls.fail(NOT_FOUND);
  const q = `?organizationId=${encodeURIComponent(row.organizationId)}`;
  const listed = await calls.core(`/sso/connections${q}`);
  if (!listed.ok) return calls.refusal(listed);
  const { connections } = (await listed.json()) as { connections: SsoConnectionSummary[] };
  const connection = connections.find((c) => c.id === row.id);
  if (!connection) return calls.fail(NOT_FOUND);
  const read = await calls.core(`/sso/domains${q}`);
  if (!read.ok) return calls.refusal(read);
  const { domains } = (await read.json()) as { domains: SsoDomainSummary[] };
  const mine = domains.filter((d) => d.connectionId === connection.id);
  return { connection, domain: mine[0] ?? null, domains: mine };
}

/** A JSON body of an object, or null. */
async function jsonBody(request: Request): Promise<Json | null> {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  return isObject(body) ? body : null;
}

/** A pending domain whose time ran out: core's sweep deletes it, and its record proves nothing. */
const expired = (d: SsoDomainSummary, now: number) =>
  !d.verified && d.expiresAt !== null && Date.parse(d.expiresAt) <= now;

/**
 * Adds `domain` to the organization and routes it to `connectionId`, each
 * through core's routes. Answers the domain, or core's refusal.
 */
async function addRouted(
  calls: Calls,
  organizationId: string,
  domain: string,
  connectionId: string,
): Promise<SsoDomainSummary | Response> {
  const added = await calls.core("/sso/domains/add", { organizationId, domain });
  if (!added.ok) return calls.refusal(added);
  const made = ((await added.json()) as { domain: SsoDomainSummary }).domain;
  const routed = await calls.core("/sso/domains/update", { id: made.id, connectionId });
  if (!routed.ok) return calls.refusal(routed);
  return ((await routed.json()) as { domain: SsoDomainSummary }).domain;
}

/** `POST /sso/register`: a connection, its domain, and the route of the domain (ruling 61 P4). */
async function register(
  auth: Auth,
  mapped: Mapped,
  request: Request,
  calls: Calls,
): Promise<Response> {
  if (!(await auth.session(request)))
    return calls.fail({ status: 401, code: "UNAUTHORIZED", message: messageOf("UNAUTHORIZED") });
  const body = await jsonBody(request);
  if (!body) return calls.fail(invalid("body", "expected a JSON object"));
  const sso = mapped.sso;
  if (!sso) return calls.fail(NOT_FOUND);
  const read = registerFields(body, sso.tokenPrefix);
  if (!read.ok) return calls.fail(read.refusal);
  const taken = {
    status: 422,
    code: "UNPROCESSABLE_ENTITY",
    message: "SSO provider with this providerId already exists",
  };
  /** Up to two connections with this label. */
  const byLabel = () =>
    mapped.config.storage.findMany(
      "ssoConnection",
      [{ field: "label", op: "eq", value: read.providerId }],
      { limit: 2 },
    );
  if ((await byLabel()).length > 0) return calls.fail(taken);
  const created = await calls.core("/sso/connections/create", {
    organizationId: read.organizationId,
    kind: read.kind,
    label: read.providerId,
    jit: sso.jit,
    defaultRole: sso.defaultRole,
    ...read.fields,
  });
  if (!created.ok) return calls.refusal(created);
  const connection = ((await created.json()) as { connection: SsoConnectionSummary }).connection;
  const undo = () => calls.core("/sso/connections/delete", { id: connection.id });
  // Two registers of one providerId at once (Q2 of impl-12d-task14b): a register that
  // finds another row after its create undoes its own. A register that ended first
  // keeps its row. Two that find each other both undo theirs, so no label holds two rows.
  if ((await byLabel()).some((r) => r.id !== connection.id)) {
    await undo();
    return calls.fail(taken);
  }
  const domain = await addRouted(calls, read.organizationId, read.domain, connection.id);
  if (domain instanceof Response) {
    await undo();
    return domain;
  }
  return calls.answer({
    ...providerOf(mapped, connection, domain),
    redirectURI: `${mapped.origin}${mapped.basePath}/sso/${connection.id}/callback`,
    ...proofOf(mapped, read.providerId, domain),
  });
}

/** `GET /sso/providers`: the connections of each organization that the caller manages. */
async function listProviders(
  auth: Auth,
  mapped: Mapped,
  request: Request,
  calls: Calls,
): Promise<Response> {
  const session = await auth.session(request);
  if (!session)
    return calls.fail({ status: 401, code: "UNAUTHORIZED", message: messageOf("UNAUTHORIZED") });
  const members = await mapped.config.storage.findMany(
    "member",
    [{ field: "userId", op: "eq", value: session.user.id }],
    { limit: PROVIDER_ORGANIZATIONS_MAX },
  );
  const providers: Json[] = [];
  for (const m of members) {
    const q = `?organizationId=${encodeURIComponent(m.organizationId)}`;
    const listed = await calls.core(`/sso/connections${q}`);
    // A member who does not manage the organization sees none of its providers, as core's guard says.
    if (listed.status === 403) continue;
    if (!listed.ok) return calls.refusal(listed);
    const { connections } = (await listed.json()) as { connections: SsoConnectionSummary[] };
    if (connections.length === 0) continue;
    const read = await calls.core(`/sso/domains${q}`);
    if (!read.ok) return calls.refusal(read);
    const { domains } = (await read.json()) as { domains: SsoDomainSummary[] };
    for (const c of connections)
      providers.push(providerOf(mapped, c, domains.find((d) => d.connectionId === c.id) ?? null));
  }
  return calls.answer({ providers });
}

/** `POST /sso/update-provider`: core's update of the connection, and a new domain when it changes. */
async function updateProvider(mapped: Mapped, request: Request, calls: Calls): Promise<Response> {
  const body = await jsonBody(request);
  if (!body) return calls.fail(invalid("body", "expected a JSON object"));
  for (const [key, v] of Object.entries(body))
    if (
      v !== undefined &&
      !["providerId", "issuer", "domain", "oidcConfig", "samlConfig"].includes(key)
    )
      return calls.fail(unsupported(key, "authtempo has no such field"));
  const found = await managedProvider(calls, mapped, body.providerId);
  if (found instanceof Response) return found;
  const { connection } = found;
  const { issuer, domain, oidcConfig, samlConfig } = body;
  if (issuer !== undefined && typeof issuer !== "string")
    return calls.fail(invalid("issuer", "expected a URL"));
  let fields: Json = {};
  if (connection.kind === "oidc") {
    if (samlConfig !== undefined)
      return calls.fail(
        unsupported("samlConfig", "the provider is OIDC; a connection never changes its kind"),
      );
    if (oidcConfig !== undefined && !isObject(oidcConfig))
      return calls.fail(invalid("oidcConfig", "expected an object"));
    const f = oidcFields(issuer, oidcConfig ?? {}, connection.oidc ?? null);
    if (!f.ok) return calls.fail(f.refusal);
    fields = f.fields;
  } else {
    if (oidcConfig !== undefined)
      return calls.fail(
        unsupported("oidcConfig", "the provider is SAML; a connection never changes its kind"),
      );
    if (samlConfig !== undefined) {
      if (!isObject(samlConfig)) return calls.fail(invalid("samlConfig", "expected an object"));
      const f = samlFields(samlConfig);
      if (!f.ok) return calls.fail(f.refusal);
      fields = f.fields;
    }
  }
  let current = connection;
  if (Object.keys(fields).length > 0) {
    const updated = await calls.core("/sso/connections/update", { id: connection.id, ...fields });
    if (!updated.ok) return calls.refusal(updated);
    current = ((await updated.json()) as { connection: SsoConnectionSummary }).connection;
  }
  let routed = found.domain;
  if (domain !== undefined) {
    if (typeof domain !== "string" || domain === "")
      return calls.fail(invalid("domain", "expected a domain"));
    if (domain.includes(","))
      return calls.fail(
        unsupported(
          "domain",
          "core proves one domain per provider; register one provider per domain",
        ),
      );
    if (domain !== found.domain?.domain) {
      // Better Auth clears the proof when the domain changes: the new domain is pending.
      const added = await addRouted(calls, connection.organizationId, domain, connection.id);
      if (added instanceof Response) return added;
      for (const old of found.domains) {
        const gone = await calls.core("/sso/domains/delete", { id: old.id });
        if (!gone.ok) return calls.refusal(gone);
      }
      routed = added;
    }
  }
  return calls.answer(providerOf(mapped, current, routed));
}

/** `POST /sso/delete-provider`: the domains of the connection, then the connection. */
async function deleteProvider(mapped: Mapped, request: Request, calls: Calls): Promise<Response> {
  const body = await jsonBody(request);
  const found = await managedProvider(calls, mapped, body?.providerId);
  if (found instanceof Response) return found;
  for (const d of found.domains) {
    const gone = await calls.core("/sso/domains/delete", { id: d.id });
    if (!gone.ok) return calls.refusal(gone);
  }
  const gone = await calls.core("/sso/connections/delete", { id: found.connection.id });
  if (!gone.ok) return calls.refusal(gone);
  return calls.answer({ success: true });
}

const VERIFIED: Refusal = {
  status: 409,
  code: "DOMAIN_VERIFIED",
  message: "Domain has already been verified",
};
const NO_PENDING: Refusal = {
  status: 404,
  code: "NO_PENDING_VERIFICATION",
  message: "No pending domain verification exists",
};

/**
 * `POST /sso/request-domain-verification` (ruling 61 P7): core's current
 * challenge as the token, with both records. A pending row past its time
 * is added again, with a new challenge.
 */
async function requestVerification(
  mapped: Mapped,
  request: Request,
  calls: Calls,
): Promise<Response> {
  const body = await jsonBody(request);
  const found = await managedProvider(calls, mapped, body?.providerId);
  if (found instanceof Response) return found;
  let domain = found.domain;
  if (!domain)
    return calls.fail({
      ...NO_PENDING,
      message: "The provider has no domain; set one with /sso/update-provider",
    });
  if (domain.verified) return calls.fail(VERIFIED);
  if (expired(domain, Date.now())) {
    const gone = await calls.core("/sso/domains/delete", { id: domain.id });
    if (!gone.ok) return calls.refusal(gone);
    const added = await addRouted(
      calls,
      found.connection.organizationId,
      domain.domain,
      found.connection.id,
    );
    if (added instanceof Response) return added;
    domain = added;
  }
  return calls.answer(proofOf(mapped, found.connection.label, domain), 201);
}

/** `POST /sso/verify-domain`: core's verify route, which reads Better Auth's record (ruling 61 F4). */
async function verifyDomain(
  auth: Auth,
  mapped: Mapped,
  request: Request,
  calls: Calls,
): Promise<Response> {
  const body = await jsonBody(request);
  const found = await managedProvider(calls, mapped, body?.providerId);
  if (found instanceof Response) return found;
  const domain = found.domain;
  if (!domain || expired(domain, Date.now())) return calls.fail(NO_PENDING);
  if (domain.verified) return calls.fail(VERIFIED);
  const res = calls.keep(
    await verifyDomainByRecord(auth, calls.requestTo("/sso/domains/verify", { id: domain.id })),
  );
  if (res.ok) return calls.answer(null, 204);
  const error = (
    (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown } | null
  )?.error;
  // Better Auth's answers of a record that is not there, and of a pending row past its time.
  if (error === "domain_unverified")
    return calls.fail({
      status: 502,
      code: "DOMAIN_VERIFICATION_FAILED",
      message: `Unable to verify domain ownership for ${domain.domain}. Try again later`,
    });
  if (error === "token_expired") return calls.fail(NO_PENDING);
  return calls.refusal(res);
}

/** The keys of `signIn.sso` that core has no feature for (Q6 of impl-12d-task14b). */
const SIGN_IN_REFUSED: Record<string, string> = {
  errorCallbackURL: "core sends a failed sign-in to its error page",
  newUserCallbackURL: "core lands every sign-in on callbackURL",
  scopes: "core asks for the scopes of the connection",
  loginHint: "core sends no login_hint",
  additionalParams: "core sends no extra parameter to the IdP",
  requestSignUp: "the jit flag of the connection decides a new user",
};

/**
 * The connection that a verified domain claims for `email`, for a SAML
 * connection only. Core's discovery answers no SAML connection (ruling 61
 * F6, a core defect of the 12d final fix wave). Until that fix the shim
 * reads the claim itself, the most specific domain first, as core's
 * `claimingDomain` does. Remove this when core's discovery serves SAML.
 */
async function samlConnectionOf(mapped: Mapped, email: string): Promise<string | null> {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const labels = domain.split(".");
  const names = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
  if (names.length === 0) return null;
  const rows = await mapped.config.storage.findMany("ssoDomain", [
    { field: "claimedDomain", op: "in", value: names },
  ]);
  for (const name of names) {
    const row = rows.find((r) => r.claimedDomain === name);
    if (row && (name === domain || row.includeSubdomains)) return row.connectionId;
  }
  return null;
}

/** `POST /sign-in/sso`: the start path of the connection that the body names (ruling 61 F6). */
async function signInSso(mapped: Mapped, request: Request, calls: Calls): Promise<Response> {
  const body = await jsonBody(request);
  if (!body) return calls.fail(invalid("body", "expected a JSON object"));
  for (const [key, v] of Object.entries(body)) {
    if (v === undefined) continue;
    const why = SIGN_IN_REFUSED[key];
    if (why !== undefined) return calls.fail(unsupported(key, why));
    if (
      ![
        "email",
        "organizationSlug",
        "providerId",
        "domain",
        "callbackURL",
        "providerType",
      ].includes(key)
    )
      return calls.fail(unsupported(key, "authtempo has no such field"));
  }
  const { email, organizationSlug, providerId, domain, callbackURL, providerType } = body;
  if (typeof callbackURL !== "string") return calls.fail(invalid("callbackURL", "required"));
  const storage = mapped.config.storage;
  let connectionId: string | null = null;
  if (typeof providerId === "string")
    connectionId = (await connectionRow(mapped, providerId))?.id ?? null;
  else if (typeof email === "string" || typeof domain === "string") {
    const address = typeof email === "string" ? email : `sso@${domain}`;
    // Core's discovery first: its limiter counts each ask.
    const found = await calls.core("/sso/discover", { email: address });
    if (!found.ok) return calls.refusal(found);
    const r = (await found.json()) as { sso: boolean; connectionId?: string };
    connectionId =
      (r.sso ? r.connectionId : undefined) ?? (await samlConnectionOf(mapped, address));
  } else if (typeof organizationSlug === "string") {
    const org = await storage.findOne("organization", [
      { field: "slug", op: "eq", value: organizationSlug },
    ]);
    if (org) {
      const rows = await storage.findMany(
        "ssoConnection",
        [
          { field: "organizationId", op: "eq", value: org.id },
          { field: "enabled", op: "eq", value: true },
        ],
        { sort: { field: "createdAt", dir: "asc" }, limit: 1 },
      );
      connectionId = rows[0]?.id ?? null;
    }
  } else return calls.fail(invalid("email", "pass email, domain, providerId, or organizationSlug"));
  const row = connectionId
    ? await storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: connectionId }])
    : null;
  if (!row || (providerType !== undefined && providerType !== row.kind))
    return calls.fail({
      status: 404,
      code: "NOT_FOUND",
      message: "No SSO provider found for this sign-in",
    });
  const url = `${mapped.origin}${mapped.basePath}/sso/${row.id}/start?next=${encodeURIComponent(callbackURL)}`;
  return calls.answer({ url, redirect: true });
}

/** The paths of Better Auth that core does not serve: 501 (plan 12d Task 14 Behavior 3). */
function notServed(path: string): string | null {
  if (path === "/sso/callback")
    return "core gives each connection its own callback, /sso/callback/<providerId>";
  if (path.startsWith("/sso/saml2/sp/slo/") || path.startsWith("/sso/saml2/logout/"))
    return "core has no SAML single logout";
  return null;
}

/** A provider id from the last segment of a path under `prefix`, or null. */
function segmentAfter(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const id = decodeURIComponent(path.slice(prefix.length));
  return id !== "" && !id.includes("/") ? id : null;
}

/**
 * `POST /sso/saml2/sp/acs/:providerId` to core's ACS of the connection. It
 * runs before the shim's Origin check, because an IdP posts the form
 * cross-site. Core's own route takes that post (`allowCrossSiteForm`). The
 * request row and the binding cookie bind it. Null for every other request.
 */
export async function ssoAcsRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  if (!mapped.sso || request.method !== "POST") return null;
  const path = new URL(request.url).pathname.slice(mapped.basePath.length);
  const providerId = segmentAfter(path, "/sso/saml2/sp/acs/");
  if (providerId === null) return null;
  const row = await connectionRow(mapped, providerId);
  if (!row)
    return Response.json({ code: NOT_FOUND.code, message: NOT_FOUND.message }, { status: 404 });
  return auth.handle(new Request(`${mapped.origin}${mapped.basePath}/sso/${row.id}/acs`, request));
}

/**
 * Core's refusal of a call to its own connection create or update through
 * the shim, when the call would touch a providerId (review of plan 12d Task
 * 14, M2). Else a manager of another organization could make a connection
 * with the label "acme". Then the lookup by providerId finds two rows, and
 * each Better Auth path of acme answers 404. A create or an update refuses a
 * new label of the providerId form, and an update refuses any new label on a
 * row that holds one. A body that is not a JSON object is refused too, so
 * no form of body passes unread. Null for every other request.
 */
async function coreLabelRefusal(
  mapped: Mapped,
  request: Request,
  path: string,
): Promise<Response | null> {
  if (path !== "/sso/connections/create" && path !== "/sso/connections/update") return null;
  const refuse = (message: string) =>
    Response.json({ error: "invalid_body", message }, { status: 400 });
  const body = await jsonBody(request);
  if (!body) return refuse("expected a JSON object");
  if (body.label === undefined) return null;
  const why =
    "a label of the providerId form belongs to /sso/register and /sso/update-provider in a Better Auth app";
  if (typeof body.label === "string" && PROVIDER_ID_RE.test(body.label)) return refuse(why);
  if (path === "/sso/connections/update" && typeof body.id === "string") {
    const row = await mapped.config.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: body.id },
    ]);
    if (row && PROVIDER_ID_RE.test(row.label)) return refuse(why);
  }
  return null;
}

/** The shim's answer to a Better Auth SSO path. Null for every other request. */
export async function ssoRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  if (!mapped.sso) return null;
  const url = new URL(request.url);
  const path = url.pathname.slice(mapped.basePath.length);
  if (!path.startsWith("/sso/") && path !== "/sign-in/sso") return null;
  const calls = new Calls(auth, mapped, request);
  const why = notServed(path);
  if (why !== null) return calls.fail(unsupported(path, why));
  const get = request.method === "GET";
  const post = request.method === "POST";
  if (post) {
    const refusal = await coreLabelRefusal(mapped, request, path);
    if (refusal) return refusal;
  }
  if (post && path === "/sso/register") return register(auth, mapped, request, calls);
  if (get && path === "/sso/providers") return listProviders(auth, mapped, request, calls);
  if (get && path === "/sso/get-provider") {
    const found = await managedProvider(
      calls,
      mapped,
      url.searchParams.get("providerId") ?? undefined,
    );
    return found instanceof Response
      ? found
      : calls.answer(providerOf(mapped, found.connection, found.domain));
  }
  if (post && path === "/sso/update-provider") return updateProvider(mapped, request, calls);
  if (post && path === "/sso/delete-provider") return deleteProvider(mapped, request, calls);
  if (post && path === "/sso/request-domain-verification")
    return requestVerification(mapped, request, calls);
  if (post && path === "/sso/verify-domain") return verifyDomain(auth, mapped, request, calls);
  if (post && path === "/sign-in/sso") return signInSso(mapped, request, calls);
  if (get && path === "/sso/saml2/sp/metadata") {
    const row = await connectionRow(mapped, url.searchParams.get("providerId") ?? "");
    return row ? calls.core(`/sso/${row.id}/metadata`) : calls.fail(NOT_FOUND);
  }
  const callbackOf = get ? segmentAfter(path, "/sso/callback/") : null;
  if (callbackOf !== null) {
    const row = await connectionRow(mapped, callbackOf);
    if (!row) return calls.fail(NOT_FOUND);
    // The query and the binding cookie go to core's callback of the connection as they came.
    return auth.handle(
      new Request(
        `${mapped.origin}${mapped.basePath}/sso/${row.id}/callback${url.search}`,
        request,
      ),
    );
  }
  return null;
}

const BEARER_RE = /^Bearer ([^ ]+)$/i;

/**
 * A SCIM request with a credential of the scim plugin (ruling 61 P3): the
 * SHA-256 of the bearer against each credential's hash. A match that has
 * not expired runs core's route as that credential (`scimRequestAs`). Every
 * other request goes to core's own token check, which answers 401 and counts
 * the failure. Null for every other request.
 */
export async function scimRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  const credentials = mapped.scim?.credentials;
  if (!credentials || credentials.length === 0) return null;
  if (!new URL(request.url).pathname.startsWith(`${mapped.basePath}/scim/v2/`)) return null;
  const token = BEARER_RE.exec(request.headers.get("authorization") ?? "")?.[1];
  if (token === undefined) return null;
  const hash = toHex(sha256(new TextEncoder().encode(token)));
  let match = null;
  for (const c of credentials) if (equalHex(c.tokenHash, hash)) match = c;
  if (match === null || (match.expiresAt !== null && match.expiresAt.getTime() <= Date.now()))
    return null;
  return scimRequestAs(auth, request, {
    id: match.id,
    organizationId: match.organizationId,
    scopes: match.scopes,
  });
}
