import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  openApiDocument,
  openApiOptionsFrom,
  openApiReferenceOptions,
} from "../src/openapi/index.js";
import { base } from "./every-feature.js";
// Vite reads each file from disk at the import. No test reads a URL (README.md of the folder).
import dialectText from "./fixtures/oas-3.1/dialect.json?raw";
import metaText from "./fixtures/oas-3.1/meta.json?raw";
import schemaText from "./fixtures/oas-3.1/schema.json?raw";
import schemaBaseText from "./fixtures/oas-3.1/schema-base.json?raw";

type Json = Record<string, unknown>;

const SCHEMA_BASE_ID = "https://spec.openapis.org/oas/3.1/schema-base/2026-08-03";

/** Each vendored file and its SHA-256 from the fixture README. */
const FILES = [
  {
    name: "schema.json",
    text: schemaText,
    sha256: "59f106413cb48c31299f96f024c938d3628aed6cd02cd14bcfb2fcaae7a130b6",
  },
  {
    name: "schema-base.json",
    text: schemaBaseText,
    sha256: "ffdd07e28417bfa89de635d23a7476f7625497b8edd279f18c1424e613966d9a",
  },
  {
    name: "dialect.json",
    text: dialectText,
    sha256: "647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460",
  },
  {
    name: "meta.json",
    text: metaText,
    sha256: "80706a9a404affedbf84ac4dc1328c9ce0d2a00804cdfc4d95c0ddd0053121dd",
  },
];

// Ajv 8.20.0 resolves `$dynamicRef` only to a `$dynamicAnchor` at a schema root. The OpenAPI
// files put the anchor "meta" under `$defs/schema`, so Ajv sends each "#meta" back to the object
// that holds it, and every Schema Object fails. The validation starts at schema-base, whose
// `$defs/schema` is the outermost "meta" anchor, so dynamic resolution always reaches it. Our
// document declares the base dialect, so a static `$ref` to that anchor is the same rule.
const DYNAMIC_META = '"$dynamicRef": "#meta"';
const STATIC_META = `"$ref": "${SCHEMA_BASE_ID}#/$defs/schema"`;

/** The number of times `part` occurs in `text`. */
function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** The validator of `schema-base`: the OpenAPI 3.1 schema with the Schema Object dialect. */
function validator(): ValidateFunction {
  const ajv = new Ajv2020({
    // The vendored schema is not ours, and strict mode refuses some of its keywords.
    strict: false,
    // Draft 2020-12 reads `format` as an annotation by default; the proof does not need it.
    validateFormats: false,
    allErrors: true,
  });
  for (const { text } of FILES) {
    const read = text === schemaText ? text.replaceAll(DYNAMIC_META, STATIC_META) : text;
    const schema = JSON.parse(read) as Json & { $id: string };
    ajv.addSchema(schema, schema.$id);
  }
  const validate = ajv.getSchema(SCHEMA_BASE_ID);
  if (validate === undefined) throw new Error(`no schema ${SCHEMA_BASE_ID}`);
  return validate;
}

/** A deep copy of the site's document, which a test can change. */
function siteDocument(): Json {
  return structuredClone(openApiDocument(openApiReferenceOptions())) as unknown as Json;
}

/** A document of one operation whose 200 answer has the schema `schema`. */
function oneSchemaDocument(schema: unknown): Json {
  return {
    openapi: "3.1.2",
    info: { title: "probe", version: "1" },
    paths: {
      "/probe": {
        get: {
          responses: {
            "200": { description: "ok", content: { "application/json": { schema } } },
          },
        },
      },
    },
  };
}

/** The first object in a depth-first walk that `match` accepts. */
function firstNode(value: unknown, match: (node: Json) => boolean): Json | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && match(value as Json)) return value as Json;
  for (const child of Object.values(value)) {
    const found = firstNode(child, match);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The first response object of the first operation of a document. */
function firstResponse(doc: Json): Json {
  const paths = doc.paths as Record<string, Record<string, { responses: Record<string, Json> }>>;
  const item = Object.values(paths)[0];
  const op = item === undefined ? undefined : Object.values(item)[0];
  const response = op === undefined ? undefined : Object.values(op.responses)[0];
  if (response === undefined) throw new Error("the document has no response");
  return response;
}

/** The SHA-256 of a text as lowercase hex. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the vendored OpenAPI 3.1 schema files (plan 11g)", () => {
  it.each(FILES)("holds $name to its SHA-256 in the README", async ({ text, sha256: hash }) => {
    expect(await sha256(text)).toBe(hash);
  });

  it("replaces exactly four dynamic refs, and the files hold no other", () => {
    const all = FILES.map((f) => f.text).join("\n");
    expect(countOf(all, '"$dynamicRef"')).toBe(4);
    expect(countOf(schemaText, DYNAMIC_META)).toBe(4);
    const read = schemaText.replaceAll(DYNAMIC_META, STATIC_META);
    expect(countOf(read, '"$dynamicRef"')).toBe(0);
    expect(countOf(read, STATIC_META)).toBe(4);
  });
});

describe("the OpenAPI document against the OpenAPI 3.1 schema (plan 11g)", () => {
  it("validates the site's document", () => {
    const validate = validator();
    const valid = validate(openApiDocument(openApiReferenceOptions()));
    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("validates the document of a minimal config with openapi on", () => {
    const validate = validator();
    const doc = openApiDocument(openApiOptionsFrom(resolveConfig({ ...base, openapi: true })));
    const valid = validate(doc);
    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("refuses a response with no description", () => {
    const doc = siteDocument();
    const response = firstResponse(doc);
    expect(typeof response.description).toBe("string");
    delete response.description;
    expect(validator()(doc)).toBe(false);
  });

  it("refuses a schema with a wrong type name", () => {
    const doc = siteDocument();
    const schema = firstNode(doc.paths, (node) => node.type === "string");
    expect(schema).toBeDefined();
    if (schema !== undefined) schema.type = "strin";
    expect(validator()(doc)).toBe(false);
  });

  it("accepts the probe document with a valid schema", () => {
    const validate = validator();
    const valid = validate(
      oneSchemaDocument({
        type: "object",
        properties: { a: { type: "string", minLength: 1 } },
        anyOf: [{ type: "object" }],
        discriminator: { propertyName: "a" },
      }),
    );
    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it.each([
    { where: "a wrong type name at the top", schema: { type: "strin" } },
    {
      where: "a wrong type name in properties",
      schema: { properties: { a: { type: "strin" } } },
    },
    { where: "a wrong type name in anyOf", schema: { anyOf: [{ type: "strin" }] } },
    {
      where: "a discriminator with no propertyName",
      schema: { type: "object", discriminator: {} },
    },
    { where: "a negative minLength", schema: { type: "string", minLength: -1 } },
  ])("refuses a schema with $where", ({ schema }) => {
    expect(validator()(oneSchemaDocument(schema))).toBe(false);
  });

  it("reads no URL", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const validate = validator();
      validate(openApiDocument(openApiReferenceOptions()));
      validate(openApiDocument(openApiOptionsFrom(resolveConfig({ ...base, openapi: true }))));
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
