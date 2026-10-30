import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH_MEMBERS_MAX } from "../../src/engine/scim/limits.js";
import { PATCH_OPS_MAX, PATCH_VALUE_DEPTH_MAX, parsePatch } from "../../src/engine/scim/patch.js";
import { readUser, SCIM_DATA_MAX } from "../../src/engine/scim/users.js";
import {
  BODY_DEPTH_MAX,
  BODY_ITEMS_MAX,
  jsonShapeFits,
  LARGE_READ_IDLE_MS,
} from "../../src/http/body-cap.js";
import { SCIM_BODY_MAX, SCIM_ITEMS_MAX } from "../../src/http/routes/scim.js";
import { BASE_URL, LONG_TEST_MS } from "../helpers.js";
import { SCIM_IP, scim, type ScimTokenWorld as World, scimTokenWorld as world } from "./helpers.js";

// The limits of the SCIM server (plan 12d Task 12): the per-token limit of
// Task 9, the body and operation caps of Tasks 9 and 10, and the member cap
// of Task 11. The shape scan of the body (ruling 56 of the 12j lane) runs
// before the parse. The measure of a list with no filter (open point 8) is
// a named measure, out of this gate: test/measure/scim-list.measure.ts. The
// Postgres half of the measure is adapter-postgres scim-list-measure.test.ts:
// core tests have no Postgres.

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";
const ENTRA_GROUP_URN = "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group";

beforeEach(() => {
  // A refused request and a kept owner row each write one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

/** The items of a JSON text: each `[`, `{`, and `,` outside a string, as the shape scan counts them. */
function itemsOf(text: string): number {
  let items = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{" || c === ",") items++;
  }
  return items;
}

/** A member in the full form of RFC 7643 section 4.2: `value`, `display`, `$ref`, and `type`. */
const fullMember = (value: string, i: number) => ({
  value,
  display: `m${i}@acme.example`,
  $ref: `${BASE_URL}/auth/scim/v2/Users/${value}`,
  type: "User",
});

/**
 * A stream of `bytes` spaces that sends `before` bytes in chunks of 64 KiB,
 * then waits until `open` runs. `atGate` settles when it waits.
 */
function stalledBody(bytes: number, before: number) {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = () => {};
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (sent >= bytes) return c.close();
      if (sent >= before) {
        reached();
        await gate;
      }
      const n = Math.min(65_536, (sent < before ? before : bytes) - sent);
      c.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
  });
  return { stream, open, atGate };
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
      // Each member in the full form of RFC 7643: 1000 of them pass the shape scan (ruling 56).
      const add = (values: string[]) =>
        status(
          w,
          "PATCH",
          `/Groups/${gid}`,
          patch({ op: "add", path: "members", value: values.map(fullMember) }),
        );
      const past = await add(users);
      expect([past.status, past.body.scimType]).toEqual([400, "invalidValue"]);
      expect((await status(w, "GET", `/Groups/${gid}`)).body.members).toBeUndefined();
      expect((await add(users.slice(0, 1000))).status).toBe(204);
    },
    LONG_TEST_MS,
  );

  it("answers 408 in the SCIM error form to a stalled write, and frees its read for the next write", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = stalledBody(SCIM_BODY_MAX, 65_536);
    let answered: Response | null = null;
    void w
      .handle(
        new Request(`${BASE_URL}/auth/scim/v2/Users`, {
          method: "POST",
          headers: {
            "content-type": "application/scim+json",
            authorization: `Bearer ${w.token}`,
            "cf-connecting-ip": SCIM_IP,
          },
          body: stalled.stream,
          duplex: "half",
        } as RequestInit),
      )
      .then((res) => {
        answered = res;
      });
    await stalled.atGate;
    await vi.advanceTimersByTimeAsync(LARGE_READ_IDLE_MS - 1);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const res = answered as Response | null;
    expect(res?.status).toBe(408);
    expect(res?.headers.get("content-type")).toBe("application/scim+json");
    expect(res?.headers.get("retry-after")).toBeNull();
    expect(await res?.json()).toEqual({
      schemas: [ERROR_URN],
      status: "408",
      detail: "the body did not arrive in time",
    });
    stalled.open();
    vi.useRealTimers();
    // The stalled read freed its bytes: the next write of the same IP reads whole.
    const next = await status(w, "POST", "/Users", {
      schemas: [USER_URN],
      userName: "next@acme.example",
    });
    expect(next.status).toBe(201);
  });

  it("answers 400 invalidSyntax before JSON.parse to a body past the depth or the item limit", async () => {
    const w = await world();
    const body = (name: string, x: string) =>
      `{"schemas":["${USER_URN}"],"userName":"${name}@acme.example","x":${x}}`;
    // `x` nests depth - 1 levels in the body object, so the body nests `depth` levels.
    const deep = (name: string, depth: number) =>
      body(name, `${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}`);
    // The body object, schemas, its two commas, and `x` are 5 items; each more zero adds one.
    const wide = (name: string, items: number) => body(name, `[${"0,".repeat(items - 5)}0]`);
    expect(itemsOf(wide("w", SCIM_ITEMS_MAX))).toBe(SCIM_ITEMS_MAX);
    expect(jsonShapeFits(deep("d", BODY_DEPTH_MAX), BODY_DEPTH_MAX - 1)).toBe(false);
    const parse = vi.spyOn(JSON, "parse");
    // At each limit the body reads, and core ignores the attribute `x`.
    expect((await status(w, "POST", "/Users", deep("deep", BODY_DEPTH_MAX))).status).toBe(201);
    expect((await status(w, "POST", "/Users", wide("wide", SCIM_ITEMS_MAX))).status).toBe(201);
    for (const text of [deep("deeper", BODY_DEPTH_MAX + 1), wide("wider", SCIM_ITEMS_MAX + 1)]) {
      const res = await scim(w, w.token, "POST", "/Users", text);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/scim+json");
      expect(await res.json()).toEqual({
        schemas: [ERROR_URN],
        status: "400",
        scimType: "invalidSyntax",
        detail: `the body nests deeper than ${BODY_DEPTH_MAX} or holds more than ${SCIM_ITEMS_MAX} items`,
      });
      expect(parse.mock.calls.filter(([t]) => t === text)).toEqual([]);
    }
  });

  it("derives SCIM_ITEMS_MAX as 8 times the next power of two above the most items of a valid body", async () => {
    // A static import of groups.js first meets an import cycle of the engine; the helpers load it in order.
    const { readGroup } = await import("../../src/engine/scim/groups.js");
    // A Group PATCH of PATCH_OPS_MAX operations that name PATCH_MEMBERS_MAX members in the full form.
    const per = PATCH_MEMBERS_MAX / PATCH_OPS_MAX;
    const id = (i: number) => `u${String(i).padStart(4, "0")}`;
    const members = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => fullMember(id(from + k), from + k));
    const most = patch(
      ...Array.from({ length: PATCH_OPS_MAX }, (_, o) => ({
        op: "add",
        path: "members",
        value: members(o * per, per),
      })),
    );
    expect(parsePatch(most, "Group")).toMatchObject({ ok: true });
    // The PUT of a Group with the same members, as a directory sends it with id and meta.
    const put = {
      schemas: [GROUP_URN, ENTRA_GROUP_URN],
      id: "g",
      externalId: "e",
      displayName: "Eng",
      members: members(0, PATCH_MEMBERS_MAX),
      meta: { resourceType: "Group", created: "c", lastModified: "l", location: "u", version: "v" },
    };
    expect(readGroup(put)).toMatchObject({ ok: true });
    // A User at SCIM_DATA_MAX: `emails` items `{"type":""}`, the most that readUser takes.
    const user = (n: number) => ({
      schemas: [USER_URN],
      userName: "u@acme.example",
      emails: Array.from({ length: n }, () => ({ type: "" })),
    });
    let n = 0;
    while (readUser(user(n + 1)).ok) n++;
    expect(readUser(user(n + 1))).toMatchObject({
      ok: false,
      answer: {
        status: 400,
        body: { detail: `the attributes take more than ${SCIM_DATA_MAX} bytes` },
      },
    });
    const items = [most, put, user(n)].map((b) => itemsOf(JSON.stringify(b)));
    console.log(`scim-body: items PATCH ${items[0]} PUT ${items[1]} User ${items[2]}`);
    expect(items).toEqual([5403, 5013, 2732]);
    // The limit of a route body would refuse the PATCH and the PUT.
    expect(Math.min(items[0] ?? 0, items[1] ?? 0)).toBeGreaterThan(BODY_ITEMS_MAX);
    expect(SCIM_ITEMS_MAX).toBe(8 * 2 ** Math.ceil(Math.log2(items[0] ?? 0)));
    expect(jsonShapeFits(JSON.stringify(most), BODY_DEPTH_MAX, SCIM_ITEMS_MAX)).toBe(true);
    // The deepest valid body: a value of PATCH_VALUE_DEPTH_MAX levels in an operation, 3 levels deep.
    const value = { members: [{ value: id(0) }] };
    const deepest = JSON.stringify(patch({ op: "add", value }));
    expect(parsePatch(JSON.parse(deepest), "Group")).toMatchObject({ ok: true });
    expect(
      parsePatch(patch({ op: "add", value: { members: [{ value: [id(0)] }] } }), "Group"),
    ).toMatchObject({
      ok: false,
      scimType: "invalidValue",
    });
    expect(jsonShapeFits(deepest, 3 + PATCH_VALUE_DEPTH_MAX)).toBe(true);
    expect(jsonShapeFits(deepest, 2 + PATCH_VALUE_DEPTH_MAX)).toBe(false);
    expect(3 + PATCH_VALUE_DEPTH_MAX).toBeLessThanOrEqual(BODY_DEPTH_MAX);
  });
});
