import { createMemoryAdapter } from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";

// The contract of every storage adapter. Put this file beside your adapter,
// and replace the factory with one that opens a fresh, empty database. An
// adapter passes this suite, or it does not ship. Here the memory adapter of
// core stands in for yours.
runAdapterConformance("memory (the sample)", async () => ({
  adapter: createMemoryAdapter(),
  close: async () => {},
}));
