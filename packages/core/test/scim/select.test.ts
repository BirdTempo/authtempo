import { describe, expect, it } from "vitest";
import { pageParams, selectAttributes } from "../../src/engine/scim/select.js";

const url = (query: string) => new URL(`https://api.example.com/auth/scim/v2/Users${query}`);

/** The scimType and detail of a refusal, or the page of an accepted query. */
async function pageOf(query: string) {
  const r = pageParams(url(query));
  if (r.ok) return { startIndex: r.startIndex, count: r.count };
  return { status: r.response.status, body: await r.response.json() };
}

const KNOWN = new Set(["id", "schemas", "meta", "username", "name", "emails", "active"]);
const USER = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  id: "u1",
  userName: "a@acme.example",
  name: { givenName: "A" },
  emails: [{ value: "a@acme.example" }],
  active: true,
  meta: { resourceType: "User" },
};

describe("the paging and the attributes of a SCIM list (plan 12d Task 9)", () => {
  it("pages by startIndex and count", async () => {
    const accepted: [string, { startIndex: number; count: number }][] = [
      ["", { startIndex: 1, count: 100 }],
      ["?count=1", { startIndex: 1, count: 1 }],
      ["?startIndex=0", { startIndex: 1, count: 100 }],
      ["?startIndex=-5&count=-1", { startIndex: 1, count: 0 }],
      ["?startIndex=7&count=500", { startIndex: 7, count: 100 }],
      ["?count=0", { startIndex: 1, count: 0 }],
    ];
    for (const [query, page] of accepted)
      expect([query, await pageOf(query)]).toEqual([query, page]);
    const refused: [string, string][] = [
      ["?count=x", "count must be one integer"],
      ["?count=1.5", "count must be one integer"],
      ["?startIndex=", "startIndex must be one integer"],
      ["?count=1&count=2", "count must be one integer"],
      ["?sortBy=id", "this server does not sort; a list comes in the order of its id"],
      ["?sortOrder=descending", "this server does not sort; a list comes in the order of its id"],
    ];
    for (const [query, detail] of refused)
      expect([query, await pageOf(query)]).toEqual([
        query,
        {
          status: 400,
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
            status: "400",
            scimType: "invalidValue",
            detail,
          },
        },
      ]);
  });

  it("returns the named attributes, and always id, schemas, and meta", async () => {
    const pick = (query: string) => {
      const r = selectAttributes(USER, url(query), KNOWN);
      return r.ok ? Object.keys(r.value) : r.response.status;
    };
    expect(pick("")).toEqual(Object.keys(USER));
    expect(pick("?attributes=USERNAME")).toEqual(["schemas", "id", "userName", "meta"]);
    expect(pick("?attributes=emails,%20active")).toEqual([
      "schemas",
      "id",
      "emails",
      "active",
      "meta",
    ]);
    expect(pick("?excludedAttributes=name,emails,id")).toEqual([
      "schemas",
      "id",
      "userName",
      "active",
      "meta",
    ]);
    for (const query of [
      "?attributes=userName&excludedAttributes=name",
      "?attributes=password",
      "?attributes=emails.value",
      "?attributes=userName,",
      "?attributes=a&attributes=b",
    ])
      expect([query, pick(query)]).toEqual([query, 400]);
  });
});

/**
 * The two node:fs calls of the layer check. Core's typecheck has no Node
 * types, because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface SourceFs {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

describe("the layers of the SCIM engine (review l2 of plan 12d Task 9b)", () => {
  it("reads no http module from engine/scim, so no import cycle runs through the routes", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const dir = new URL("../../src/engine/scim/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const reads = files.flatMap((f) =>
      [...readFileSync(new URL(f, dir), "utf8").matchAll(/from "([^"]+)"/g)]
        .map((m) => m[1] ?? "")
        .filter((spec) => spec.includes("/http/"))
        .map((spec) => `${f} ${spec}`),
    );
    expect(reads).toEqual([]);
  });
});
