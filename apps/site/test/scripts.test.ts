import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE } from "../scripts/lib/paths.ts";

// Astro telemetry reads its switch from the environment only, so each script
// sets it before astro (astro.config.mjs has the reason).
const PREFIX = "ASTRO_TELEMETRY_DISABLED=1 ";
const pkg = JSON.parse(readFileSync(`${SITE}package.json`, "utf8")) as {
  scripts: Record<string, string>;
};

describe("the package scripts (plan 11a)", () => {
  it("turn off Astro telemetry before each astro command", () => {
    const commands = Object.entries(pkg.scripts).flatMap(([name, script]) =>
      script
        .split(/&&|\|\||;/)
        .map((part) => part.trim())
        .filter((part) => /(^|\s)astro(\s|$)/.test(part))
        .map((part) => ({ name, part })),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const { name, part } of commands)
      expect({ name, prefixed: part.startsWith(PREFIX) }).toEqual({ name, prefixed: true });
  });
});
