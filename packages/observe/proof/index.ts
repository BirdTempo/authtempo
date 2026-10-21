import { analyticsEngineSink } from "../src/analytics-engine.js";
import { workersLogsSink } from "../src/workers-logs.js";

// The bundle proof of plan 12h Task 10: wrangler bundles this Worker with
// no_nodejs_compat. bundle-no-node.mjs fails on a node: import in either sink
// or in the core entries that they import.
const points: unknown[] = [];
const logs = workersLogsSink();
const engine = analyticsEngineSink({ writeDataPoint: (p) => void points.push(p) });

export default {
  async fetch(): Promise<Response> {
    await logs.write([]);
    await engine.write([]);
    return Response.json({ points: points.length });
  },
};
