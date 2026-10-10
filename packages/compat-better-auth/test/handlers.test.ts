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
