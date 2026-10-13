// Plan 9b: fail the config typecheck when it finds fewer config files than
// the known count. An empty or shrunken include in tsconfig.configs.json
// would otherwise pass with no file checked.
import { execFileSync } from "node:child_process";

// Counted 2026-10-11: 11 with packages/import/vitest.d1.config.ts (plan 9b
// Task 14). Plan 11a adds apps/site (12), then examples/worker-d1 (13, Task 6)
// and examples/worker-postgres (14, Task 7). Raise this number when a package adds a vitest config.
const MINIMUM = 12;

const listed = execFileSync("tsc", ["-p", "tsconfig.configs.json", "--listFilesOnly"], {
  encoding: "utf8",
});
const found = listed
  .split("\n")
  .filter((line) => /\/(packages|examples|apps)\/.+\/vitest[^/]*\.config\.m?ts$/.test(line)).length;

if (found < MINIMUM) {
  console.error(
    `typecheck:configs found ${found} vitest config files. Expected at least ${MINIMUM}.`,
  );
  process.exit(1);
}
console.log(`typecheck:configs checked ${found} vitest config files (minimum ${MINIMUM}).`);
