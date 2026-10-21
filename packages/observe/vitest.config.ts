import { defineConfig } from "vitest/config";

// The unit tests run on Node. test/pool runs in workerd through vitest.pool.config.ts.
export default defineConfig({
  test: { include: ["test/*.test.ts"] },
});
