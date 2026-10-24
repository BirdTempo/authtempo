// The count of each conformance run (plan 12g, ruling 7). A vitest reporter.
// A suite that silently does not run looks like a pass. So this reporter
// prints the test count of each run. It fails the run when an expected run
// is missing or has no passed test. It also fails a run whose passed count is
// below its test count: a skipped test is a test that did not run. A run is a
// top-level describe whose name starts with one of PREFIXES, such as
// "storage conformance: d1".

/** The describe prefixes of core's suites (rulings 5 and 7 of plan 12g). */
export const PREFIXES = [
  "storage conformance: ",
  "limiter conformance: ",
  "secret rotation: ",
  "refresh reuse race: ",
  "refresh revoke race: ",
  "shape conformance: ",
  // The daily cap of the phone code on each shared limiter (plan 12i Task 4).
  "phone cap: ",
  // The driver tests of the SQLite adapter (plan 12g Task 4): the batch unit and the version floor.
  "sqlite driver: ",
];

/**
 * @param {{ expected: readonly string[] }} options the full describe names
 *   that the package must run, such as "shape conformance: d1".
 * @returns {import("vitest/node").Reporter}
 */
export function conformanceCountReporter({ expected }) {
  /** @type {import("vitest/node").Vitest | undefined} */
  let vitest;
  return {
    onInit(ctx) {
      vitest = ctx;
    },
    async onTestRunEnd(testModules) {
      /** @type {Map<string, { tests: number, passed: number }>} */
      const runs = new Map();
      for (const module of testModules)
        for (const suite of module.children.suites()) {
          if (!PREFIXES.some((p) => suite.name.startsWith(p))) continue;
          const run = runs.get(suite.name) ?? { tests: 0, passed: 0 };
          for (const test of suite.children.allTests()) {
            run.tests += 1;
            if (test.result().state === "passed") run.passed += 1;
          }
          runs.set(suite.name, run);
        }
      for (const [name, run] of [...runs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        console.log(`conformance: ${name} tests=${run.tests} passed=${run.passed}`);
      // A run of some files or of some test names cannot hold every
      // expected run, so it prints the counts and checks nothing more.
      const all = vitest ? await vitest.globTestSpecifications() : [];
      if (testModules.length < all.length || vitest?.config.testNamePattern !== undefined) {
        console.log("conformance: a filtered run; the expected runs are not checked");
        return;
      }
      let failed = false;
      for (const [name, run] of runs)
        if (run.passed < run.tests) {
          console.error(`conformance: ${name} passed ${run.passed} of ${run.tests} tests`);
          failed = true;
        }
      for (const name of expected) {
        const run = runs.get(name);
        if (run === undefined) console.error(`conformance: ${name} is missing`);
        else if (run.passed === 0) console.error(`conformance: ${name} has no passed test`);
        else continue;
        failed = true;
      }
      if (failed) process.exitCode = 1;
    },
  };
}
