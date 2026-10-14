import { defineConfig } from "vitest/config";

// The tests of the checks, the build layout test, and the sample tests. The
// layout test reads dist, so `pnpm test` builds first (package.json).
export default defineConfig({
  test: { include: ["test/**/*.test.ts", "samples/**/*.test.ts"] },
});
