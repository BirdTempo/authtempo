// The types of dev.mjs, for test/node/dev.test.ts.
/** The arguments of `wrangler` for a local run on `port`. */
export declare function devArgs(port: number): string[];
/** The port of a run: DEMO_PORT when it is set, else DEMO_DEV_PORT. */
export declare function devPort(env: Record<string, string | undefined>): number;
