import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";
import { outboundLog } from "./test/outbound-log.js";
import { LONG_TEST_MS } from "./test/test-time.js";

// The count reporter fails the run when a run of the demo shim is missing or
// has no passed test (ruling 7 of plan 12g). The 12g fix wave added the demo.
const RUNS = ["storage conformance: demo sqlite shim", "limiter conformance: demo sqlite shim"];

// The Workers pool of the demo Worker (plan 11b Task 8), on @cloudflare/vitest-plugin
// 1.4.0. The tests run on workerd with the settings of wrangler.jsonc: the two
// Durable Object classes, the migration, the var, and the assets. One source
// holds the date and the flags.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Miniflare sends each fetch of the Worker and of its Durable Objects
        // to a host outside workerd here. The recorder keeps it and answers
        // 599, so no request reaches a real host during a test.
        outboundService: (request) => {
          outboundLog().push(`${request.method} ${request.url}`);
          return new Response(null, { status: 599 });
        },
        // A test reads the recorder list through this binding. It is a
        // binding of the tests only; wrangler.jsonc does not have it.
        serviceBindings: { OUTBOUND_LOG: () => Response.json(outboundLog()) },
      },
    }),
  ],
  // vitest.node.config.ts runs test/node in Node.
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/node/**"],
    // Each pool test runs a full Worker sandbox; test-time.ts holds the measures.
    testTimeout: LONG_TEST_MS,
    // A beforeAll of cookies.test.ts and of mailbox-only.test.ts runs every
    // flow (flows.ts everyFlow), so a hook gets the limit of a test, not the
    // 10 s default. On 2026-10-25 each hook took 0.25 to 1.3 s alone (load
    // 6 to 60). In the full pool at load 64 to 88 they took 9.0 and 9.2 s.
    // At load 86 to 111 both timed out at 10 s, as in two full runs of main.
    // With this limit they passed in 15.2 to 16.3 s at load 104 to 151.
    hookTimeout: LONG_TEST_MS,
    // The teardown fails the run on any request that left the Worker, from any file.
    globalSetup: ["./test/outbound-teardown.ts"],
    // After each pool file, the cookie rule reads every Set-Cookie line of call().
    setupFiles: ["./test/cookie-setup.ts"],
    reporters: ["default", conformanceCountReporter({ expected: RUNS })],
  },
});
