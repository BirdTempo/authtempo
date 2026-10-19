import { describe, expect, it, vi } from "vitest";
import { ConfigError, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { routeKeyOf } from "../src/http/route-key.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { openApiDocument } from "../src/openapi/document.js";
import { BASE, base } from "./every-feature.js";
import { noSecretInput, SECRETS } from "./no-secret-config.js";

// A spy on the generator, so a test can count its calls. The route imports this module too.
vi.mock("../src/openapi/document.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/openapi/document.js")>();
  return { ...real, openApiDocument: vi.fn(real.openApiDocument) };
});

const METHODS = ["get", "post"] as const;

interface Doc {
  servers: Record<string, unknown>[];
  paths: Record<string, Partial<Record<(typeof METHODS)[number], object>>>;
}

/** The `ROUTES` key of each operation of a document. */
function keysOf(doc: Doc): string[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m] !== undefined).map(
      (m) => `${m.toUpperCase()} ${path.replace("{provider}", ":provider")}`,
    ),
  );
}

function openApi(): Request {
  return new Request(`${BASE}/auth/openapi.json`);
}

describe("GET /openapi.json (plan 11g)", () => {
  it("answers 404 when openapi is off", async () => {
    const res = await createAuth(base).handle(openApi());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("serves only the operations of the mounted routes", async () => {
    const input = { ...base, openapi: true };
    const res = await createAuth(input).handle(openApi());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const doc = (await res.json()) as Doc;
    const operations = keysOf(doc).sort();
    const mounted = [
      ...new Set(coreRoutes(resolveConfig(input)).map((r) => routeKeyOf(r.method, r.path))),
    ].sort();
    expect(operations).toEqual(mounted);
    const paths = Object.keys(doc.paths);
    for (const prefix of ["/operator", "/oauth", "/organizations", "/passkey"])
      expect(paths.filter((p) => p.startsWith(prefix))).toEqual([]);
    expect(paths).toContain("/openapi.json");
  });

  it("names the deployment as the server", async () => {
    const res = await createAuth({ ...base, basePath: "/api/auth", openapi: true }).handle(
      new Request(`${BASE}/api/auth/openapi.json`),
    );
    const doc = (await res.json()) as Doc;
    expect(doc.servers).toEqual([{ url: "https://api.example.com/api/auth" }]);
  });

  it("holds no value of the config that is not one of the six keys", async () => {
    const res = await createAuth({ ...noSecretInput(), openapi: true }).handle(openApi());
    expect(res.status).toBe(200);
    const text = await res.text();
    // The document is of this config: the operator route and a provider route are in it.
    expect(text).toContain('"/operator/keys/rotate"');
    expect(text).toContain('"/social/{provider}/start"');
    for (const [name, value] of Object.entries(SECRETS))
      expect(text.includes(value), `${name} in the document`).toBe(false);
  });

  it("builds the document once", async () => {
    const auth = createAuth({ ...base, openapi: true });
    vi.mocked(openApiDocument).mockClear();
    const one = await (await auth.handle(openApi())).text();
    const two = await (await auth.handle(openApi())).text();
    expect(two).toBe(one);
    expect(vi.mocked(openApiDocument)).toHaveBeenCalledTimes(1);
  });

  it("refuses a value that is not a boolean", () => {
    // A JS caller can pass any value; the type allows a boolean only.
    const input = { ...base, openapi: "yes" } as unknown as Parameters<typeof resolveConfig>[0];
    expect(() => resolveConfig(input)).toThrow(ConfigError);
    expect(() => resolveConfig(input)).toThrow("openapi must be true or false");
  });
});
