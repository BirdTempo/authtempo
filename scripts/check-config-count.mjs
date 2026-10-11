// Plan 9b: fail the config typecheck when it finds fewer config files than
// the known count. An empty or shrunken include in tsconfig.configs.json
// would otherwise pass with no file checked.
import { execFileSync } from "node:child_process";

// Counted 2026-10-11. Raise this number when a package adds a vitest config.
const MINIMUM = 10;

const listed = execFileSync("tsc", ["-p", "tsconfig.configs.json", "--listFilesOnly"], {
  encoding: "utf8",
});
const found = listed
  .split("\n")
  .filter((line) => /\/(packages|examples)\/.+\/vitest[^/]*\.config\.m?ts$/.test(line)).length;

if (found < MINIMUM) {
  console.error(
    `typecheck:configs found ${found} vitest config files. Expected at least ${MINIMUM}.`,
  );
  process.exit(1);
}
console.log(`typecheck:configs checked ${found} vitest config files (minimum ${MINIMUM}).`);
