import { runLimiterConformance } from "../src/limiter/conformance.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";

runLimiterConformance("memory", async () => {
  let t = new Date("2026-01-01T00:00:00.000Z").getTime();
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  return { limiter: createMemoryLimiter(clock), clock, close: async () => {} };
});
