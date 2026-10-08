import { runAdapterConformance } from "../src/storage/conformance.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

runAdapterConformance("memory", async () => ({
  adapter: createMemoryAdapter(),
  close: async () => {},
}));
