import { defineConfig } from "vitest/config";

// The Node tests: the importer on the memory adapter, on Postgres (core's
// tables and the Better Auth mapping), the readers, and the CLI. The D1 runs
// are in vitest.d1.config.ts.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/d1/**"] } });
