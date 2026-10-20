// Empty the dist folder of the package in the working folder, before its build
// writes (final review of plan 12e, L1). tsc writes each output and deletes no
// file. So the output of a removed source stays in dist, a pack ships it, and
// pack-files counts it: plan 12e Task 10 left dist/sha256.* in this way.
// Each package build runs this script first, as `node ../../scripts/clean-dist.mjs`.
// apps/site/test/clean-dist.test.ts holds every build script to that form.
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
