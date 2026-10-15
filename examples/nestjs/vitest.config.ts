import { defineConfig } from "vitest/config";

// The legacy decorators of Nest in the Oxc transform of vite 8 (plan 11d2).
export default defineConfig({
  oxc: { decorator: { legacy: true } },
  test: { include: ["test/**/*.test.ts"] },
});
