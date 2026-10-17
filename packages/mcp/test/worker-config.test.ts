// The settings of the remote Worker in wrangler.jsonc (plan 11e, final review
// L2 and L4). Spec 21 item 8 says that the Worker stores no query and no IP.
// The limiter keys isolate memory for the window only (ruling 34), so the
// Worker binds no storage at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../cli/src/jsonc.js";
import { LIMITS } from "../src/limits.js";
import { PKG } from "./support/bin.js";

const config = parseJsonc(readFileSync(join(PKG, "wrangler.jsonc"), "utf8")) as Record<
  string,
  unknown
>;

/** The top-level keys of wrangler.jsonc, typed here. A new key fails, so a new binding is a choice. */
const KEYS = [
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "assets",
  "observability",
  "vars",
  "ratelimits",
];

/** The wrangler keys of a binding that stores data (wrangler config schema). */
const STORAGE = [
  "kv_namespaces",
  "durable_objects",
  "d1_databases",
  "r2_buckets",
  "queues",
  "hyperdrive",
  "vectorize",
  "analytics_engine_datasets",
  "workflows",
];

describe("wrangler.jsonc of the remote Worker", () => {
  it("binds no storage: the keys are the typed list, with no storage key", () => {
    expect(Object.keys(config).sort()).toEqual([...KEYS].sort());
    for (const key of STORAGE) expect(Object.hasOwn(config, key), key).toBe(false);
  });

  it("holds the rate limit binding to LIMITS.bindingPerMinute, for one minute", () => {
    // The page and the binding are copies; LIMITS is their one source.
    expect(config.ratelimits).toEqual([
      {
        name: "MCP_LIMITER",
        namespace_id: "1016",
        simple: { limit: LIMITS.bindingPerMinute, period: 60 },
      },
    ]);
  });
});
