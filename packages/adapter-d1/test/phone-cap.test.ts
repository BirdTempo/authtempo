import { env } from "cloudflare:test";
import { runPhoneCapConformance } from "@authtempo/core/limiter-conformance";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The phone code's daily cap on real D1 (plan 12i Task 4, Review Focus 3).
// D1 Free allows 50 queries per invocation (D1 limits page, read
// 2026-10-24). The view below counts each statement, and each statement of
// a batch, so the suite can hold one send and one check to that budget.

/** The key that gives the statement of the binding under the counting view. */
const RAW = Symbol("raw");

function counting(db: D1Database) {
  let queries = 0;
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            queries++;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const view = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          queries += statements.length;
          return target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: view, queries: () => queries };
}

async function clear(): Promise<void> {
  await env.DB.prepare("DELETE FROM ta_limit").run();
  await env.DB.prepare("DELETE FROM ta_verification").run();
}

runPhoneCapConformance("d1", async () => {
  await clear();
  const view = counting(env.DB);
  return {
    limiter: createD1Limiter(view.db),
    storage: createD1Adapter(view.db),
    queries: view.queries,
    close: clear,
  };
});
