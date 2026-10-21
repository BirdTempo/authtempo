import { expect, test } from "vitest";
import { everyFeature } from "./every-feature.js";

// Plan 12h Task 4 Step 6: the cost of the request scope, one shallow copy of
// the resolved config with every feature on. Not part of `test`; run it with
// `vitest bench --run test/scope.bench.ts`. The plan stops at a median above 20 µs.

const config = everyFeature();
const scope = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: null,
  route: "POST /password/sign-in",
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0",
};

test("one shallow copy of the config with a scoped observer", async ({ bench }) => {
  const result = await bench("scope copy", () => {
    const scoped = { ...config, observe: config.observe.scope(scope) };
    if (scoped.basePath !== config.basePath) throw new Error("the copy lost a key");
  }).run({ iterations: 100_000, time: 0 });
  const medianUs = (result.latency.p50 ?? 0) * 1000;
  console.log(
    `scope copy: median ${medianUs.toFixed(3)} us, mean ${(result.latency.mean * 1000).toFixed(3)} us, samples ${result.latency.samplesCount}`,
  );
  expect(medianUs).toBeLessThan(20);
});
