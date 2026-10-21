import { analyticsEngineSink } from "../src/analytics-engine.js";
import { otlpSink } from "../src/otlp.js";
import { workersLogsSink } from "../src/workers-logs.js";

// The bundle proof of plan 12h Tasks 10 and 11: wrangler bundles this Worker
// with no_nodejs_compat. bundle-no-node.mjs fails on a node: import in a sink
// or in the core entries that the sinks import.
const points: unknown[] = [];
const logs = workersLogsSink();
const engine = analyticsEngineSink({ writeDataPoint: (p) => void points.push(p) });
// The proof only bundles this Worker. An empty batch makes no post.
const otlp = otlpSink({ endpoint: "https://collector.invalid", serviceName: "proof" });

export default {
  async fetch(): Promise<Response> {
    await logs.write([]);
    await engine.write([]);
    await otlp.write([]);
    return Response.json({ points: points.length });
  },
};
