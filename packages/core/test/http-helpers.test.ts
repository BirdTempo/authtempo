import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clearSessionCookie, readCookie, sessionCookie } from "../src/http/cookies.js";
import { json, readJson, respond } from "../src/http/json.js";
import { safeNext } from "../src/http/safe-next.js";
import { fail, ok } from "../src/result.js";

describe("cookies", () => {
  it("sets an HttpOnly Secure SameSite=Lax cookie on /", () => {
    const c = sessionCookie("tempo_session", "ts_abc", 60);
    expect(c).toBe("tempo_session=ts_abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax");
  });
  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie("tempo_session")).toBe(
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
  });
  it("reads one cookie among several", () => {
    const req = new Request("https://x/", {
      headers: { cookie: "a=1; tempo_session=ts_abc; b=2" },
    });
    expect(readCookie(req, "tempo_session")).toBe("ts_abc");
    expect(readCookie(req, "nope")).toBeNull();
    expect(readCookie(new Request("https://x/"), "tempo_session")).toBeNull();
  });
});

describe("json", () => {
  const schema = z.object({ email: z.string() });
  it("parses a valid body", async () => {
    const req = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    });
    expect(await readJson(req, schema)).toEqual(ok({ email: "a@example.com" }));
  });
  it("fails invalid_body on bad json and on a schema miss", async () => {
    const bad = new Request("https://x/", { method: "POST", body: "{" });
    expect(await readJson(bad, schema)).toEqual(fail("invalid_body"));
    const miss = new Request("https://x/", { method: "POST", body: JSON.stringify({ x: 1 }) });
    expect(await readJson(miss, schema)).toEqual(fail("invalid_body"));
  });
  it("respond maps ok to 200 and fail to its status", async () => {
    const good = respond(ok({ a: 1 }));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ a: 1 });
    const bad = respond(fail("rate_limited"));
    expect(bad.status).toBe(429);
    expect(await bad.json()).toEqual({ error: "rate_limited" });
    expect(json({}).headers.get("cache-control")).toBe("no-store");
  });
});

describe("safeNext", () => {
  it("keeps a relative path and rejects everything else", () => {
    expect(safeNext("/home?x=1")).toBe("/home?x=1");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/\t/evil.example")).toBe("/");
    expect(safeNext("/\n/x")).toBe("/");
    expect(safeNext("/a\\b")).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("/".padEnd(2049, "a"))).toBe("/");
  });
});
