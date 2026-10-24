import { describe, expect, it } from "vitest";
import { createRouter, type Route } from "../../src/http/router.js";
import { scimJson, scimRoute } from "../../src/http/routes/scim.js";
import { BASE_URL } from "../helpers.js";
import { SCIM_IP, scim, scimAuth, scimToken } from "./helpers.js";

const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST_URN = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ENTERPRISE_URN = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const SCIM_BASE = "https://api.example.com/auth/scim/v2";

/** One attribute of a Schema document, by name. */
type Attribute = Record<string, unknown> & { name: string; subAttributes?: Attribute[] };

/** The status and the JSON body of a SCIM answer, with its media type checked. */
async function read(res: Response): Promise<[number, Record<string, unknown>]> {
  expect(res.headers.get("content-type")).toBe("application/scim+json");
  expect(res.headers.get("cache-control")).toBe("no-store");
  return [res.status, (await res.json()) as Record<string, unknown>];
}

describe("the SCIM base (plan 12d Task 9)", () => {
  it("answers the discovery documents with the facts of the server", async () => {
    const w = await scimAuth();
    // Any one scope reads discovery.
    const { token } = await scimToken(w, ["scim.groups.read"]);
    expect(await read(await scim(w, token, "GET", "/ServiceProviderConfig"))).toEqual([
      200,
      {
        schemas: [
          "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
          "urn:authtempo:params:scim:schemas:extension:limits:2.0",
        ],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 100 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: true },
        authenticationSchemes: [
          {
            type: "oauthbearertoken",
            name: "OAuth Bearer Token",
            description: "A SCIM token of the organization as the bearer.",
            primary: true,
          },
        ],
        // The member caps of a Group write, from the D1 budget (plan 12d Task 11).
        "urn:authtempo:params:scim:schemas:extension:limits:2.0": {
          groupMembersMax: 10_000,
          membersPerRequestMax: 9,
          roleRecomputeMax: 250,
        },
        meta: {
          resourceType: "ServiceProviderConfig",
          location: `${SCIM_BASE}/ServiceProviderConfig`,
        },
      },
    ]);
    const user = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: "/Users",
      description: "User Account",
      schema: USER_URN,
      schemaExtensions: [{ schema: ENTERPRISE_URN, required: false }],
      meta: { resourceType: "ResourceType", location: `${SCIM_BASE}/ResourceTypes/User` },
    };
    const [, types] = await read(await scim(w, token, "GET", "/ResourceTypes"));
    expect(types).toMatchObject({ schemas: [LIST_URN], totalResults: 2, startIndex: 1 });
    expect((types.Resources as { id: string }[]).map((r) => r.id)).toEqual(["User", "Group"]);
    expect(await read(await scim(w, token, "GET", "/ResourceTypes/User"))).toEqual([200, user]);
    const [, group] = await read(await scim(w, token, "GET", "/ResourceTypes/Group"));
    expect([group.endpoint, group.schema, group.schemaExtensions]).toEqual([
      "/Groups",
      GROUP_URN,
      undefined,
    ]);
    const [, schemas] = await read(await scim(w, token, "GET", "/Schemas"));
    expect(schemas).toMatchObject({ totalResults: 3, itemsPerPage: 3 });
    expect((schemas.Resources as { id: string }[]).map((r) => r.id)).toEqual([
      USER_URN,
      GROUP_URN,
      ENTERPRISE_URN,
    ]);
    const [s1, userSchema] = await read(await scim(w, token, "GET", `/Schemas/${USER_URN}`));
    expect([s1, userSchema.name, userSchema.meta]).toEqual([
      200,
      "User",
      { resourceType: "Schema", location: `${SCIM_BASE}/Schemas/${USER_URN}` },
    ]);
    const attrs = userSchema.attributes as Attribute[];
    const byName = (list: Attribute[], name: string) => list.find((a) => a.name === name);
    // RFC 7643 section 8.7.1: no common attribute and no password; userName unique and required.
    for (const gone of ["id", "externalId", "meta", "schemas", "password"])
      expect(byName(attrs, gone), gone).toBeUndefined();
    expect(byName(attrs, "userName")).toEqual({
      name: "userName",
      type: "string",
      multiValued: false,
      required: true,
      caseExact: false,
      mutability: "readWrite",
      returned: "default",
      uniqueness: "server",
    });
    const emails = byName(attrs, "emails");
    expect([emails?.type, emails?.multiValued]).toEqual(["complex", true]);
    expect(emails?.subAttributes?.map((s) => [s.name, s.type, s.canonicalValues])).toEqual([
      ["value", "string", undefined],
      ["display", "string", undefined],
      ["type", "string", ["work", "home", "other"]],
      ["primary", "boolean", undefined],
    ]);
    const groups = byName(attrs, "groups");
    expect([groups?.mutability, groups?.subAttributes?.map((s) => s.mutability)]).toEqual([
      "readOnly",
      ["readOnly", "readOnly", "readOnly", "readOnly"],
    ]);
    expect(byName(attrs, "profileUrl")).toMatchObject({
      type: "reference",
      referenceTypes: ["external"],
    });
    const [, groupSchema] = await read(await scim(w, token, "GET", `/Schemas/${GROUP_URN}`));
    const members = byName(groupSchema.attributes as Attribute[], "members");
    expect(members?.subAttributes?.map((s) => [s.name, s.mutability])).toEqual([
      ["value", "immutable"],
      ["display", "immutable"],
      ["type", "immutable"],
      ["$ref", "immutable"],
    ]);
    expect(byName(groupSchema.attributes as Attribute[], "displayName")).toMatchObject({
      required: true,
      uniqueness: "server",
    });
    const [, enterprise] = await read(await scim(w, token, "GET", `/Schemas/${ENTERPRISE_URN}`));
    expect((enterprise.attributes as Attribute[]).map((a) => a.name)).toEqual([
      "employeeNumber",
      "costCenter",
      "organization",
      "division",
      "department",
      "manager",
    ]);
    // RFC 7643 section 4.3: manager is complex (ruling 24, i5 of plan 12d).
    const manager = byName(enterprise.attributes as Attribute[], "manager");
    expect([manager?.type, manager?.subAttributes?.map((x) => [x.name, x.mutability])]).toEqual([
      "complex",
      [
        ["value", "readWrite"],
        ["$ref", "readWrite"],
        ["displayName", "readOnly"],
      ],
    ]);
    for (const path of ["/Schemas/urn:x:y", "/ResourceTypes/Device"])
      expect(await read(await scim(w, token, "GET", path))).toEqual([
        404,
        { schemas: [ERROR_URN], status: "404", detail: "no resource of this endpoint has the id" },
      ]);
  });

  it("ignores the paging of the discovery lists and refuses a filter (RFC 7644 section 4)", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    for (const query of ["?count=1", "?startIndex=3&count=0", "?sortBy=id", "?count=x"]) {
      const [status, body] = await read(await scim(w, token, "GET", `/Schemas${query}`));
      expect([query, status, body.totalResults, (body.Resources as unknown[]).length]).toEqual([
        query,
        200,
        3,
        3,
      ]);
    }
    for (const path of ["/Schemas", "/ResourceTypes"])
      expect(
        await read(
          await scim(w, token, "GET", `${path}?filter=${encodeURIComponent('id eq "User"')}`),
        ),
      ).toEqual([
        403,
        { schemas: [ERROR_URN], status: "403", detail: "the discovery lists take no filter" },
      ]);
  });

  it("answers 501 to bulk, Me, and search", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w, ["scim.users.read"]);
    const routes: [string, string][] = [
      ["POST", "/Bulk"],
      ["GET", "/Me"],
      ["POST", "/.search"],
      ["POST", "/Users/.search"],
      ["POST", "/Groups/.search"],
    ];
    for (const [method, path] of routes) {
      const body = method === "POST" ? { schemas: [] } : undefined;
      expect([path, ...(await read(await scim(w, token, method, path, body)))]).toEqual([
        path,
        501,
        { schemas: [ERROR_URN], status: "501", detail: "not supported by this server" },
      ]);
      // With no token, the route answers 401 first.
      expect((await scim(w, null, method, path, body)).status).toBe(401);
    }
  });

  it("refuses a body that is too large, of another type, not UTF-8, or not JSON", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const seen: unknown[] = [];
    const routes: Route[] = [
      scimRoute({
        method: "POST",
        path: "/scim/v2/Probe",
        // A test stub of a path outside ROUTES has no key (ruling 3 of plan 12d).
        key: undefined as never,
        scope: "scim.users.write",
        body: true,
        async handle(_ctx, _caller, body) {
          seen.push(body);
          return scimJson({ ok: true });
        },
      }),
    ];
    const probe = { handle: createRouter(w.config, routes) };
    const big = JSON.stringify({ a: "x".repeat(1_048_576) });
    expect(await read(await scim(probe, token, "POST", "/Probe", big))).toEqual([
      413,
      {
        schemas: [ERROR_URN],
        status: "413",
        detail: "the body is more than 1048576 bytes",
      },
    ]);
    // A body of 2 KB in Latin-1: each é is the one byte 0xE9, which is no UTF-8.
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode('{"a":"'),
      ...new Uint8Array(2040).fill(0xe9),
      ...new TextEncoder().encode('"}'),
    ]);
    expect(latin1.length).toBe(2048);
    const notUtf8 = await probe.handle(
      new Request(`${BASE_URL}/auth/scim/v2/Probe`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": SCIM_IP,
          authorization: `Bearer ${token}`,
          "content-type": "application/scim+json",
        },
        body: latin1,
      }),
    );
    expect(await read(notUtf8)).toEqual([
      400,
      {
        schemas: [ERROR_URN],
        status: "400",
        scimType: "invalidSyntax",
        detail: "the body is not UTF-8",
      },
    ]);
    expect(
      await read(
        await scim(probe, token, "POST", "/Probe", "{}", { "content-type": "text/plain" }),
      ),
    ).toEqual([
      400,
      {
        schemas: [ERROR_URN],
        status: "400",
        scimType: "invalidSyntax",
        detail: "the body must be application/scim+json or application/json",
      },
    ]);
    expect(await read(await scim(probe, token, "POST", "/Probe", "{"))).toEqual([
      400,
      {
        schemas: [ERROR_URN],
        status: "400",
        scimType: "invalidSyntax",
        detail: "the body is not JSON",
      },
    ]);
    expect(seen).toEqual([]);
    // The two media types, with a parameter, and a body of exactly 1 MB, pass.
    const exact = JSON.stringify({ a: "x".repeat(1_048_576 - 8) });
    expect(new TextEncoder().encode(exact).length).toBe(1_048_576);
    for (const type of ["application/scim+json; charset=utf-8", "application/json"])
      expect(
        (await scim(probe, token, "POST", "/Probe", exact, { "content-type": type })).status,
      ).toBe(200);
    expect(seen).toHaveLength(2);
  });
});
