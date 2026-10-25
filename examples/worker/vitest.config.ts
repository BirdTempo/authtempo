import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * The probe of the Task 5 re-review of plan 12i (rr12i5/workerd-detached.mjs),
 * as a Worker of the test pool. Each request starts three I/O steps with no
 * timer: the cap, the row, and the SMS of a phone code. "/waituntil/<id>/<run>"
 * gives the work to `ctx.waitUntil`; "/detached/<id>/<run>" gives it to no
 * one. "/count/<id>" answers how many runs of each mode made each step.
 */
const DETACHED_PROBE = `export default {
  async fetch(request, env, ctx) {
    const [, mode, id, run] = new URL(request.url).pathname.split("/");
    if (mode === "count") {
      const listed = await env.PROBE_KV.list({ prefix: id + "/" });
      const count = {};
      for (const key of listed.keys) {
        const [, m, , step] = key.name.split("/");
        count[m + "/" + step] = (count[m + "/" + step] ?? 0) + 1;
      }
      return Response.json(count);
    }
    const work = (async () => {
      for (const step of ["cap", "row", "sms"])
        await env.PROBE_KV.put(id + "/" + mode + "/" + run + "/" + step, "1");
    })().catch(() => {});
    if (mode === "waituntil") ctx.waitUntil(work);
    return new Response("ok");
  },
};`;

// Option names checked against @cloudflare/vitest-plugin 1.3.7 on 2026-10-09.
// The auxiliary worker list (`miniflare.workers`) checked against 1.4.0
// (dist/pool/index.d.mts:35) on 2026-10-25.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/adapter-d1/migrations", import.meta.url)),
  );
  const compatMigrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/compat-better-auth/migrations/d1", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MODE: "1",
            AUTH_SECRET: "0123456789abcdef0123456789abcdef",
            TEST_MIGRATIONS: migrations,
            COMPAT_MIGRATIONS: compatMigrations,
            GOOGLE_CLIENT_ID: "example-client",
            GOOGLE_CLIENT_SECRET: "example-secret",
            // The Expo Go redirect for the dev-redirect test. A RegExp source with no flags.
            DEV_REDIRECT_PATTERN: "^exp://192\\.168\\.1\\.20:8081/--/auth$",
            // The SHA-256 hex of "authtempo-example-operator-secret-0123456789" (plan 11c).
            OPERATOR_SECRET_HASH:
              "9553f46eb9e964b487a02e36147c562555bf1a684cfa614904bcc0f5ab5f1c57",
          },
          serviceBindings: { DETACHED_PROBE: "detached-probe" },
          workers: [
            {
              name: "detached-probe",
              modules: true,
              script: DETACHED_PROBE,
              compatibilityDate: "2026-10-01",
              kvNamespaces: { PROBE_KV: "detached-probe" },
            },
          ],
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      // The RS256 cost measure runs by hand only, through vitest.cost.config.ts (plan 12e Task 2).
      exclude: [...configDefaults.exclude, "test/rs256-cost.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
