import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// release/smoke/smoke.mjs in the apps phase: an app that runs no kit holds
// no kit tool. The phase read node_modules/<tool> at the top level only, so a
// tool that a dependency brings into the hidden hoist of pnpm passed
// (rr-task3b N1 of plan 12j).
const SMOKE = fileURLToPath(new URL("../../../release/smoke/", import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The failure lines of smoke.mjs in the apps phase, in a copy of the smoke app after `edit`. */
function appsPhase(edit: (app: string) => void): string[] {
  const temp = mkdtempSync(join(tmpdir(), "authtempo-smoke-test-"));
  made.push(temp);
  const app = join(temp, "smoke-apps");
  cpSync(SMOKE, app, { recursive: true });
  mkdirSync(join(app, "node_modules/.pnpm"), { recursive: true });
  edit(app);
  const config = join(temp, "config.json");
  writeFileSync(config, JSON.stringify({ fixed: [[]] }));
  const r = spawnSync(process.execPath, ["smoke.mjs", config, "apps"], {
    cwd: app,
    encoding: "utf8",
  });
  return r.stdout.split("\n").filter((l) => l.startsWith("  "));
}

const has = (lines: string[], text: string) => lines.some((l) => l.includes(text));

describe("the apps phase of the smoke", () => {
  it("fails a kit tool at the top level, in the hidden hoist, or in the store folder", () => {
    const tool = (path: string) => (app: string) => mkdirSync(join(app, path), { recursive: true });
    expect(
      has(
        appsPhase(() => {}),
        "vitest is installed",
      ),
    ).toBe(false);
    expect(
      has(
        appsPhase(tool("node_modules/vitest")),
        "vitest is installed in node_modules, so the apps phase proves nothing",
      ),
    ).toBe(true);
    expect(
      has(
        appsPhase(tool("node_modules/.pnpm/node_modules/vitest")),
        "vitest is installed in the hidden hoist of pnpm, so the apps phase proves nothing",
      ),
    ).toBe(true);
    expect(
      has(
        appsPhase(tool("node_modules/.pnpm/vitest@5.0.3/node_modules/vitest")),
        "vitest is installed in the store folder of pnpm, so the apps phase proves nothing",
      ),
    ).toBe(true);
  });
});
