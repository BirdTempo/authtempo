import { z } from "zod";
import { DOCS_ORIGIN, routeAnchor } from "../http/anchors.js";
import { ROUTE_CONTRACT } from "../http/contract/index.js";
import * as shapes from "../http/contract/shapes.js";
import type { RouteContract } from "../http/contract/types.js";
import { ROUTE_FEATURES, ROUTES, type RouteEntry, type RouteKey } from "../http/route-list.js";
import { PROVIDER_NAME_RE } from "../social/provider.js";
import type { OpenApiOptions } from "./deployment.js";
import { FEATURE_INFO } from "./features.js";
import { ERROR_SCHEMAS, responsesOf } from "./responses.js";
import { SCHEME_NAMES, securityOf, securitySchemes } from "./schemes.js";

/** The OpenAPI version that plan 11g read at spec.openapis.org on 2026-10-19: the latest 3.1 patch. */
export const OPENAPI_VERSION = "3.1.2";

/** The OpenAPI document as plain JSON data. */
export type OpenApiDoc = { readonly openapi: string } & Record<string, unknown>;

/**
 * The shared answer shapes, each one entry of `components.schemas` under its
 * export name. A local registry, so the shapes get no id in zod's global one.
 */
const SHARED = z.registry<{ id: string }>();
for (const [name, value] of Object.entries(shapes))
  if (value instanceof z.ZodType) SHARED.add(value, { id: name });

/** The rules of every route, and the CORS preflight rule, as the routes page states them. */
const RULES = [
  "The authtempo API: every route that core can serve under `basePath`. A deployment serves the operations of its features only.",
  "",
  "- A route that a config key turns off answers 404 `not_found`.",
  "- A POST with an `Origin` header that is not `baseURL` and not in `trustedOrigins` answers 403 `origin_not_trusted`. Apple's form post callback is the one exception.",
  '- A failure answers `{ "error": "<code>" }` with the status of the code. `hook_refused` also carries `message`.',
  "- An unhandled error answers 500 `internal` and writes one log line.",
  "- An `OPTIONS` preflight from a trusted origin answers 204 with the CORS headers. A preflight from another origin answers 403, except where a route states its own rule.",
  "- Every answer to a trusted origin carries the CORS headers with credentials.",
].join("\n");

/** The text of an operation that its schemas cannot state. */
const NOTES: Partial<Record<RouteKey, string>> = {
  "GET /oauth/authorize":
    "With no session, the route redirects to the sign-in step, `GET /oauth/sign-in`, and core holds the request. After the sign-in, the browser comes back with `request_id` alone, which names the held request. With a session, the route answers the consent page, or redirects to the client with the code or the `error`.",
  "POST /oauth/authorize":
    "The consent form. `request_id` names the request that core holds; it works once. A `decision` other than `allow` is a deny.",
  "POST /oauth/token":
    "The token endpoint. Each client is public, so the request has no client secret and no credential: the code grant proves the client with PKCE (S256), through `code_verifier`.",
  "POST /totp/challenge":
    "A wrong code redirects back to the second factor page with `error=<code>`. A failure of the sign-in redirects with `auth_error`.",
  "POST /password/reset":
    "A refused password redirects back to the reset page with `error=<code>`. A failure of the token redirects with `auth_error`.",
};

const MEDIA = { json: "application/json", form: "application/x-www-form-urlencoded" } as const;

/**
 * The OpenAPI 3.1 document of a deployment (plan 11g, spec 25): one operation
 * per entry of `ROUTES` whose feature is in `options.features`, in the order
 * of `ROUTES`. The same input gives the same bytes. The six keys of `options`
 * are the whole input: no config, so no secret, reaches the document.
 */
export function openApiDocument(options: OpenApiOptions): OpenApiDoc {
  const components: Record<string, object> = {};
  const schemaOf = (schema: z.ZodType, io: "input" | "output"): object => {
    const json = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io,
      unrepresentable: "throw",
      // A shape that two routes share is a registry entry; any other reuse stays inline,
      // because zod names a reused def per conversion and the names collide.
      reused: "inline",
      metadata: SHARED,
    }) as Record<string, unknown>;
    const { $schema: _dialect, $defs, ...root } = json;
    for (const [name, def] of Object.entries(($defs ?? {}) as Record<string, object>)) {
      const lifted = toComponents(def);
      const seen = components[name];
      if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(lifted))
        throw new Error(`authtempo: the shared shape ${name} has two forms`);
      components[name] = lifted;
    }
    return toComponents(root);
  };

  const paths: Record<string, Record<string, object>> = {};
  const used = new Set<string>();
  for (const entry of ROUTES as readonly RouteEntry[]) {
    if (!options.features.has(entry.feature)) continue;
    const key = `${entry.method} ${entry.path}` as RouteKey;
    const contract: RouteContract = ROUTE_CONTRACT[key];
    const security = securityOf(entry.auth);
    for (const requirement of security) for (const name of Object.keys(requirement)) used.add(name);
    const path = entry.path.replace(":provider", "{provider}");
    const operationId = routeAnchor(entry.method, entry.path);
    const parameters = [
      ...(path.includes("{provider}")
        ? [
            {
              name: "provider",
              in: "path",
              required: true,
              schema: { type: "string", pattern: PROVIDER_NAME_RE.source },
            },
          ]
        : []),
      ...(contract.query ? queryParameters(schemaOf(contract.query.schema, "input")) : []),
    ];
    const info = FEATURE_INFO[entry.feature];
    const note = NOTES[key];
    const operation: Record<string, unknown> = {
      tags: [entry.feature],
      summary: key,
      ...(note === undefined ? {} : { description: note }),
      operationId,
      externalDocs: { url: `${DOCS_ORIGIN}/docs/reference/routes/#${operationId}` },
      "x-authtempo-feature": entry.feature,
      "x-authtempo-default": info.default,
      ...(parameters.length > 0 ? { parameters } : {}),
    };
    if (contract.body) {
      const schema = schemaOf(contract.body.schema, "input");
      operation.requestBody = {
        required: true,
        content: Object.fromEntries(contract.body.media.map((m) => [MEDIA[m], { schema }])),
      };
    }
    operation.responses = responsesOf(entry, contract, schemaOf);
    operation.security = security;
    paths[path] ??= {};
    const item = paths[path];
    if (item) item[entry.method.toLowerCase()] = operation;
  }

  const schemes = securitySchemes(options);
  return {
    openapi: OPENAPI_VERSION,
    info: { title: "authtempo API", version: options.version, description: RULES },
    servers: [
      options.serverUrl === undefined
        ? {
            url: "{origin}{basePath}",
            variables: {
              origin: { default: "https://api.example.com" },
              basePath: { default: options.basePath },
            },
          }
        : { url: `${options.serverUrl}${options.basePath}` },
    ],
    tags: ROUTE_FEATURES.filter((f) => options.features.has(f)).map((f) => ({
      name: f,
      description: `The routes of the feature \`${f}\`. Config: ${FEATURE_INFO[f].configKey}; default ${FEATURE_INFO[f].default}.`,
      "x-authtempo-feature": f,
      "x-authtempo-default": FEATURE_INFO[f].default,
    })),
    paths,
    components: {
      schemas: {
        ...ERROR_SCHEMAS,
        ...Object.fromEntries(
          Object.keys(components)
            .sort()
            .map((n) => [n, components[n]]),
        ),
      },
      securitySchemes: Object.fromEntries(
        SCHEME_NAMES.filter((n) => used.has(n)).map((n) => [n, schemes[n]]),
      ),
    },
  };
}

/** The document as JSON: a two-space indent and one newline at the end. */
export function openApiJson(doc: OpenApiDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** A copy of a schema with each `#/$defs/` reference moved to `#/components/schemas/`. */
function toComponents<T>(node: T): T {
  if (Array.isArray(node)) return node.map(toComponents) as T;
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node))
    out[k] =
      k === "$ref" && typeof v === "string" && v.startsWith("#/$defs/")
        ? `#/components/schemas/${v.slice("#/$defs/".length)}`
        : toComponents(v);
  return out as T;
}

/** One `in: query` parameter per top-level property of a query schema, with `required` from the schema. */
function queryParameters(schema: object): object[] {
  const { properties, required } = schema as {
    properties?: Record<string, object>;
    required?: string[];
  };
  if (properties === undefined) throw new Error("authtempo: a query schema is not an object");
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required?.includes(name) ?? false,
    schema: property,
  }));
}
