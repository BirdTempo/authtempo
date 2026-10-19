import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { ERRORS, OAUTH_ERRORS } from "../src/errors.js";
import { DOCS_ORIGIN, routeAnchor } from "../src/http/anchors.js";
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

interface Operation {
  tags: string[];
  description?: string;
  operationId: string;
  externalDocs: { url: string };
  "x-authtempo-feature": string;
  "x-authtempo-default": string;
  responses: Record<
    string,
    { content?: Record<string, { schema: { properties?: { error?: { enum: string[] } } } }> }
  >;
  security: Record<string, string[]>[];
}

interface Doc {
  openapi: string;
  info: { version: string };
  tags: { name: string; "x-authtempo-feature": string; "x-authtempo-default": string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, Record<string, unknown>> };
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
    expect(keys.length).toBe(98);
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
          expect(
            core === Number(status) || oauth === Number(status),
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
    const token = reference().paths["/oauth/token"]?.post;
    expect(token?.security).toEqual([]);
    expect(token?.description).toContain("PKCE");
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
});
