import type { Gate } from "./gate.js";
import type { Sandbox } from "./sandbox.js";

// The bindings of wrangler.jsonc. @cloudflare/vitest-plugin 1.4.0 types `env`
// of cloudflare:test as `Cloudflare.Env` (types/cloudflare-test.d.ts, read 2026-10-20).
declare global {
  namespace Cloudflare {
    interface Env {
      SANDBOX: DurableObjectNamespace<Sandbox>;
      GATE: DurableObjectNamespace<Gate>;
      ASSETS: Fetcher;
      DEMO_ORIGIN: string;
    }
  }
}
