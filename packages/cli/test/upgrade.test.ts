// `authtempo upgrade` (plan 12j Task 10, spec 33 item 10). Each test runs the
// command through main with a memory io, and the fetch of the io is a fake
// registry with the shape that Task 10 Step 1 read. No test makes a network
// call.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../src/io.js";
import { STOP_JSON, UPGRADE_JSON_KEYS, type UpgradeJson } from "../src/json.js";
import { main } from "../src/main.js";
import { PKG } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";
import { BREAKING, fakeRegistry, LATER_DEPRECATION } from "./support/fake-registry.js";

const fixture = (name: string) => readFileSync(join(PKG, "test/fixtures/upgrade", name), "utf8");
/**
 * A fixture with another indent. Biome formats each fixture with two
 * spaces, so a test makes the tab and four-space forms of an app here.
 */
const indented = (text: string, unit: string) =>
  text.replace(/^((?: {2})+)/gm, (lead: string) => unit.repeat(lead.length / 2));

const APP = "/work/app/package.json";
const LOCK = "/work/app/pnpm-lock.yaml";
const REGISTER = JSON.parse(readFileSync(join(PKG, "../../release/deprecations.json"), "utf8")) as {
  id: string;
  removeIn: string;
  docs: string;
}[];

/** An app in /work/app with the manifest `text` and a pnpm lockfile, over the fake registry. */
function appIo(text: string, o: { silent?: boolean; run?: () => void } = {}) {
  return fakeIo({
    files: { [APP]: text, [LOCK]: "lockfileVersion: '9.0'\n" },
    fetch: fakeRegistry(o.silent === true ? { silent: true } : {}),
    run: async (): Promise<RunResult> => {
      o.run?.();
      return { status: 0, stdout: "", stderr: "" };
    },
  });
}

/** The one JSON document of a `--json` run. */
function docOf(stdout: readonly string[]): UpgradeJson {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "") as UpgradeJson;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("authtempo upgrade (spec 33 item 10)", () => {
  it("moves every @authtempo package to the latest version", async () => {
    const text = fixture("app.package.json");
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io), io.stderr.join("\n")).toBe(1);
    // Only the version strings change: the key order and the indent stay.
    expect(io.files.get(APP)).toBe(text.replaceAll('"0.1.0"', '"0.2.1"'));
    const pkg = JSON.parse(io.files.get(APP) ?? "") as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@authtempo/core"]).toBe("0.2.1");
    expect(pkg.dependencies["@authtempo/adapter-d1"]).toBe("0.2.1");
    expect(pkg.devDependencies["@authtempo/cli"]).toBe("0.2.1");
    expect(pkg.dependencies.hono).toBe("4.12.4");
    expect(io.stdout).toContain(`wrote ${APP}`);
    expect(io.stdout).toContain("next: pnpm install");
  });

  it("takes --to", async () => {
    const text = indented(fixture("postgres.package.json"), "\t");
    const io = appIo(text);
    expect(await main(["upgrade", "app", "--to", "0.1.3"], io), io.stderr.join("\n")).toBe(0);
    expect(io.files.get(APP)).toBe(text.replaceAll('"0.1.0"', '"0.1.3"'));
    expect(io.files.get(APP)).toContain('\t\t"@authtempo/core": "0.1.3"');
  });

  it("moves the better-auth alias", async () => {
    const text = indented(fixture("alias.package.json"), "    ");
    expect(text).toContain('\n        "better-auth": ');
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io), io.stderr.join("\n")).toBe(1);
    const after = io.files.get(APP) ?? "";
    expect(after).toContain('"better-auth": "npm:@authtempo/compat-better-auth@0.2.1"');
    expect(after).toBe(
      text
        .replace("compat-better-auth@0.1.0", "compat-better-auth@0.2.1")
        .replaceAll('"0.1.0"', '"0.2.1"'),
    );
    // The registry document of the compat package is read for the alias.
    expect(io.requests.map((r) => r.url)).toContain(
      "https://registry.npmjs.org/@authtempo%2fcompat-better-auth",
    );
  });

  it("stops on two versions of the group in one app", async () => {
    const text = fixture("app.package.json").replace(
      '"@authtempo/adapter-d1": "0.1.0"',
      '"@authtempo/adapter-d1": "0.1.3"',
    );
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(2);
    const stopped = io.stderr.filter((l) => l.startsWith("stopped: "));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain("0.1.0");
    expect(stopped[0]).toContain("0.1.3");
    expect(io.files.get(APP)).toBe(text);
    expect(io.requests).toEqual([]);
  });

  it("stops on no @authtempo package", async () => {
    const text = '{\n  "name": "plain",\n  "dependencies": { "hono": "4.12.4" }\n}\n';
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(2);
    expect(io.stderr).toContain(`stopped: no @authtempo package in ${APP}`);
    expect(io.requests).toEqual([]);
  });

  it("stops on a downgrade", async () => {
    const text = fixture("app.package.json").replaceAll('"0.1.0"', '"0.2.0"');
    const io = appIo(text);
    expect(await main(["upgrade", "app", "--to", "0.1.0"], io)).toBe(2);
    expect(io.stderr).toContain("stopped: the target 0.1.0 is below the installed 0.2.0");
    expect(io.files.get(APP)).toBe(text);
  });

  it("stops on no registry answer", async () => {
    vi.useFakeTimers();
    const text = fixture("app.package.json");
    const io = appIo(text, { silent: true });
    let code: number | null = null;
    const run = main(["upgrade", "app"], io).then((c) => {
      code = c;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(code).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(code).toBe(2);
    expect(io.stderr).toContain(
      "stopped: GET https://registry.npmjs.org/@authtempo%2fcore: no answer in 10 s",
    );
    expect(io.files.get(APP)).toBe(text);
  });

  it("prints migrate when the schema version changes", async () => {
    const io = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app"], io)).toBe(1);
    expect(io.stdout).toContain("next: authtempo migrate (schema version 15 to 16)");
    expect(io.stdout).toContain("next: read https://authtempo.com/docs/operations/upgrades/");
    // A patch in one minor keeps the schema version: no migrate step.
    const patch = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app", "--to", "0.1.3"], patch)).toBe(0);
    expect(patch.stdout.join("\n")).not.toContain("authtempo migrate");
  });

  it("prints each Breaking line of each crossed minor", async () => {
    const io = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app", "--to", "0.3.0"], io)).toBe(1);
    const out = io.stdout.join("\n");
    for (const minor of ["0.2", "0.3"]) {
      expect(io.stdout).toContain(`${minor}: https://authtempo.com/docs/changelog/`);
      for (const line of BREAKING[minor] ?? []) expect(io.stdout).toContain(`  ${line}`);
    }
    // The minor of the installed version is not crossed.
    expect(out).not.toContain("0.1: ");
    expect(out.indexOf("0.2: ")).toBeLessThan(out.indexOf("0.3: "));
  });

  it("prints each deprecation whose removeIn is crossed", async () => {
    const io = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app"], io)).toBe(1);
    expect(REGISTER.length).toBeGreaterThan(0);
    for (const d of REGISTER)
      expect(io.stdout).toContain(
        `removed in ${d.removeIn}: ${d.id}: https://authtempo.com${d.docs}`,
      );
    // 0.3.0 is above the target 0.2.1: that entry is not crossed.
    expect(io.stdout.join("\n")).not.toContain(LATER_DEPRECATION.id);
    const later = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app", "--to", "0.3.0"], later)).toBe(1);
    expect(later.stdout.join("\n")).toContain(`removed in 0.3.0: ${LATER_DEPRECATION.id}`);
  });

  it("writes nothing with --dry-run", async () => {
    for (const flag of ["--dry-run", "-n"]) {
      const text = fixture("app.package.json");
      const io = appIo(text);
      expect(await main(["upgrade", "app", flag], io), flag).toBe(1);
      expect(io.files.get(APP), flag).toBe(text);
      expect(io.stdout, flag).toContain("dry run: wrote nothing");
      expect(io.stdout, flag).toContain("  @authtempo/core 0.1.0 to 0.2.1");
    }
  });

  it("answers 0 when the app is current", async () => {
    const text = fixture("app.package.json").replaceAll('"0.1.0"', '"0.2.1"');
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(0);
    expect(io.files.get(APP)).toBe(text);
    expect(io.stdout).toEqual(["the app is at 0.2.1, the target: nothing to change"]);
  });

  it("prints one JSON document with --json", async () => {
    const io = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app", "--json"], io)).toBe(1);
    const doc = docOf(io.stdout);
    expect(Object.keys(doc).sort()).toEqual(Object.keys(UPGRADE_JSON_KEYS).sort());
    expect(doc).toEqual({
      exit: 1,
      stopped: null,
      from: "0.1.0",
      to: "0.2.1",
      packages: [
        { name: "@authtempo/core", from: "0.1.0", to: "0.2.1" },
        { name: "@authtempo/adapter-d1", from: "0.1.0", to: "0.2.1" },
        { name: "@authtempo/cli", from: "0.1.0", to: "0.2.1" },
      ],
      schema: { from: 15, to: 16, migrate: true },
      breaking: [{ minor: "0.2", lines: [...(BREAKING["0.2"] ?? [])] }],
      deprecations: REGISTER.map((d) => ({ id: d.id, removeIn: d.removeIn, docs: d.docs })),
    } satisfies UpgradeJson);
    // The human lines go to stderr.
    expect(io.stderr).toContain("next: pnpm install");
    const stop = appIo('{ "name": "plain" }\n');
    expect(await main(["upgrade", "app", "--json"], stop)).toBe(2);
    expect(docOf(stop.stdout)).toEqual({
      ...STOP_JSON.upgrade,
      exit: 2,
      stopped: `no @authtempo package in ${APP}`,
    });
  });

  it("runs no install and no child process", async () => {
    let calls = 0;
    const io = appIo(fixture("app.package.json"), { run: () => calls++ });
    expect(await main(["upgrade", "app"], io)).toBe(1);
    expect(io.files.get(APP)).toContain('"@authtempo/core": "0.2.1"');
    expect(calls).toBe(0);
  });

  it("reads the full document of each package once, with Accept: application/json", async () => {
    const io = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app"], io)).toBe(1);
    expect(io.requests.map((r) => r.url).sort()).toEqual(
      [
        "https://registry.npmjs.org/@authtempo%2fadapter-d1",
        "https://registry.npmjs.org/@authtempo%2fcli",
        "https://registry.npmjs.org/@authtempo%2fcore",
      ].sort(),
    );
    // The abbreviated document drops the custom key `authtempo` (Step 1).
    for (const r of io.requests) {
      expect(r.method).toBe("GET");
      expect(r.headers.get("accept")).toBe("application/json");
    }
  });

  it("refuses an http registry that is not on this machine", async () => {
    const io = appIo(fixture("app.package.json"));
    expect(await main(["upgrade", "app", "--registry", "http://registry.example.com/"], io)).toBe(
      2,
    );
    expect(io.stderr[0]).toContain("must use https");
    expect(io.requests).toEqual([]);
    const local = fakeIo({
      files: { [APP]: fixture("app.package.json") },
      fetch: fakeRegistry({ base: "http://127.0.0.1:4873/" }),
    });
    expect(
      await main(["upgrade", "app", "--registry", "http://127.0.0.1:4873", "--dry-run"], local),
      local.stderr.join("\n"),
    ).toBe(1);
    expect(local.requests[0]?.url).toBe("http://127.0.0.1:4873/@authtempo%2fcore");
  });

  it("stops when another key holds the same text, and writes nothing", async () => {
    // pnpm.overrides is no list of the command: a change there is no version move.
    const text = fixture("app.package.json").replace(
      '"type": "module",',
      '"type": "module",\n  "pnpm": { "overrides": { "@authtempo/core": "0.1.0" } },',
    );
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(2);
    expect(io.stderr).toContain(
      `stopped: ${APP}: the versions cannot change in place, because another key holds the same text; change them by hand`,
    );
    expect(io.files.get(APP)).toBe(text);
  });

  it("stops on a version that is not exact, before any request", async () => {
    const text = fixture("app.package.json").replace(
      '"@authtempo/core": "0.1.0"',
      '"@authtempo/core": "workspace:*"',
    );
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(2);
    expect(io.stderr).toContain(
      'stopped: @authtempo/core is "workspace:*" in dependencies; upgrade needs a version such as 0.1.0',
    );
    expect(io.requests).toEqual([]);
  });
});
