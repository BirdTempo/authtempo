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
import { REGISTRY_BODY_CAP_BYTES, rangeHolds } from "../src/upgrade-core.js";
import { PKG } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";
import {
  BREAKING,
  fakeRegistry,
  LATER_DEPRECATION,
  registryDoc,
  registryDocs,
} from "./support/fake-registry.js";

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
function appIo(
  text: string,
  o: {
    silent?: boolean;
    run?: () => void;
    docs?: Readonly<Record<string, Record<string, unknown>>>;
  } = {},
) {
  return fakeIo({
    files: { [APP]: text, [LOCK]: "lockfileVersion: '9.0'\n" },
    fetch: fakeRegistry({
      ...(o.silent === true ? { silent: true } : {}),
      ...(o.docs === undefined ? {} : { docs: o.docs }),
    }),
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
      expect(io.stdout, flag).toContain("  @authtempo/core 0.1.0 to 0.2.1 (dependencies)");
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
        { name: "@authtempo/core", section: "dependencies", from: "0.1.0", to: "0.2.1" },
        { name: "@authtempo/adapter-d1", section: "dependencies", from: "0.1.0", to: "0.2.1" },
        { name: "@authtempo/cli", section: "devDependencies", from: "0.1.0", to: "0.2.1" },
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

  it("writes nothing and answers 1 when the target core names no Breaking lines", async () => {
    const notice =
      "the registry names no Breaking lines for 0.3.0: read the changelog of each crossed minor at https://authtempo.com/docs/changelog/, then change the versions by hand";
    for (const facts of ["none", "no-breaking"] as const) {
      const text = fixture("app.package.json");
      const io = appIo(text, {
        docs: { ...registryDocs(), "@authtempo/core": registryDoc("@authtempo/core", { facts }) },
      });
      expect(await main(["upgrade", "app", "--to", "0.3.0"], io), facts).toBe(1);
      expect(io.files.get(APP), facts).toBe(text);
      expect(io.stdout, facts).toContain(notice);
      expect(io.stdout, facts).toContain("wrote nothing");
      expect(io.stdout, facts).toContain("0.2: https://authtempo.com/docs/changelog/");
      expect(io.stdout.join("\n"), facts).not.toContain(`wrote ${APP}`);
    }
    const json = appIo(fixture("app.package.json"), {
      docs: {
        ...registryDocs(),
        "@authtempo/core": registryDoc("@authtempo/core", { facts: "none" }),
      },
    });
    expect(await main(["upgrade", "app", "--to", "0.3.0", "--json"], json)).toBe(1);
    const doc = docOf(json.stdout);
    expect(doc.exit).toBe(1);
    expect(doc.stopped).toBe(notice);
    expect(doc.breaking).toEqual([
      { minor: "0.2", lines: [] },
      { minor: "0.3", lines: [] },
    ]);
  });

  it("stops when a package has no version at the target, and writes nothing", async () => {
    const text = fixture("app.package.json");
    const io = appIo(text, {
      docs: {
        ...registryDocs(),
        "@authtempo/adapter-d1": registryDoc("@authtempo/adapter-d1", {
          versions: ["0.1.0", "0.1.3", "0.2.0"],
          latest: "0.2.0",
        }),
      },
    });
    expect(await main(["upgrade", "app"], io)).toBe(2);
    expect(io.stderr).toContain(
      "stopped: @authtempo/adapter-d1 has no version 0.2.1 on the registry",
    );
    expect(io.files.get(APP)).toBe(text);
  });

  it("orders versions by number: 0.10.0 is above 0.9.0", async () => {
    const docs = registryDocs({ versions: ["0.9.0", "0.10.0"], latest: "0.10.0" });
    const text = fixture("app.package.json").replaceAll('"0.1.0"', '"0.9.0"');
    const io = appIo(text, { docs });
    expect(await main(["upgrade", "app"], io), io.stderr.join("\n")).toBe(0);
    expect(io.files.get(APP)).toBe(text.replaceAll('"0.9.0"', '"0.10.0"'));
    expect(io.stdout).toContain("0.10: https://authtempo.com/docs/changelog/");
    // The fake core at 0.9.0 and 0.10.0 names no schema version.
    expect(io.stdout).toContain("next: authtempo migrate (the registry names no schema version)");
    const down = fixture("app.package.json").replaceAll('"0.1.0"', '"0.10.0"');
    const back = appIo(down, { docs });
    expect(await main(["upgrade", "app", "--to", "0.9.0"], back)).toBe(2);
    expect(back.stderr).toContain("stopped: the target 0.9.0 is below the installed 0.10.0");
    expect(back.files.get(APP)).toBe(down);
  });

  it("prints no deprecation whose removeIn is the installed version", async () => {
    // The register items leave in 0.2.0. An app at 0.2.0 already lost them.
    const at = "0.2.0";
    const gone = REGISTER.filter((d) => d.removeIn === at);
    expect(gone.length).toBeGreaterThan(0);
    const io = appIo(fixture("app.package.json").replaceAll('"0.1.0"', `"${at}"`));
    expect(await main(["upgrade", "app", "--to", "0.3.0"], io)).toBe(1);
    const out = io.stdout.join("\n");
    for (const d of gone) expect(out).not.toContain(`: ${d.id}: `);
    expect(out).toContain(`removed in 0.3.0: ${LATER_DEPRECATION.id}`);
  });

  it("names no other key when the file writes a key in another form", async () => {
    // "@authtempo\/core" parses as "@authtempo/core", but the text has no such key.
    const text = fixture("app.package.json").replace(
      '"@authtempo/core": "0.1.0"',
      '"@authtempo\\/core": "0.1.0"',
    );
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(2);
    expect(io.stderr).toContain(
      `stopped: ${APP}: the versions cannot change in place; change them by hand`,
    );
    expect(io.files.get(APP)).toBe(text);
  });

  it("prints each peer range that excludes the target, and never writes it", async () => {
    const text = fixture("app.package.json").replace(
      '"type": "module",',
      `"type": "module",
  "peerDependencies": {
    "@authtempo/core": "^0.1.0",
    "@authtempo/adapter-d1": ">=0.1.0 <0.3.0",
    "@authtempo/cli": "0.1.x",
    "hono": "^3.0.0"
  },`,
    );
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(1);
    const after = io.files.get(APP) ?? "";
    expect(after).toContain('"@authtempo/core": "^0.1.0"');
    expect(after).toContain('"@authtempo/core": "0.2.1"');
    const peers = io.stdout.filter((l) => l.startsWith("  peer "));
    expect(peers).toEqual([
      "  peer @authtempo/core ^0.1.0 excludes 0.2.1: change the range by hand",
      "  peer @authtempo/cli 0.1.x: upgrade cannot read the range; check that it holds 0.2.1",
    ]);
  });

  it("names the section of each package line", async () => {
    const text = fixture("app.package.json").replace(
      '"wrangler": "4.148.0",',
      '"wrangler": "4.148.0",\n    "@authtempo/core": "0.1.0",',
    );
    const io = appIo(text);
    expect(await main(["upgrade", "app"], io)).toBe(1);
    expect(io.stdout).toContain("  @authtempo/core 0.1.0 to 0.2.1 (dependencies)");
    expect(io.stdout).toContain("  @authtempo/core 0.1.0 to 0.2.1 (devDependencies)");
    expect(io.files.get(APP)).toBe(text.replaceAll('"0.1.0"', '"0.2.1"'));
  });

  it("finds the first lockfile in the folder or in a parent folder", async () => {
    const app = "/work/apps/api/package.json";
    const run = async (files: Record<string, string>) => {
      const io = fakeIo({
        files: { [app]: fixture("app.package.json"), ...files },
        fetch: fakeRegistry(),
      });
      expect(await main(["upgrade", "apps/api", "--dry-run"], io)).toBe(1);
      return io.stdout;
    };
    const lock = "lockfileVersion: '9.0'\n";
    expect(await run({ "/work/pnpm-lock.yaml": lock })).toContain("next: pnpm install in /work");
    // The first lockfile on the walk up wins.
    expect(
      await run({ "/work/pnpm-lock.yaml": lock, "/work/apps/yarn.lock": "# yarn\n" }),
    ).toContain("next: yarn install in /work/apps");
    expect(await run({ "/work/apps/api/package-lock.json": "{}\n" })).toContain(
      "next: npm install",
    );
    expect(await run({})).toContain(
      "next: run the install of your package manager (no folder up to the root has a lockfile)",
    );
  });

  it("stops on a registry document over the cap, and writes nothing", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const big = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent > REGISTRY_BODY_CAP_BYTES) return c.close();
            sent += chunk.byteLength;
            c.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const text = fixture("app.package.json");
    const io = fakeIo({ files: { [APP]: text, [LOCK]: "" }, fetch: async () => big() });
    expect(await main(["upgrade", "app"], io)).toBe(2);
    expect(io.stderr).toContain(
      `stopped: GET https://registry.npmjs.org/@authtempo%2fcore: the answer body is over ${REGISTRY_BODY_CAP_BYTES / 1024} KiB, the cap of one read`,
    );
    expect(io.files.get(APP)).toBe(text);
  });

  it("reads a peer range as npm does, or gives null", () => {
    const cases: [string, string, boolean | null][] = [
      ["^0.1.0", "0.1.9", true],
      ["^0.1.0", "0.2.0", false],
      ["^0.0.3", "0.0.4", false],
      ["^1.2.3", "1.9.0", true],
      ["~0.2.0", "0.2.5", true],
      ["~0.2.0", "0.3.0", false],
      [">= 0.2.0 < 0.3.0", "0.2.1", true],
      ["<0.2.0 || >=0.2.1", "0.2.1", true],
      ["0.2.1", "0.2.1", true],
      ["*", "0.2.1", true],
      ["0.1.0 - 0.3.0", "0.2.1", null],
      ["0.2.x", "0.2.1", null],
      [">=0.3.0 0.2.x", "0.2.1", false],
    ];
    for (const [range, v, want] of cases) expect(rangeHolds(range, v), `${range} ${v}`).toBe(want);
  });
});
