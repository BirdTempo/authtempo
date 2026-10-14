import { defineConfig } from "vitest/config";

// The test runs the Worker's fetch handler on Node against the docker compose
// Postgres. It does not run in workerd: the Workers pool cannot reach a local
// Postgres through Hyperdrive in this repo.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
