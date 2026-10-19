import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Plan 11g Task 5: the answer recorder. The global setup empties `.answers/`;
    // the setup file wraps `createRouter` in every test file and records each answer.
    globalSetup: ["./test/setup/answers-start.ts"],
    setupFiles: ["./test/setup/answers.ts"],
  },
});
