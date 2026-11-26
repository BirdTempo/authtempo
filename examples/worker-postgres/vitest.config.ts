import { defineConfig } from "vitest/config";

// Two of the three test files run the Worker's fetch handler on Node against
// the test Postgres. workerd.test.ts runs the Worker in workerd with the
// test harness of wrangler. The local form of the Hyperdrive binding connects
// it to the same Postgres. No test runs the Hyperdrive service.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
