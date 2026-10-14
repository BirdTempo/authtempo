/**
 * The PBKDF2 probe of plan 12b. One PBKDF2-HMAC-SHA256 derive of 32 bytes
 * with a 16-byte salt, at the count that the query names, on a deployed
 * Worker. Spec 9 holds the default at 100000 until a deployed Worker proves a
 * higher count. The CPU time comes from `wrangler tail` (`cpuTime`) or the
 * invocation logs: a Worker's clock does not move while its code runs, so
 * `ms` is not the CPU time.
 */

export interface Env {
  /** The key of the one caller, the owner. Without it the probe answers 403, so a stranger cannot spend its CPU. */
  PROBE_KEY?: string;
}

/** The highest count the probe asks for: ten times the largest count of the runbook. */
export const MAX_ITERATIONS = 10_000_000;

/** A compare in time that depends on the longer length only. */
function same(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function probe(
  iterations: number,
): Promise<{ iterations: number; ok: boolean; error: string | null; ms: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("correct horse battery staple"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const started = Date.now();
  try {
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    return { iterations, ok: true, error: null, ms: Date.now() - started };
  } catch (e) {
    // The exact text is the record. workerd 1.20261006.1 holds "Pbkdf2 failed:
    // iteration counts above <max> are not supported (requested <n>)." (read in
    // the darwin-arm64 binary 2026-10-14, and again 2026-10-15).
    return {
      iterations,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - started,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/probe") return new Response("not found", { status: 404 });
    const key = request.headers.get("x-probe-key") ?? "";
    if (!env.PROBE_KEY || !same(key, env.PROBE_KEY))
      return new Response("forbidden", { status: 403 });
    const n = Number(url.searchParams.get("iterations"));
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ITERATIONS)
      return new Response(`iterations must be an integer from 1 to ${MAX_ITERATIONS}`, {
        status: 400,
      });
    return Response.json(await probe(n));
  },
};
