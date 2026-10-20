// Empty the dist folder of the package in the working folder, before its build
// writes. Final review of plan 12e, L1. tsc writes each output and deletes no
// file. So the output of a removed source stays in dist, and a pack ships it.
// pack-files counts it too. Plan 12e Task 10 left dist/sha256.* in this way.
// Each package build runs this script first, as `node ../../scripts/clean-dist.mjs`.
// apps/site/test/clean-dist.test.ts holds every build script to that form.
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
