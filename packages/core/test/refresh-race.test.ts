import { createMemoryAdapter } from "../src/storage/memory.js";
import { runRefreshRaceConformance } from "../src/storage/refresh-race-conformance.js";

runRefreshRaceConformance("memory", async () => ({
  adapter: createMemoryAdapter(),
  close: async () => {},
}));
