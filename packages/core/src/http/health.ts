import type { ResolvedConfig } from "../config.js";
import { ERRORS } from "../errors.js";
import { StorageError } from "../storage/port.js";
import { json } from "./json.js";
import type { Route } from "./router.js";

/** The time that `/ready` keeps one result for each `Auth` instance (spec 31 item 12). */
export const READY_CACHE_MS = 10_000;

/**
 * The time that `/ready` waits for one check (ruling 7 of plan 12h). A
 * store that does not answer in this time is not ready: a probe gets 503,
 * not a request that hangs.
 */
export const READY_TIMEOUT_MS = 3_000;

/**
 * The id of the probe read of an adapter with no `ping`. A colon is in no id
 * that core makes, so no row holds it, and the read answers null.
 */
export const READY_PROBE_ID = "authtempo:ready-probe";

/** Why the store is not ready. The body holds only these fixed strings. */
type NotReady = "storage" | "schema";

/** One check of the store: `ping` when the adapter has it, else one read of a user row by an id that no row holds. */
async function checkStore(config: ResolvedConfig): Promise<NotReady | null> {
  try {
    if (config.storage.ping) await config.storage.ping();
    else await config.storage.findOne("user", [{ field: "id", op: "eq", value: READY_PROBE_ID }]);
    return null;
  } catch (e) {
    // The cause stays here: its message can name a host or a database (spec 31 item 12).
    return e instanceof StorageError && e.code === "schema_mismatch" ? "schema" : "storage";
  }
}

/** The check of `checkStore`, or "storage" when it does not settle in `READY_TIMEOUT_MS`. */
async function checkInTime(config: ResolvedConfig): Promise<NotReady | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<NotReady>((resolve) => {
    timer = setTimeout(() => resolve("storage"), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([checkStore(config), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /health` and `GET /ready` (plan 12h Task 8, spec 31 item 12).
 * `/health` is in every deployment and reads no storage. `/ready` exists
 * only with `observe.readiness: true`. It keeps one result for
 * `READY_CACHE_MS`, so a probe that calls it often makes one storage call
 * in each window. A check that ends at `READY_TIMEOUT_MS` is the result of
 * its window too. Neither route counts on a limiter.
 */
export function healthRoutes(config: ResolvedConfig): Route[] {
  const routes: Route[] = [
    {
      method: "GET",
      path: "/health",
      key: "GET /health",
      async handler() {
        return json({ status: "ok" });
      },
    },
  ];
  if (!config.observeConfig?.readiness) return routes;
  // One result for this instance: the check in flight or done, and the time it started.
  let held: { at: number; result: Promise<NotReady | null> } | null = null;
  routes.push({
    method: "GET",
    path: "/ready",
    key: "GET /ready",
    async handler(ctx) {
      const now = ctx.now.getTime();
      if (held === null || now - held.at >= READY_CACHE_MS)
        held = { at: now, result: checkInTime(ctx.config) };
      const reason = await held.result;
      if (reason === null) return json({ status: "ready" });
      return json({ error: "not_ready", reason }, ERRORS.not_ready);
    },
  });
  return routes;
}
