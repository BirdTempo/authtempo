import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { createD1Adapter } from "@authtempo/adapter-d1";
import { SCHEMA_VERSION } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import type { Sandbox } from "../src/sandbox.js";
import { sqliteD1 } from "../src/sqlite-d1.js";

const ORIGIN = "https://demo.authtempo.com";
const COOKIE_RE =
  /^__Host-demo_sandbox=([0-9a-f]{32}); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600$/;

/** A first visit with no cookie: the Worker makes a sandbox through the gate and answers its id. */
async function visit(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/`, { redirect: "manual" });
  const id = COOKIE_RE.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (res.status !== 303 || id === undefined) throw new Error(`no sandbox: ${res.status}`);
  return id;
}

function stubOf(id: string) {
  return env.SANDBOX.get(env.SANDBOX.idFromName(id));
}

/** Runs one query inside the sandbox of `id` and answers its rows. */
function rowsIn(id: string, query: string): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(stubOf(id), (_instance, state) =>
    state.storage.sql.exec(query).toArray(),
  );
}

/** The gate of the Worker. Each gate test reads only its own TEST-NET-1 address. */
function gate() {
  return env.GATE.get(env.GATE.idFromName("gate"));
}

/** A first visit from one address, through the gate. */
async function visitFrom(ip: string): Promise<void> {
  const res = await SELF.fetch(`${ORIGIN}/`, {
    redirect: "manual",
    headers: { "cf-connecting-ip": ip },
  });
  expect(res.status).toBe(303);
}

/** One hour and 1 ms pass for the gate row of `ip`: its time moves back. */
async function hourPasses(ip: string): Promise<void> {
  await runInDurableObject(gate(), (_instance, state) => {
    state.storage.sql.exec("UPDATE admit SET at = at - 3600001 WHERE ip = ?", ip);
  });
}

function gateRows(ip: string): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(gate(), (_instance, state) =>
    state.storage.sql.exec("SELECT ip FROM admit WHERE ip = ?", ip).toArray(),
  );
}

/** The alarm of the gate, and the time of its oldest row (NaN with no row). */
function gateAlarm(): Promise<{ alarm: number | null; oldest: number }> {
  return runInDurableObject(gate(), async (_instance, state) => ({
    alarm: await state.storage.getAlarm(),
    oldest: Number(state.storage.sql.exec("SELECT min(at) AS m FROM admit").one().m ?? Number.NaN),
  }));
}

describe("the demo Worker and its sandboxes", () => {
  it("makes a sandbox on the first visit and sets the cookie", async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(res.headers.get("set-cookie")).toMatch(COOKIE_RE);
  });

  it("applies the migrations at creation", async () => {
    const id = await visit();
    const rows = await rowsIn(id, "SELECT value FROM ta_meta WHERE key = 'schema_version'");
    expect(rows).toEqual([{ value: String(SCHEMA_VERSION) }]);
  });

  it("keeps the sandbox for the next visit", async () => {
    const id = await visit();
    const res = await SELF.fetch(`${ORIGIN}/`, {
      redirect: "manual",
      headers: { cookie: `__Host-demo_sandbox=${id}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("ok");
  });

  it("takes the first cookie of the name that names a live sandbox", async () => {
    const id = await visit();
    const unknown = "0123456789abcdef0123456789abcdef";
    for (const cookie of [
      `__Host-demo_sandbox=x; __Host-demo_sandbox=${id}`,
      `__Host-demo_sandbox=${unknown}; __Host-demo_sandbox=${id}`,
    ]) {
      const res = await SELF.fetch(`${ORIGIN}/`, { redirect: "manual", headers: { cookie } });
      expect({ cookie, status: res.status, body: await res.text() }).toEqual({
        cookie,
        status: 200,
        body: "ok",
      });
    }
    expect(await stubOf(unknown).exists()).toBe(false);
  });

  it("reads at most four values of the sandbox cookie", async () => {
    const id = await visit();
    const unknown = ["1", "2", "3", "4"].map((d) => d.repeat(32));
    const cookie = [...unknown, id].map((v) => `__Host-demo_sandbox=${v}`).join("; ");
    const res = await SELF.fetch(`${ORIGIN}/`, { redirect: "manual", headers: { cookie } });
    expect(res.status).toBe(303);
  });

  it("an unknown id never initializes a sandbox", async () => {
    const unknown = "0123456789abcdef0123456789abcdef";
    const res = await SELF.fetch(`${ORIGIN}/`, {
      redirect: "manual",
      headers: { cookie: `__Host-demo_sandbox=${unknown}` },
    });
    expect(res.status).toBe(303);
    const fresh = COOKIE_RE.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh).not.toBe(unknown);
    expect(await stubOf(unknown).exists()).toBe(false);
    const tables = await rowsIn(
      unknown,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'demo_meta'",
    );
    expect(tables).toEqual([]);
  });

  it("answers 409 to a form post with no sandbox", async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=a%40example.com",
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "sandbox_reset" });
  });

  it("keeps a secret per sandbox", async () => {
    const a = await visit();
    const b = await visit();
    const query = "SELECT value FROM demo_meta WHERE key = 'secret'";
    const [ra, rb] = [await rowsIn(a, query), await rowsIn(b, query)];
    const sa = ra[0]?.value;
    const sb = rb[0]?.value;
    expect(sa).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sb).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sa).not.toBe(sb);
  });
  it("deletes the sandbox when its alarm runs at reset_at", async () => {
    const id = await visit();
    const set = await runInDurableObject(stubOf(id), async (_instance, state) => {
      const meta = state.storage.sql
        .exec("SELECT key, value FROM demo_meta WHERE key IN ('created_at', 'reset_at')")
        .toArray();
      const at = Object.fromEntries(meta.map((r) => [r.key, Number(r.value)]));
      return {
        alarm: await state.storage.getAlarm(),
        resetAt: at.reset_at,
        createdAt: at.created_at,
      };
    });
    expect(set.alarm).toBe(set.resetAt);
    expect(Number(set.resetAt) - Number(set.createdAt)).toBe(3_600_000);
    expect(await runDurableObjectAlarm(stubOf(id))).toBe(true);
    expect(await stubOf(id).exists()).toBe(false);
    expect(await rowsIn(id, "SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    const res = await SELF.fetch(`${ORIGIN}/`, {
      redirect: "manual",
      headers: { cookie: `__Host-demo_sandbox=${id}` },
    });
    expect(res.status).toBe(303);
  });

  it("keeps the rows of one sandbox out of another", async () => {
    const a = await visit();
    const b = await visit();
    const at = new Date("2026-01-01T00:00:00.000Z");
    // The product's own adapter writes the row, as a sign-up does.
    await runInDurableObject(stubOf(a), (_instance, state) =>
      createD1Adapter(sqliteD1(state.storage.sql, (f) => state.storage.transactionSync(f))).create(
        "user",
        {
          id: "u-a",
          createdAt: at,
          updatedAt: at,
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
        },
      ),
    );
    const query = "SELECT id FROM ta_user";
    expect(await rowsIn(a, query)).toEqual([{ id: "u-a" }]);
    expect(await rowsIn(b, query)).toEqual([]);
  });

  it("refuses create() on a live sandbox and keeps its store and alarm", async () => {
    const id = await visit();
    const read = () =>
      runInDurableObject(stubOf(id), async (_instance, state) => ({
        meta: state.storage.sql.exec("SELECT key, value FROM demo_meta ORDER BY key").toArray(),
        alarm: await state.storage.getAlarm(),
      }));
    const before = await read();
    // The call runs on the instance: a throw of an RPC method of the stub also
    // reaches the pool as an unhandled error of the object (seen 2026-10-20).
    const second = runInDurableObject(stubOf(id), (instance: Sandbox) => instance.create());
    await expect(second).rejects.toThrow("demo: the sandbox exists");
    expect(await read()).toEqual(before);
  });

  it("deletes an IP at the next admit one hour after its visit", async () => {
    await visitFrom("192.0.2.1");
    await hourPasses("192.0.2.1");
    await visitFrom("192.0.2.2");
    expect(await gateRows("192.0.2.1")).toEqual([]);
    expect(await gateRows("192.0.2.2")).toHaveLength(1);
  });

  it("deletes an IP by the gate alarm one hour after its visit, with no other visit", async () => {
    await visitFrom("192.0.2.3");
    const before = await gateAlarm();
    expect(before.alarm).toBe(before.oldest + 3_600_000);
    await hourPasses("192.0.2.3");
    expect(await runDurableObjectAlarm(gate())).toBe(true);
    expect(await gateRows("192.0.2.3")).toEqual([]);
    // The alarm is set again for the next oldest row, or not at all.
    const after = await gateAlarm();
    expect(after.alarm).toBe(Number.isNaN(after.oldest) ? null : after.oldest + 3_600_000);
  });
});
