import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_TEST_MS } from "../helpers.js";
import { scim, type ScimTokenWorld as World, scimTokenWorld as world } from "./helpers.js";

// The limits of the SCIM server (plan 12d Task 12): the per-token limit of
// Task 9, the body and operation caps of Tasks 9 and 10, and the member cap
// of Task 11. The measure of a list with no filter (open point 8) is a named
// measure, out of this gate: test/measure/scim-list.measure.ts. The Postgres
// half of the measure is adapter-postgres scim-list-measure.test.ts: core
// tests have no Postgres.

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";

beforeEach(() => {
  // A refused request and a kept owner row each write one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const patch = (...ops: Record<string, unknown>[]) => ({ schemas: [PATCH_URN], Operations: ops });

async function status(w: World, method: string, path: string, body?: unknown) {
  const res = await scim(w, w.token, method, path, body);
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
  };
}

/** A SCIM User through the route: its id. */
async function user(w: World, local: string): Promise<string> {
  const r = await status(w, "POST", "/Users", {
    schemas: [USER_URN],
    userName: `${local}@acme.example`,
  });
  if (r.status !== 201) throw new Error(`create ${local}: ${r.status}`);
  return String(r.body.id);
}

describe("the SCIM limits (plan 12d Task 12)", () => {
  it(
    "answers 429 at the per-token limit",
    async () => {
      const w = await world();
      // 1200 calls in 480 s of the test clock, inside the window of 600 s.
      for (let i = 1; i <= 1200; i++) {
        const res = await scim(w, w.token, "GET", "/ServiceProviderConfig");
        if (res.status !== 200) expect(res.status, `call ${i}`).toBe(200);
        w.clock.advance(400);
      }
      const refused = await scim(w, w.token, "GET", "/ServiceProviderConfig");
      expect(refused.status).toBe(429);
      expect(refused.headers.get("content-type")).toBe("application/scim+json");
      expect(await refused.json()).toEqual({
        schemas: [ERROR_URN],
        status: "429",
        detail: "too many requests; try again later",
      });
    },
    LONG_TEST_MS,
  );

  it(
    "answers 413 above 1 MB and 400 above the operation and member caps",
    async () => {
      const w = await world();
      // The body cap of Task 9: 1 048 576 bytes pass the read, one more answers 413.
      const shell = JSON.stringify({
        schemas: [USER_URN],
        userName: "big@acme.example",
        title: "",
      });
      const at = shell.replace('"title":""', `"title":"${"x".repeat(1_048_576 - shell.length)}"`);
      expect(new TextEncoder().encode(at).length).toBe(1_048_576);
      const fits = await status(w, "POST", "/Users", at);
      // The body reads, and the data cap of Task 10 refuses it.
      expect([fits.status, fits.body.scimType]).toEqual([400, "invalidValue"]);
      const over = await status(w, "POST", "/Users", at.replace('"title":"', '"title":"x'));
      expect([over.status, over.body.status]).toEqual([413, "413"]);

      // The operation cap of Task 10: 100 operations pass, 101 answer 400 invalidValue.
      const id = await user(w, "ada");
      const ops = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ op: "replace", path: "title", value: `t${i}` }));
      const hundred = await status(w, "PATCH", `/Users/${id}`, patch(...ops(100)));
      expect([hundred.status, hundred.body.title]).toEqual([200, "t99"]);
      const more = await status(w, "PATCH", `/Users/${id}`, patch(...ops(101)));
      expect([more.status, more.body.scimType]).toEqual([400, "invalidValue"]);

      // The member cap of ruling 84: 1000 values in one request pass, 1001 answer 400
      // invalidValue.
      const users: string[] = [];
      for (let i = 0; i < 1001; i++) users.push(await user(w, `m${i}`));
      const group = await status(w, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Eng",
      });
      const gid = String(group.body.id);
      const add = (values: string[]) =>
        status(
          w,
          "PATCH",
          `/Groups/${gid}`,
          patch({ op: "add", path: "members", value: values.map((value) => ({ value })) }),
        );
      const past = await add(users);
      expect([past.status, past.body.scimType]).toEqual([400, "invalidValue"]);
      expect((await status(w, "GET", `/Groups/${gid}`)).body.members).toBeUndefined();
      expect((await add(users.slice(0, 1000))).status).toBe(204);
    },
    LONG_TEST_MS,
  );
});
