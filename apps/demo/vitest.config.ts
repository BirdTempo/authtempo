import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Each request that left the Worker in this run, as "METHOD URL" (plan 11b
 * Task 12). The demo makes no outbound call, so test/outbound.test.ts expects
 * this list to stay empty.
 */
const outbound: string[] = [];

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
          outbound.push(`${request.method} ${request.url}`);
          return new Response(null, { status: 599 });
        },
        // A test reads the recorder list through this binding. It is a
        // binding of the tests only; wrangler.jsonc does not have it.
        serviceBindings: { OUTBOUND_LOG: () => Response.json(outbound) },
      },
    }),
  ],
  // vitest.node.config.ts runs test/node in Node.
  test: { include: ["test/**/*.test.ts"], exclude: ["test/node/**"] },
});
