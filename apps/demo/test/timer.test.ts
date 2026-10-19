import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  call,
  type Jar,
  newSandbox,
  rowsIn,
  SANDBOX_COOKIE,
  sameSandbox,
  sandboxId,
  signInByLink,
} from "./helpers.js";

function stubOf(jar: Jar) {
  return env.SANDBOX.get(env.SANDBOX.idFromName(sandboxId(jar)));
}

function alarmOf(jar: Jar): Promise<number | null> {
  return runInDurableObject(stubOf(jar), (_instance, state) => state.storage.getAlarm());
}

describe("the 60-minute reset", () => {
  it("sets the alarm at 60 minutes from creation", async () => {
    const jar = await newSandbox();
    const rows = await rowsIn(jar, "SELECT value FROM demo_meta WHERE key = 'created_at'");
    const createdAt = Number(rows[0]?.value);
    expect(createdAt).toBeGreaterThan(0);
    expect(await alarmOf(jar)).toBe(createdAt + 3_600_000);
  });

  it("empties the sandbox at the alarm", async () => {
    const jar = await newSandbox();
    await signInByLink(jar, "ada@example.com");
    expect(await rowsIn(jar, "SELECT count(*) AS n FROM demo_mail")).toEqual([{ n: 1 }]);
    expect(await runDurableObjectAlarm(stubOf(jar))).toBe(true);
    expect(await stubOf(jar).exists()).toBe(false);
    const tables = await rowsIn(jar, "SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.map((t) => t.name)).not.toContain("demo_mail");
    expect(tables).toEqual([]);
    expect(await alarmOf(jar)).toBeNull();
  });

  it("gives a new sandbox after the reset", async () => {
    const jar = await newSandbox();
    const old = sandboxId(jar);
    expect(await runDurableObjectAlarm(stubOf(jar))).toBe(true);
    const visitor = sameSandbox(jar);
    const res = await call(visitor, "GET", "/password");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://demo.authtempo.com/password");
    const fresh = visitor.cookies.get(SANDBOX_COOKIE);
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh).not.toBe(old);
    expect(await stubOf(visitor).exists()).toBe(true);
  });
});
