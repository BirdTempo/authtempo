import { env, runInDurableObject } from "cloudflare:test";
import { createD1Adapter, createD1Limiter } from "@authtempo/adapter-d1";
import type { LimiterPort, StorageAdapter } from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";
import { type ManualClock, runLimiterConformance } from "@authtempo/core/limiter-conformance";
import { coreStatements, D1_BOUND_PARAMS, rowsPerInsertOf, SQLITE } from "@authtempo/core/sql";
import type { Sandbox } from "../src/sandbox.js";
import { sqliteD1 } from "../src/sqlite-d1.js";

/** A sandbox id as the Worker makes one: 16 random bytes in lower-case hex. */
function freshId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A new sandbox, made by its own create(). The answer is its name, not a
 * stub. A stub is an I/O object of the context that made it, so each call
 * takes a new one.
 */
async function newSandbox(): Promise<string> {
  const name = freshId();
  await stubOf(name).create();
  return name;
}

function stubOf(name: string): DurableObjectStub<Sandbox> {
  return env.SANDBOX.get(env.SANDBOX.idFromName(name));
}

/**
 * Runs `fn` inside the sandbox with the shim over its store. A SqlStorage
 * handle taken out of runInDurableObject throws on its next use ("Cannot
 * perform I/O on behalf of a different Durable Object", seen 2026-10-20).
 * So each call of the suite opens its own runInDurableObject (the fallback of
 * Task 8 Step 4).
 */
function inside<R>(name: string, fn: (db: D1Database) => Promise<R>): Promise<R> {
  const call = runInDurableObject(stubOf(name), (_instance, state) =>
    fn(sqliteD1(state.storage.sql, (f) => state.storage.transactionSync(f))),
  );
  // The suite starts several calls that reject, then awaits them one at a time.
  // A forwarded call rejects in a later turn, before its await, and vitest then
  // fails the run with an unhandled rejection. This line marks it as handled;
  // the caller still gets the rejection from the promise it awaits.
  call.catch(() => {});
  return call;
}

/** The D1 adapter of the sandbox, with each method call forwarded into the object. */
function forwardedAdapter(name: string): StorageAdapter {
  const on = (db: D1Database) => createD1Adapter(db);
  return {
    // The D1 adapter keeps an undo log, so its transaction is not isolated (plan 12p).
    isolated: false,
    create: (model, data) => inside(name, (db) => on(db).create(model, data)),
    createMany: (model, rows) => inside(name, (db) => on(db).createMany(model, rows)),
    // The chunk of the D1 adapter, with no call into the object.
    rowsPerInsert: (model) => rowsPerInsertOf(coreStatements(SQLITE), model, D1_BOUND_PARAMS),
    findOne: (model, where) => inside(name, (db) => on(db).findOne(model, where)),
    findMany: (model, where, opts) => inside(name, (db) => on(db).findMany(model, where, opts)),
    update: (model, where, data) => inside(name, (db) => on(db).update(model, where, data)),
    delete: (model, where) => inside(name, (db) => on(db).delete(model, where)),
    // The D1 adapter's one DELETE … RETURNING, in the object (plan 12o).
    deleteRows: (model, where) => inside(name, (db) => on(db).deleteRows(model, where)),
    // Outside a transaction the D1 adapter reverses no write, so it answers true.
    // A transaction's own handle is the D1 adapter of its call, with its undo log.
    keep: () => inside(name, (db) => on(db).keep()),
    // The whole transaction runs inside one call, with the adapter of that call.
    transaction: (fn) => inside(name, (db) => on(db).transaction(fn)),
  };
}

/** The D1 limiter of the sandbox, with each call forwarded into the object. */
function forwardedLimiter(name: string, clock: ManualClock): LimiterPort {
  return {
    // The scope of the D1 limiter that each call forwards to (plan 12i Task 4).
    scope: "shared",
    allow: (key, window) => inside(name, (db) => createD1Limiter(db, clock).allow(key, window)),
    sweep: (now) =>
      inside(name, async (db) => {
        const limiter = createD1Limiter(db, clock);
        if (limiter.sweep === undefined) throw new Error("the D1 limiter has no sweep");
        return limiter.sweep(now);
      }),
  };
}

function manualClock(): ManualClock {
  let t = new Date("2026-01-01T00:00:00.000Z").getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

runAdapterConformance("demo sqlite shim", async () => {
  const name = await newSandbox();
  return { adapter: forwardedAdapter(name), close: () => stubOf(name).destroy() };
});

runLimiterConformance("demo sqlite shim", async () => {
  const name = await newSandbox();
  const clock = manualClock();
  return { limiter: forwardedLimiter(name, clock), clock, close: () => stubOf(name).destroy() };
});
