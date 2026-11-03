import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  scripts?: { test?: string };
};
const steps = (manifest.scripts?.test ?? "").split(" && ");

// The count reporter of a config fails a missing run only when that config
// runs. So a test script without the Bun step passed every check (review of
// plan 12n Task 4, break H2). These facts hold each step of the script.
describe("the test script of the package (plan 12n)", () => {
  it("runs the bun:sqlite suite under the Bun runtime", () => {
    expect(steps).toContain("bun --bun vitest run -c vitest.bun.config.ts");
  });

  it("runs each vitest config at the package root", () => {
    const configs = readdirSync(root).filter((f) => /^vitest(\.[\w-]+)?\.config\.ts$/.test(f));
    expect(configs).toEqual(
      expect.arrayContaining(["vitest.config.ts", "vitest.bun.config.ts", "vitest.d1.config.ts"]),
    );
    const stepOf = (config: string) =>
      config === "vitest.config.ts" ? "vitest run" : `vitest run -c ${config}`;
    for (const config of configs)
      expect([config, steps.some((s) => s.endsWith(stepOf(config)))]).toEqual([config, true]);
  });
});
