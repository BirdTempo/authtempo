import { describe, expect, it } from "vitest";
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
