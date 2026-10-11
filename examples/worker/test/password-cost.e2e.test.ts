import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";

const BASE = "https://example.test";

// The production config: with TEST_MODE unset, the legacy seam's `next` is
// `createPbkdf2PasswordHash()` at its default, so new hashes use 100000 iterations. One sign-up proves the
// default and the derive at that cost in local workerd. It does not prove
// the CPU time of a deployed Worker (a plan 7 input).
it("stores a hash at 100000 iterations when TEST_MODE is unset", async () => {
  // A fresh module: the Worker keeps one Auth per isolate, and an Auth
  // built under TEST_MODE uses 1000 iterations.
  vi.resetModules();
  const worker = (await import("../src/index.js")).default;
  // The plugin types `env` as `Cloudflare.Env`, which lists only the test
  // bindings; the runtime value carries every binding. The cast is the one
  // in the sweep test.
  const prodEnv: Env = { ...(env as unknown as Env), TEST_MODE: "" };
  const up = await worker.fetch(
    new Request(`${BASE}/auth/password/sign-up`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "cost@example.com", password: "correct horse battery" }),
    }),
    prodEnv,
  );
  expect(up.status).toBe(200);
  const { user } = (await up.json()) as { user: { id: string } };
  const stored = await env.DB.prepare("SELECT hash FROM ta_password WHERE user_id = ?")
    .bind(user.id)
    .first<{ hash: string }>();
  expect(stored?.hash).toMatch(/^pbkdf2-sha256\$100000\$/);
});
