import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveConfig } from "../src/config.js";
import { ERRORS, OAUTH_ERRORS } from "../src/errors.js";
import { DOCS_ORIGIN, routeAnchor } from "../src/http/anchors.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { routeKeyOf } from "../src/http/route-key.js";
import { ROUTE_FEATURES, ROUTES, type RouteEntry, type RouteKey } from "../src/http/route-list.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { VERSION } from "../src/index.js";
import {
  FEATURE_INFO,
  featuresOf,
  openApiDocument,
  openApiJson,
  openApiOptionsFrom,
  openApiReferenceOptions,
} from "../src/openapi/index.js";
import { base } from "./every-feature.js";

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: { pattern?: string };
}

interface Operation {
  tags: string[];
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
  operationId: string;
  externalDocs: { url: string };
  "x-authtempo-feature": string;
  "x-authtempo-default": string;
  responses: Record<
    string,
    {
      description: string;
      headers?: Record<string, { required: boolean; description: string }>;
      content?: Record<string, { schema: { properties?: { error?: { enum: string[] } } } }>;
    }
  >;
  security: Record<string, string[]>[];
}

interface Doc {
  openapi: string;
  info: { version: string };
  tags: { name: string; "x-authtempo-feature": string; "x-authtempo-default": string }[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, Record<string, unknown>>;
  };
}

const reference = () => openApiDocument(openApiReferenceOptions()) as unknown as Doc;

/** Each operation of a document with the `ROUTES` key that it stands for. */
function operations(doc: Doc): { key: string; op: Operation }[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({
      key: `${method.toUpperCase()} ${path.replace("{provider}", ":provider")}`,
      op,
    })),
  );
}

const ENTRY = new Map<string, RouteEntry>(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));

function entryOf(key: string): RouteEntry {
  const entry = ENTRY.get(key);
  if (entry === undefined) throw new Error(`no entry ${key}`);
  return entry;
}

describe("openApiDocument (plan 11g)", () => {
  it("has one operation per route and one route per operation", () => {
    const doc = reference();
    const keys = operations(doc).map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(ROUTES.map((r) => `${r.method} ${r.path}`).sort());
    expect(keys.length).toBe(108);
    const firstSeen = [...new Set(ROUTES.map((r) => r.path.replace(":provider", "{provider}")))];
    expect(Object.keys(doc.paths)).toEqual(firstSeen);
  });

  it("names each operation by its anchor", () => {
    const ops = operations(reference());
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { key, op } of ops) {
      const entry = entryOf(key);
      expect(op.operationId).toBe(routeAnchor(entry.method, entry.path));
      expect(op.externalDocs.url).toBe(`${DOCS_ORIGIN}/docs/reference/routes/#${op.operationId}`);
    }
    expect(routeAnchor("POST", "/operator/keys/rotate")).toBe("post-operator-keys-rotate");
    expect(DOCS_ORIGIN).toBe("https://authtempo.com");
  });

  it("answers each code with the status of its table", () => {
    for (const { key, op } of operations(reference())) {
      const entry = entryOf(key);
      const answered: string[] = [];
      for (const [status, response] of Object.entries(op.responses)) {
        const codes = response.content?.["application/json"]?.schema.properties?.error?.enum;
        if (codes === undefined) continue;
        for (const code of codes) {
          const core = (ERRORS as Record<string, number>)[code];
          const oauth = (OAUTH_ERRORS as Record<string, number>)[code];
          // Ruling 19 of plan 12e: a route of client auth also answers invalid_client as a 400.
          const bare =
            code === "invalid_client" &&
            status === "400" &&
            entry.auth.includes("clientSecretBasic");
          // Ruling 31 of plan 12e: a route of a bound token answers a bad proof as a 401.
          const resource =
            code === "invalid_dpop_proof" &&
            status === "401" &&
            entry.auth.includes("dpopAccessToken");
          expect(
            core === Number(status) || oauth === Number(status) || bare || resource,
            `${key} ${status} ${code}`,
          ).toBe(true);
          answered.push(code);
        }
      }
      // The router codes, typed here: not_found and internal for every route, origin_not_trusted for a POST.
      const router = ["not_found", "internal"];
      if (entry.method === "POST" && entry.crossSiteForm !== true)
        router.push("origin_not_trusted");
      const expected = new Set<string>([...entry.codes, ...entry.oauthCodes, ...router]);
      expect(new Set(answered), key).toEqual(expected);
    }
  });

  it("gives each feature one tag in the order of ROUTE_FEATURES", () => {
    const doc = reference();
    expect(doc.tags.map((t) => t.name)).toEqual([...ROUTE_FEATURES]);
    for (const tag of doc.tags) {
      const info = FEATURE_INFO[tag.name as keyof typeof FEATURE_INFO];
      expect(tag["x-authtempo-feature"]).toBe(tag.name);
      expect(tag["x-authtempo-default"]).toBe(info.default);
    }
    for (const { key, op } of operations(doc)) {
      const feature = entryOf(key).feature;
      expect(op.tags).toEqual([feature]);
      expect(op["x-authtempo-feature"]).toBe(feature);
      expect(op["x-authtempo-default"]).toBe(FEATURE_INFO[feature].default);
    }
  });

  it("holds FEATURE_INFO to the minimal config", () => {
    const served = new Set(
      coreRoutes(resolveConfig(base)).map((r) => entryOf(routeKeyOf(r.method, r.path)).feature),
    );
    const on = Object.entries(FEATURE_INFO)
      .filter(([, info]) => info.default === "on")
      .map(([feature]) => feature);
    expect([...served].sort()).toEqual(on.sort());
  });

  it("marks the rewrap body as not required, and every other body as required", () => {
    // The rewrap reads an empty body as `{}` (plan 11c2), so its body is the one that is not required.
    const optional = operations(reference())
      .filter(({ op }) => op.requestBody?.required === false)
      .map(({ key }) => key);
    expect(optional).toEqual(["POST /operator/secrets/rewrap"]);
    const bodies = operations(reference()).filter(({ op }) => op.requestBody !== undefined);
    expect(bodies.length).toBe(64);
  });

  it("gives the operator route its own scheme and the default off", () => {
    const doc = reference();
    const op = doc.paths["/operator/keys/rotate"]?.post;
    expect(op?.operationId).toBe("post-operator-keys-rotate");
    expect(op?.tags).toEqual(["operator"]);
    expect(op?.["x-authtempo-default"]).toBe("off");
    expect(op?.security).toEqual([{ operatorSecret: [] }]);
    expect(doc.components.securitySchemes.operatorSecret).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "Authorization",
    });
    const codes = Object.fromEntries(
      Object.entries(op?.responses ?? {}).map(([status, r]) => [
        status,
        r.content?.["application/json"]?.schema.properties?.error?.enum,
      ]),
    );
    expect(codes["401"]).toEqual(["unauthorized"]);
    expect(codes["429"]).toEqual(["rate_limited"]);
    expect(codes["403"]).toEqual(["origin_not_trusted"]);
  });

  it("lists one security requirement per credential form", () => {
    // The schemes of each form, typed here.
    const schemes: Record<string, string[]> = {
      none: [],
      session: ["sessionCookie", "sessionBearer"],
      apiToken: ["apiToken"],
      sessionJwt: ["sessionJwt"],
      accessToken: ["oauth"],
      operator: ["operatorSecret"],
      initialAccessToken: ["initialAccessToken"],
      clientSecretBasic: ["clientSecretBasic"],
      dpopAccessToken: ["oauthDpop"],
    };
    for (const { key, op } of operations(reference())) {
      const auth = entryOf(key).auth;
      if (auth.length === 1 && auth[0] === "none") {
        expect(op.security, key).toEqual([]);
        continue;
      }
      const expected = auth.flatMap((form) =>
        form === "none" ? [{}] : (schemes[form] ?? []).map((name) => ({ [name]: [] })),
      );
      expect(op.security, key).toEqual(expected);
    }
    // Plan 12e: the token and revoke routes take no credential, or the client's Basic auth.
    const token = reference().paths["/oauth/token"]?.post;
    expect(token?.security).toEqual([{}, { clientSecretBasic: [] }]);
    expect(reference().paths["/oauth/revoke"]?.post?.security).toEqual([
      {},
      { clientSecretBasic: [] },
    ]);
    expect(reference().paths["/oauth/introspect"]?.post?.security).toEqual([
      {},
      { clientSecretBasic: [] },
    ]);
    expect(token?.description).toContain("PKCE");
    expect(token?.description).toContain("`client_secret_post`");
    // Ruling 15 of plan 12e: the oauth scheme no longer says that each client is public.
    const oauth = reference().components.securitySchemes.oauth;
    expect(oauth?.description).not.toContain("Each client is public");
    expect(oauth?.description).toContain("`client_secret_basic`");
    expect(reference().components.securitySchemes.clientSecretBasic).toMatchObject({
      type: "http",
      scheme: "basic",
    });
    // Plan 12e Task 9: userinfo takes a bearer, or a bound token under the DPoP scheme of RFC 9449.
    expect(reference().paths["/oauth/userinfo"]?.get?.security).toEqual([
      { oauth: [] },
      { oauthDpop: [] },
    ]);
    // Ruling 31: a bad proof at userinfo is a 401 with the DPoP challenge, never a 400.
    const info = reference().paths["/oauth/userinfo"]?.get?.responses;
    expect(info?.["401"]?.content?.["application/json"]?.schema.properties?.error?.enum).toContain(
      "invalid_dpop_proof",
    );
    expect(info?.["400"]).toBeUndefined();
    expect(reference().components.securitySchemes.oauthDpop).toMatchObject({
      type: "http",
      scheme: "DPoP",
    });
    // Plan 12e: the register route takes no credential, or the initial access token.
    expect(reference().paths["/oauth/register"]?.post?.security).toEqual([
      {},
      { initialAccessToken: [] },
    ]);
  });

  it("writes the same bytes twice", () => {
    const one = openApiJson(openApiDocument(openApiReferenceOptions()));
    const two = openApiJson(openApiDocument(openApiReferenceOptions()));
    expect(one).toBe(two);
    expect(one.endsWith("}\n")).toBe(true);
    expect(one.split("\n")[1]).toBe('  "openapi": "3.1.2",');
  });

  it("builds the document of a config from the mounted routes", () => {
    const config = resolveConfig(base);
    const options = openApiOptionsFrom(config);
    expect(options.features).toEqual(
      // routeKeyOf gives the entry key of a mounted path; the tie test of plan 11g holds it to ROUTES.
      featuresOf(
        coreRoutes(config).map((r) => ({ key: routeKeyOf(r.method, r.path) as RouteKey })),
      ),
    );
    const paths = Object.keys((openApiDocument(options) as unknown as Doc).paths);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => p.startsWith("/operator") || p.startsWith("/oauth"))).toEqual([]);
  });

  it("holds no example value", () => {
    const keys: string[] = [];
    JSON.parse(openApiJson(openApiDocument(openApiReferenceOptions())), (key, value) => {
      keys.push(key);
      return value;
    });
    expect(keys.length).toBeGreaterThan(1000);
    expect(keys.filter((k) => k === "example" || k === "examples")).toEqual([]);
  });

  it("states the version", () => {
    const doc = reference();
    expect(doc.openapi).toBe("3.1.2");
    expect(doc.info.version).toBe(VERSION);
  });

  it("holds each schema to its contract", () => {
    const doc = reference();
    /** A schema with each `components.schemas` reference put back in place. */
    const inline = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(inline);
      if (node === null || typeof node !== "object") return node;
      const ref = (node as { $ref?: unknown }).$ref;
      if (typeof ref === "string" && Object.keys(node).length === 1)
        return inline(doc.components.schemas[ref.replace("#/components/schemas/", "")]);
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inline(v)]));
    };
    /** The conversion of a contract schema, with no shared shape. */
    const own = (schema: z.ZodType, io: "input" | "output") => {
      const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io,
        unrepresentable: "throw",
        reused: "inline",
      }) as Record<string, unknown>;
      return json;
    };
    const contracts: Record<string, RouteContract> = ROUTE_CONTRACT;
    let answers = 0;
    let bodies = 0;
    let queries = 0;
    for (const { key, op } of operations(doc)) {
      const contract = contracts[key];
      if (contract === undefined) throw new Error(`no contract ${key}`);
      for (const kind of [contract.answer, contract.alt]) {
        if (kind?.kind !== "json") continue;
        const schema =
          op.responses[String(kind.status ?? 200)]?.content?.["application/json"]?.schema;
        expect(inline(schema), key).toEqual(own(kind.schema, "output"));
        answers++;
      }
      if (contract.body) {
        const content = op.requestBody?.content ?? {};
        const media = contract.body.media.map((m) =>
          m === "json" ? "application/json" : "application/x-www-form-urlencoded",
        );
        expect(Object.keys(content), key).toEqual(media);
        for (const m of media)
          expect(inline(content[m]?.schema), key).toEqual(own(contract.body.schema, "input"));
        bodies++;
      }
      const params = (op.parameters ?? []).filter((p) => p.in === "query");
      if (contract.query) {
        const json = own(contract.query.schema, "input") as {
          properties: Record<string, unknown>;
          required?: string[];
        };
        expect(
          params.map((p) => p.name),
          key,
        ).toEqual(Object.keys(json.properties));
        for (const p of params) {
          expect(inline(p.schema), `${key} ${p.name}`).toEqual(json.properties[p.name]);
          // The authorize query has a second form, request_id alone, so no key of it is required.
          const required = key !== "GET /oauth/authorize" && (json.required ?? []).includes(p.name);
          expect(p.required, `${key} ${p.name}`).toBe(required);
        }
        queries++;
      } else expect(params, key).toEqual([]);
    }
    expect([answers, bodies, queries]).toEqual([84, 64, 16]);
  });

  it("takes the request_id form of the authorize query", () => {
    const params = reference().paths["/oauth/authorize"]?.get?.parameters ?? [];
    // The return step after the sign-in sends request_id alone (oauth-authorize.ts, authorizeStep).
    const query = new URLSearchParams({ request_id: "held" });
    const missing = params.filter((p) => p.required && !query.has(p.name)).map((p) => p.name);
    expect(missing).toEqual([]);
    expect(params.find((p) => p.name === "request_id")?.description).toContain("alone");
    expect(params.find((p) => p.name === "client_id")?.description).toBe(
      "Required unless `request_id` comes alone.",
    );
  });

  it("writes the bearer challenge where the route writes it", () => {
    const doc = reference();
    const header = (path: string, method: string, status: string) =>
      doc.paths[path]?.[method]?.responses[status]?.headers?.["WWW-Authenticate"];
    expect(header("/oauth/userinfo", "get", "401")?.required).toBe(true);
    expect(header("/oauth/userinfo", "post", "401")?.required).toBe(true);
    expect(header("/oauth/userinfo", "get", "403")?.required).toBe(true);
    // The 403 of the POST also holds origin_not_trusted, which the router answers with no challenge.
    expect(header("/oauth/userinfo", "post", "403")?.required).toBe(false);
    expect(header("/oauth/userinfo", "post", "403")?.description).toContain("`insufficient_scope`");
    // Plan 12e, ruling 17: each invalid_client 401 carries the Basic challenge (RFC 7235 section 3.1).
    for (const path of ["/oauth/token", "/oauth/revoke", "/oauth/introspect"]) {
      expect(header(path, "post", "401")?.required, path).toBe(true);
      expect(header(path, "post", "401")?.description, path).toContain("Basic challenge");
      // Ruling 19: with no Authorization header, invalid_client is a 400 with no challenge.
      expect(header(path, "post", "400"), path).toBeUndefined();
      const bad = reference().paths[path]?.post?.responses["400"]?.content?.["application/json"];
      expect(JSON.stringify(bad?.schema), path).toContain('"invalid_client"');
    }
  });

  it("holds each provider path to the name rule", () => {
    const paths = Object.entries(reference().paths).filter(([p]) => p.includes("{provider}"));
    expect(paths.length).toBe(3);
    for (const [path, item] of paths)
      for (const op of Object.values(item)) {
        const param = op.parameters?.find((p) => p.in === "path");
        expect(param, path).toMatchObject({ name: "provider", required: true });
        expect(param?.schema.pattern, path).toBe("^[a-z][a-z0-9-]{0,31}$");
      }
  });

  it("names the page form of the codes of a form post", () => {
    const reset = reference().paths["/password/reset"]?.post?.responses["400"]?.description;
    expect(reset).toContain(
      "A form post gets `password_policy`, `password_breached` in the `error` query parameter",
    );
    const totp = reference().paths["/totp/challenge"]?.post?.responses["400"]?.description;
    expect(totp).toContain("A form post gets `invalid_code` in the `error` query parameter");
  });
});
