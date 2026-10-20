import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { everyFlow } from "./flows.js";
import { LONG_TEST_MS } from "./helpers.js";
import { escapes, PROBE_ENTRY } from "./outbound-log.js";

/**
 * The probe goes to a host under .invalid (RFC 6761), and no DNS answers
 * such a host. So the probe reaches no real host, also with the recorder off.
 */
const PROBE = PROBE_ENTRY.replace(/^GET /, "");

/** The requests that left the Worker in this run, from the recorder of vitest.config.ts. */
async function recorded(): Promise<string[]> {
  return (await (await env.OUTBOUND_LOG.fetch("https://outbound-log/")).json()) as string[];
}

describe("outbound requests", () => {
  it("records a request that leaves the Worker", async () => {
    // Without this, a recorder that Miniflare never calls makes the next test pass on nothing.
    const res = await fetch(PROBE);
    expect(res.status).toBe(599);
    expect(await recorded()).toContain(PROBE_ENTRY);
  });

  it(
    "sends no request out of the Worker",
    async () => {
      // The flows run first. The test reads the recorder list before any flow
      // error, so a flow that fails on a blocked request still shows the request.
      let failure: unknown = null;
      try {
        await everyFlow();
      } catch (e) {
        failure = e;
      }
      // The teardown of test/outbound-teardown.ts also reads the list after every file.
      expect(escapes(await recorded())).toEqual([]);
      expect(failure).toBeNull();
    },
    LONG_TEST_MS,
  );
});
