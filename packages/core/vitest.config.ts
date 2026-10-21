import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The count reporter fails the run when one of these runs is missing or has
// no passed test (ruling 7 of plan 12g; the 12g fix wave added core).
const RUNS = [
  "storage conformance: memory",
  "limiter conformance: memory",
  "secret rotation: memory",
  "refresh reuse race: memory",
  "refresh revoke race: memory",
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Plan 11g Task 5: the answer recorder. The global setup empties `.answers/`;
    // the setup file wraps `createRouter` in every test file and records each answer.
    // Plan 12h Task 12: the event recorder, in the same form, with `.events/`.
    globalSetup: ["./test/setup/answers-start.ts", "./test/setup/events-start.ts"],
    setupFiles: ["./test/setup/answers.ts", "./test/setup/events.ts"],
    reporters: ["default", conformanceCountReporter({ expected: RUNS })],
  },
});
