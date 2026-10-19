import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { everyFlow } from "./flows.js";

/**
 * A probe host under .invalid (RFC 6761): no DNS answers it, so the probe
 * reaches no real host even when the recorder is off.
 */
const PROBE = "https://outbound-probe.invalid/";

/** The requests that left the Worker in this run, from the recorder of vitest.config.ts. */
async function recorded(): Promise<string[]> {
  return (await (await env.OUTBOUND_LOG.fetch("https://outbound-log/")).json()) as string[];
}

describe("outbound requests", () => {
  it("records a request that leaves the Worker", async () => {
    // Without this, a recorder that Miniflare never calls makes the next test pass on nothing.
    const res = await fetch(`${PROBE}?from=test`);
    expect(res.status).toBe(599);
    expect(await recorded()).toContain(`GET ${PROBE}?from=test`);
  });

  it("sends no request out of the Worker", async () => {
    // The flows run first. The test reads the recorder list before any flow
    // error, so a flow that fails on a blocked request still shows the request.
    let failure: unknown = null;
    try {
      await everyFlow();
    } catch (e) {
      failure = e;
    }
    expect((await recorded()).filter((r) => !r.includes(PROBE))).toEqual([]);
    expect(failure).toBeNull();
  });
});
