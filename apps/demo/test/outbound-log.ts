/**
 * The list of each request that left the Worker in this run, as "METHOD URL"
 * (plan 11b Task 12, ruling 40 of its lane). vitest.config.ts writes it, and
 * test/outbound-teardown.ts reads it once every pool file has run. Vitest
 * can load the config and the global setup as two copies of this module. So
 * the list lives on globalThis under one key, and both copies see one list.
 */
const KEY = Symbol.for("authtempo.demo.outbound");

/** The one probe of outbound.test.ts. It proves that Miniflare calls the recorder. */
export const PROBE_ENTRY = "GET https://outbound-probe.invalid/?from=test";

export function outboundLog(): string[] {
  const store = globalThis as { [KEY]?: string[] };
  store[KEY] ??= [];
  return store[KEY];
}

/** Each entry but the probe: a request that a demo route or a test sent out. */
export function escapes(log: readonly string[]): string[] {
  return log.filter((entry) => entry !== PROBE_ENTRY);
}
