import { describe, expect, it } from "vitest";
// Core does not export its readers, so the test reads core's own source (ruling 38).
import { readBody } from "../../../../packages/core/src/http/body.ts";
import { readJson } from "../../../../packages/core/src/http/json.ts";
import { readBodyField, readJsonField } from "../../src/read-body.ts";

/** A schema that takes any value, so the result shows what core read. */
const ANY = { safeParse: (data: unknown) => ({ success: true, data }) } as never;

function fieldOf(raw: unknown, name: string): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value: unknown = Reflect.get(raw, name);
  return typeof value === "string" ? value : null;
}

const BODIES: Record<string, string> = {
  json: '{"email":"a@example.com","token":"t1"}',
  form: "email=a%40example.com&token=t1",
  twoWay: '{"email":"a@example.com","token":"t1","z":"&email=b@example.com&token=t2&"}',
  repeated: "email=a%40example.com&email=b%40example.com&token=t1&token=t2",
  repeatedOther: "email=a%40example.com&x=1&x=2&token=t1",
  number: '{"email":1,"token":["t1"]}',
  array: '["a@example.com"]',
  empty: "",
};

const TYPES: (string | null)[] = [
  null,
  "application/json",
  "application/x-www-form-urlencoded",
  "application/json; charset=utf-8",
  "Application/JSON ; charset=utf-8",
  "application/x-www-form-urlencoded; charset=utf-8",
  "application/x-www-form-urlencoded; x=application/json",
  "text/plain",
  "application/json-seq",
  "x-application/json",
];

function request(body: string, type: string | null): Request {
  const headers = new Headers();
  if (type !== null) headers.set("content-type", type);
  // Bytes, not a string: a string body would add text/plain to a request with no type.
  return new Request("https://demo.authtempo.com/auth/x", {
    method: "POST",
    headers,
    body: new TextEncoder().encode(body),
  });
}

async function coreField(
  reader: typeof readJson,
  req: Request,
  name: string,
): Promise<string | null> {
  const result = await reader(req, ANY);
  return result.ok ? fieldOf(result.value, name) : null;
}

describe("the body readers of the demo against core", () => {
  for (const [label, core, demo] of [
    ["readJson", readJson, readJsonField],
    ["readBody", readBody, readBodyField],
  ] as const) {
    it(`reads each body and type as ${label} of core does`, async () => {
      const differ: string[] = [];
      let read = 0;
      for (const [kind, body] of Object.entries(BODIES))
        for (const type of TYPES)
          for (const name of ["email", "token"]) {
            const want = await coreField(core, request(body, type), name);
            const got = await demo(request(body, type), name);
            if (want !== null) read += 1;
            if (want !== got) differ.push(`${kind} ${type} ${name}: core ${want}, demo ${got}`);
          }
      expect(differ).toEqual([]);
      // The matrix holds bodies that core reads, not only refusals.
      expect(read).toBeGreaterThan(4);
    });
  }

  it("reads the two-way body of the review as core does on each route kind", async () => {
    const body = BODIES.twoWay ?? "";
    const form = "application/x-www-form-urlencoded";
    expect(await readJsonField(request(body, form), "email")).toBe("a@example.com");
    expect(await readBodyField(request(body, `${form}; x=application/json`), "token")).toBe("t2");
  });
});
