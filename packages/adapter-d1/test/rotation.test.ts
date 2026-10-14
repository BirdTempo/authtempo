import { env } from "cloudflare:test";
import { runSecretRotationConformance } from "@authtempo/core/conformance";
import { TABLES } from "@authtempo/core/sql";
import { createD1Adapter } from "../src/index.js";

async function truncateAll(): Promise<void> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

// Plan 12b: the two-phase rotation through the D1 adapter.
runSecretRotationConformance("d1", async () => {
  await truncateAll();
  return { adapter: createD1Adapter(env.DB), close: truncateAll };
});
