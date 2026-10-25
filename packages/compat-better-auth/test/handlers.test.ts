import { describe, expect, it } from "vitest";
import { BetterAuthCompatError } from "../src/compat-error.js";
import { toNextJsHandler } from "../src/next-js.js";
import { toNodeHandler } from "../src/node.js";

const echo = {
  async handler(request: Request) {
    const body = request.method === "POST" ? await request.text() : "";
    const res = new Response(JSON.stringify({ method: request.method, url: request.url, body }), {
      status: 201,
    });
    res.headers.append("set-cookie", "a=1");
    res.headers.append("set-cookie", "b=2");
    return res;
  },
};

describe("toNextJsHandler", () => {
  it("answers every method with the handler", async () => {
    const h = toNextJsHandler(echo);
    expect(Object.keys(h).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
    expect(
      (await h.POST(new Request("https://x.test/api/auth/sign-out", { method: "POST" }))).status,
    ).toBe(201);
  });
});

describe("toNodeHandler", () => {
  it("turns a Node request into a Request and writes the Response back, every cookie kept", async () => {
    const chunks = [new TextEncoder().encode('{"a"'), new TextEncoder().encode(":1}")];
    const req = Object.assign(
      (async function* () {
        yield* chunks;
      })(),
      {
        method: "POST",
        url: "/api/auth/x?y=1",
        headers: { host: "api.example.com", "x-forwarded-proto": "https" },
      },
    );
    const out: { status: number; headers: Record<string, string | string[]>; body: string } = {
      status: 0,
      headers: {},
      body: "",
    };
    await toNodeHandler(echo)(req, {
      set statusCode(v: number) {
        out.status = v;
      },
      get statusCode() {
        return out.status;
      },
      setHeader(k, v) {
        out.headers[k] = v;
      },
      end(body) {
        out.body = new TextDecoder().decode(body);
      },
    });
    expect(out.status).toBe(201);
    expect(out.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(JSON.parse(out.body)).toEqual({
      method: "POST",
      url: "https://api.example.com/api/auth/x?y=1",
      body: '{"a":1}',
    });
  });
});

// B L2 of the plan 12i final review: a serverless host keeps the work after
// the answer only through its waitUntil, so both handlers pass it on.
describe("the host's waitUntil", () => {
  const nodeRes = () => ({
    statusCode: 0,
    setHeader() {},
    end() {},
  });
  const nodeReq = () =>
    Object.assign((async function* () {})(), {
      method: "GET",
      url: "/api/auth/ok",
      headers: { host: "api.example.com" },
    });

  it("passes it to each request of toNextJsHandler and toNodeHandler, and passes none without it", async () => {
    const seen: unknown[] = [];
    const recorder = async (_r: Request, options?: unknown) => {
      seen.push(options);
      return new Response(null, { status: 204 });
    };
    const kept: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => void kept.push(p);
    await toNextJsHandler(recorder, { waitUntil }).GET(new Request("https://x.test/api/auth/ok"));
    await toNodeHandler(recorder, { waitUntil })(nodeReq(), nodeRes());
    await toNextJsHandler(recorder).POST(
      new Request("https://x.test/api/auth/ok", { method: "POST" }),
    );
    await toNodeHandler(recorder)(nodeReq(), nodeRes());
    expect(seen).toEqual([{ waitUntil }, { waitUntil }, undefined, undefined]);
  });

  it("keeps the instance as this for an object's handler", async () => {
    const seen: unknown[] = [];
    const instance = {
      options: { advanced: { ipAddress: { disableIpTracking: true } } },
      label: "own",
      async handler(this: { label: string }, _r: Request, options?: unknown) {
        seen.push([this.label, options]);
        return new Response(null, { status: 204 });
      },
    };
    const waitUntil = () => {};
    await toNextJsHandler(instance, { waitUntil }).GET(new Request("https://x.test/api/auth/ok"));
    await toNodeHandler(instance)(nodeReq(), nodeRes());
    expect(seen).toEqual([
      ["own", { waitUntil }],
      ["own", undefined],
    ]);
  });
});

describe("the IP setting off Workers (plan 9 final review M-2)", () => {
  const instance = (options: object) => ({ ...echo, options });
  const make = { toNextJsHandler, toNodeHandler };

  for (const [name, wrap] of Object.entries(make)) {
    it(`${name} refuses an instance with no IP header setting, at creation`, () => {
      for (const options of [
        {},
        { advanced: {} },
        { advanced: { ipAddress: { ipAddressHeaders: [] } } },
      ]) {
        let err: unknown = null;
        try {
          wrap(instance(options));
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(BetterAuthCompatError);
        expect((err as BetterAuthCompatError).refusals).toEqual([
          "advanced.ipAddress: off Workers any caller sets cf-connecting-ip, so every per-IP limit can be rotated; set ipAddressHeaders to the header your proxy writes, or disableIpTracking: true",
        ]);
      }
    });

    it(`${name} accepts ipAddressHeaders, disableIpTracking: true, and a bare handler`, () => {
      expect(() =>
        wrap(instance({ advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } } })),
      ).not.toThrow();
      expect(() =>
        wrap(instance({ advanced: { ipAddress: { disableIpTracking: true } } })),
      ).not.toThrow();
      expect(() => wrap(echo.handler)).not.toThrow();
    });
  }
});
