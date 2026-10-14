import { describe, expect, it } from "vitest";
import { createTransport } from "../src/transport.js";

const BASE = "https://api.example.com";

function answering(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: Request[] = [];
  const inits: RequestInit[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    inits.push(init ?? {});
    return new Response(body, { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, inits };
}

describe("createTransport", () => {
  it("builds the URL from baseURL and basePath, sends JSON, and includes credentials", async () => {
    const f = answering(200, `{"sent":true}`, { "content-type": "application/json" });
    const call = createTransport({ baseURL: BASE, fetch: f.fetch });
    const r = await call<{ sent: true }>("POST", "/magic-link/request", { email: "a@b.c" });
    expect(r).toEqual({ ok: true, value: { sent: true } });
    const req = f.calls[0];
    if (!req) throw new Error("no call");
    expect(req.url).toBe(`${BASE}/auth/magic-link/request`);
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.text()).toBe(`{"email":"a@b.c"}`);
    // The init carries credentials; a server-side Request may not keep the field.
    expect(f.inits[0]?.credentials).toBe("include");
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("sends the bearer header when token() answers a string, and nothing when it answers null", async () => {
    const f = answering(200, `{}`);
    let token: string | null = "ts_abc";
    const call = createTransport({ baseURL: BASE, fetch: f.fetch, token: async () => token });
    await call("GET", "/session");
    expect(f.calls[0]?.headers.get("authorization")).toBe("Bearer ts_abc");
    token = null;
    await call("GET", "/session");
    expect(f.calls[1]?.headers.get("authorization")).toBeNull();
  });

  it("maps a known error code to a failure with the status", async () => {
    const f = answering(429, `{"error":"rate_limited"}`);
    const call = createTransport({ baseURL: BASE, fetch: f.fetch });
    expect(await call("POST", "/magic-link/request", {})).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
  });

  it("keeps the message of a hook refusal, and adds none to another code (plan 9d)", async () => {
    const refused = answering(403, `{"error":"hook_refused","message":"Choose another name."}`);
    expect(
      await createTransport({ baseURL: BASE, fetch: refused.fetch })(
        "POST",
        "/organizations/create",
        {},
      ),
    ).toEqual({ ok: false, code: "hook_refused", status: 403, message: "Choose another name." });
    const missing = answering(404, `{"error":"not_found"}`);
    expect(
      await createTransport({ baseURL: BASE, fetch: missing.fetch })("GET", "/session"),
    ).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    // A message on another code is dropped (parked Minor 2).
    const other = answering(404, `{"error":"not_found","message":"from a proxy"}`);
    expect(await createTransport({ baseURL: BASE, fetch: other.fetch })("GET", "/session")).toEqual(
      {
        ok: false,
        code: "not_found",
        status: 404,
      },
    );
  });

  it("maps an unknown code, a non-JSON body, and an error status with a JSON body to unexpected", async () => {
    for (const [status, body] of [
      [400, `{"error":"brand_new_code"}`],
      [502, `<html>bad gateway</html>`],
      [500, `{"message":"boom"}`],
    ] as const) {
      const f = answering(status, body);
      const call = createTransport({ baseURL: BASE, fetch: f.fetch });
      expect(await call("GET", "/session")).toEqual({ ok: false, code: "unexpected", status });
    }
  });

  it("treats an inherited key as unknown: a body of toString is unexpected (M-9)", async () => {
    const f = answering(400, `{"error":"toString"}`);
    const call = createTransport({ baseURL: BASE, fetch: f.fetch });
    expect(await call("GET", "/session")).toEqual({ ok: false, code: "unexpected", status: 400 });
  });

  it("strips one trailing slash from baseURL (M-7)", async () => {
    const f = answering(200, `{}`);
    const call = createTransport({ baseURL: `${BASE}/`, fetch: f.fetch });
    await call("GET", "/session");
    expect(f.calls[0]?.url).toBe(`${BASE}/auth/session`);
  });

  it("answers network with status 0 when fetch rejects", async () => {
    const call = createTransport({
      baseURL: BASE,
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    expect(await call("GET", "/session")).toEqual({ ok: false, code: "network", status: 0 });
  });

  it("uses the basePath given and GET sends no body", async () => {
    const f = answering(200, `{"ok":true}`);
    const call = createTransport({ baseURL: BASE, basePath: "/api/auth", fetch: f.fetch });
    await call("GET", "/session");
    expect(f.calls[0]?.url).toBe(`${BASE}/api/auth/session`);
    expect(f.calls[0]?.headers.get("content-type")).toBeNull();
  });

  it("refuses a path that core does not serve, at compile time (plan 11d)", async () => {
    const f = answering(200, `{}`);
    const call = createTransport({ baseURL: BASE, fetch: f.fetch });
    // @ts-expect-error "/sesion" is not a RoutePath.
    await call("GET", "/sesion");
    // @ts-expect-error A POST route is not a GET path.
    await call("GET", "/sign-out");
    await call("POST", "/sign-out", {});
    expect(f.calls.map((r) => new URL(r.url).pathname)).toEqual([
      "/auth/sesion",
      "/auth/sign-out",
      "/auth/sign-out",
    ]);
  });
});
