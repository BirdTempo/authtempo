import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Workers pool of the remote Worker (plan 11e Task 16), the pattern of
// examples/mcp-server (@cloudflare/vitest-plugin 1.4.0). The tests run on
// workerd with the settings of wrangler.jsonc: the assets, the vars, and the
// rate limit binding. One source holds the date and the flags.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The assets folder holds the index and the skills that copy-index.mjs
 * writes. The Turbo test task runs the index task first. A run with no index
 * stops here with the command, not with a 503 in each test.
 */
for (const file of ["./dist/agent/index.json", "./dist/agent/skills.json"])
  if (!existsSync(here(file)))
    throw new Error(`${file} is missing: run pnpm turbo run index --filter=@authtempo/mcp`);

/** The index of the site build, for the test that compares it with the bytes of the assets. */
const SITE_INDEX = readFileSync(here("../../apps/site/dist/agent/index.json"), "utf8");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { SITE_INDEX },
        // The Worker makes no outbound fetch. A fetch that leaves it fails the test.
        outboundService: () => {
          throw new Error("the remote Worker made an outbound fetch");
        },
      },
    }),
  ],
  test: { include: ["test/pool/**/*.test.ts"] },
});
