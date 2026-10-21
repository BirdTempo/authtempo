import { describe, expect, it } from "vitest";
import { mintTrace, parseTraceparent } from "../src/observe/trace.js";
import { APP_ORIGIN, BASE_URL, get, post } from "./helpers.js";
import { observed } from "./observe-helpers.js";

// Plan 12h Task 4 (spec 31 item 5): the trace of a request and its header.

const HEX32 = /^[0-9a-f]{32}$/;
const CLIENT_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CLIENT_PARENT = "00f067aa0ba902b7";
const TRACEPARENT = `00-${CLIENT_TRACE}-${CLIENT_PARENT}-01`;

const options = (origin: string) =>
  new Request(`${BASE_URL}/auth/magic-link/request`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });

describe("the trace ids (plan 12h Task 4)", () => {
  it("mints 16 and 8 random bytes as lowercase hex", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = mintTrace();
      expect(t.traceId).toMatch(HEX32);
      expect(t.spanId).toMatch(/^[0-9a-f]{16}$/);
      ids.add(t.traceId);
    }
    expect(ids.size).toBe(1000);
  });

  it("parses a valid traceparent and refuses the rest", () => {
    expect(parseTraceparent(TRACEPARENT)).toEqual({
      traceId: CLIENT_TRACE,
      parentSpanId: CLIENT_PARENT,
    });
    for (const bad of [
      `00-${"0".repeat(32)}-${CLIENT_PARENT}-01`,
      `00-${CLIENT_TRACE}-${"0".repeat(16)}-01`,
      `ff-${CLIENT_TRACE}-${CLIENT_PARENT}-01`,
      `00-${CLIENT_TRACE.toUpperCase()}-${CLIENT_PARENT}-01`,
      `00-${CLIENT_TRACE}0-${CLIENT_PARENT}-01`,
      `00-${CLIENT_TRACE}-${CLIENT_PARENT}-1`,
      "",
      null,
    ])
      expect(parseTraceparent(bad), String(bad)).toBeNull();
  });
});

describe("the trace header (plan 12h Task 4)", () => {
  it("puts the trace header on every answer of handle", async () => {
    const s = observed();
    const ok = await s.auth.handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    expect(ok.status).toBe(200);
    const found = await s.auth.handle(get("/auth/magic-link/verify?token=short"));
    expect(found.status).toBe(302);
    const missing = await s.auth.handle(get("/auth/nope"));
    expect(missing.status).toBe(404);
    const foreign = await s.auth.handle(
      post(
        "/auth/magic-link/request",
        { email: "ada@example.com" },
        { origin: "https://evil.example" },
      ),
    );
    expect(foreign.status).toBe(403);
    const preflight = await s.auth.handle(options(APP_ORIGIN));
    expect(preflight.status).toBe(204);
    s.stop();
    const broken = await s.auth.handle(
      post("/auth/magic-link/request", { email: "bob@example.com" }),
    );
    expect(broken.status).toBe(500);
    const ids = [ok, found, missing, foreign, preflight, broken].map((r) =>
      r.headers.get("x-authtempo-trace"),
    );
    for (const id of ids) expect(id).toMatch(HEX32);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ignores a client traceparent by default", async () => {
    const s = observed();
    const res = await s.auth.handle(
      post("/auth/magic-link/request", { email: "ada@example.com" }, { traceparent: TRACEPARENT }),
    );
    expect(res.headers.get("x-authtempo-trace")).toMatch(HEX32);
    expect(res.headers.get("x-authtempo-trace")).not.toBe(CLIENT_TRACE);
    const events = await s.events();
    expect(events.some((e) => e.name === "request")).toBe(true);
    const text = JSON.stringify(events);
    expect(text).not.toContain(CLIENT_TRACE);
    expect(text).not.toContain(CLIENT_PARENT);
  });

  it("takes a valid traceparent with trustTraceparent, and ignores an all-zero one", async () => {
    const s = observed({}, { trustTraceparent: true });
    const res = await s.auth.handle(
      post("/auth/magic-link/request", { email: "ada@example.com" }, { traceparent: TRACEPARENT }),
    );
    expect(res.headers.get("x-authtempo-trace")).toBe(CLIENT_TRACE);
    const request = (await s.events()).find((e) => e.name === "request");
    expect(request).toMatchObject({ traceId: CLIENT_TRACE, parentSpanId: CLIENT_PARENT });
    expect(request?.spanId).not.toBe(CLIENT_PARENT);
    const zero = await s.auth.handle(
      post(
        "/auth/magic-link/request",
        { email: "ada@example.com" },
        { traceparent: `00-${"0".repeat(32)}-${CLIENT_PARENT}-01` },
      ),
    );
    expect(zero.headers.get("x-authtempo-trace")).toMatch(HEX32);
    expect(zero.headers.get("x-authtempo-trace")).not.toBe("0".repeat(32));
  });

  it("keeps the error body", async () => {
    // The body that session-list.test.ts pins for a request with no session.
    const s = observed();
    const res = await s.auth.handle(get("/auth/sessions"));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-authtempo-trace")).toMatch(HEX32);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("exposes the trace header to a trusted origin only", async () => {
    const s = observed();
    const trusted = await s.auth.handle(
      post("/auth/magic-link/request", { email: "ada@example.com" }),
    );
    expect(trusted.headers.get("access-control-expose-headers")).toBe("x-authtempo-trace");
    const preflight = await s.auth.handle(options(APP_ORIGIN));
    expect(preflight.headers.get("access-control-expose-headers")).toBe("x-authtempo-trace");
    const plain = await s.auth.handle(
      new Request(`${BASE_URL}/auth/magic-link/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com" }),
      }),
    );
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-expose-headers")).toBeNull();
  });
});
