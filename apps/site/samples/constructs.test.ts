import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sampleFiles } from "../scripts/lib/load.ts";
import { SITE } from "../scripts/lib/paths.ts";
import { harness, sharedTestLimiter } from "./support/harness.ts";

// Review Focus 2 of plan 11a: a reader copies a config from a page, and
// createAuth refuses it at construction. Every sample file is imported, and
// every `create…Auth` export is called with the harness, so a later sample
// needs no edit here. A sample with a daily cap takes a required `limiter`;
// each call gets a shared test limiter, as a production app passes a shared
// one (ruling 41 M1). A sample with no cap ignores it.
const files = sampleFiles();

describe("every sample config constructs (plan 11a, Review Focus 2)", () => {
  it("finds the sample files", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files)
    it(file.slice(SITE.length), async () => {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (!/^create\w*Auth$/.test(name) || typeof value !== "function") continue;
        const auth = (value as (deps: unknown) => { handle?: unknown })({
          ...harness(),
          limiter: sharedTestLimiter(),
        });
        expect({ name, handle: typeof auth.handle }).toEqual({ name, handle: "function" });
      }
    });
});
