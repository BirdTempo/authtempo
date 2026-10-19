import { env } from "cloudflare:test";
import { runRefreshRaceConformance } from "@authtempo/core/conformance";
import { TABLES } from "@authtempo/core/sql";
import { createD1Adapter } from "../src/index.js";

async function truncateAll(): Promise<void> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

// Ruling 40 of plan 12e: a detected refresh reuse leaves no live row on D1.
runRefreshRaceConformance("d1", async () => {
  await truncateAll();
  return { adapter: createD1Adapter(env.DB), close: truncateAll };
});
