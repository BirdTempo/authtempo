// The types of conformance-count-reporter.mjs. The repo root has no vitest
// package, so these types name no vitest type. A vitest config accepts the
// result as a reporter object.

/** The describe prefixes of core's suites (rulings 5 and 7 of plan 12g). */
export declare const PREFIXES: readonly string[];

/** A vitest reporter that prints the count of each conformance run. It fails a missing or empty run, and a run with a skipped test. */
export declare function conformanceCountReporter(options: { expected: readonly string[] }): {
  onInit(ctx: unknown): void;
  onTestRunEnd(testModules: readonly unknown[]): Promise<void>;
};
