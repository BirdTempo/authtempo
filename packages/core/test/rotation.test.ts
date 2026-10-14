import { runSecretRotationConformance } from "../src/storage/conformance.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

runSecretRotationConformance("memory", async () => ({
  adapter: createMemoryAdapter(),
  close: async () => {},
}));
