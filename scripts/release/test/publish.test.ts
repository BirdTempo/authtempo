import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { releasedNames } from "../src/lib/released.ts";
import { readWorkspace } from "../src/lib/workspace.ts";
import {
  dependencyNames,
  publish,
  publishLines,
  publishPlan,
  REGISTRY_ARGS,
  readView,
  type Seams,
  type Tarball,
  type ViewAnswer,
  viewArgs,
} from "../src/publish.ts";

const folders: string[] = [];
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

/**
 * The folder that the job publish downloads. It holds one pnpm pack tarball of
 * core and one of client at `version`. SHA256SUMS has the form of sha256sum:
 * the hash, two spaces, the file name. client depends on core.
 */
function downloaded(version: string, react = false): string {
  const root = mkdtempSync(join(tmpdir(), "authtempo-release-publish-"));
  folders.push(root);
  const out = join(root, "out");
  mkdirSync(out);
  // The client comes first in the folder, so the order of the plan comes from the graph.
  const manifests = [
    { name: "@authtempo/client", version, dependencies: { "@authtempo/core": version } },
    { name: "@authtempo/core", version },
    // With react, a third package that depends on the client, so it publishes last.
    ...(react
      ? [{ name: "@authtempo/react", version, dependencies: { "@authtempo/client": version } }]
      : []),
  ];
  for (const manifest of manifests) {
    const dir = join(root, manifest.name.replace("@authtempo/", ""));
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "index.js"), "export {};\n");
    execFileSync("pnpm", ["pack", "--pack-destination", out], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: "pipe",
    });
  }
  const sums = readdirSync(out)
    .sort()
    .map(
      (f) =>
        `${createHash("sha256")
          .update(readFileSync(join(out, f)))
          .digest("hex")}  ${f}\n`,
    );
  writeFileSync(join(out, "SHA256SUMS"), sums.join(""));
  return out;
}

const CORE = (v: string) => `authtempo-core-${v}.tgz`;
const CLIENT = (v: string) => `authtempo-client-${v}.tgz`;
const REACT = (v: string) => `authtempo-react-${v}.tgz`;

/** Fake seams that record each call. The registry holds what `view` answers. */
function fake(options: {
  npm?: string;
  view?: (spec: string, field: string) => ViewAnswer;
  publishCode?: (file: string) => number;
}) {
  const calls: string[][] = [];
  const views: string[] = [];
  const seams: Seams = {
    run(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "--version")
        return { code: 0, stdout: `${options.npm ?? "11.19.1"}\n`, stderr: "" };
      const file = args[1] ?? "";
      return { code: options.publishCode?.(file) ?? 0, stdout: "", stderr: "" };
    },
    npmView(spec, field) {
      views.push(`${spec} ${field}`);
      return options.view?.(spec, field) ?? { missing: true };
    },
  };
  const published = () =>
    calls.filter((c) => c[1] === "publish").map((c) => (c[2] ?? "").split("/").pop());
  return { seams, calls, views, published };
}

describe("publish", () => {
  it("publishes each tarball that the registry lacks, with latest", () => {
    const out = downloaded("0.1.0");
    const f = fake({});
    const outcome = publish(out, f.seams);
    expect(outcome.failures).toEqual([]);
    // Core first: the client depends on it.
    expect(f.calls.filter((c) => c[1] === "publish")).toEqual([
      [
        "npm",
        "publish",
        join(out, CORE("0.1.0")),
        "--access",
        "public",
        "--tag",
        "latest",
        "--registry=https://registry.npmjs.org/",
        "--@authtempo:registry=https://registry.npmjs.org/",
      ],
      [
        "npm",
        "publish",
        join(out, CLIENT("0.1.0")),
        "--access",
        "public",
        "--tag",
        "latest",
        "--registry=https://registry.npmjs.org/",
        "--@authtempo:registry=https://registry.npmjs.org/",
      ],
    ]);
    expect(publishLines(outcome)).toEqual([
      "publish: PASS published=2 skipped=0 failures=0",
      "  published: @authtempo/core@0.1.0 is on the registry",
      "  published: @authtempo/client@0.1.0 is on the registry",
    ]);
  });

  it("skips a version that the registry holds", () => {
    // A rerun after a partial publish: core 0.1.0 is on the registry.
    const out = downloaded("0.1.0");
    const integrity = `sha512-${createHash("sha512")
      .update(readFileSync(join(out, CORE("0.1.0"))))
      .digest("base64")}`;
    const held = (registryIntegrity: string) =>
      fake({
        view: (spec, field) => {
          if (spec === "@authtempo/core@0.1.0" && field === "version") return { found: "0.1.0" };
          if (spec === "@authtempo/core@0.1.0" && field === "dist.integrity")
            return { found: registryIntegrity };
          if (spec === "@authtempo/core" && field === "dist-tags.latest") return { found: "0.1.0" };
          return { missing: true };
        },
      });
    const f = held(integrity);
    const outcome = publish(out, f.seams);
    expect(f.published()).toEqual([CLIENT("0.1.0")]);
    expect(publishLines(outcome)).toEqual([
      "publish: PASS published=1 skipped=1 failures=0",
      "  published: @authtempo/client@0.1.0 is on the registry",
      "  skipped: @authtempo/core@0.1.0 is on the registry",
    ]);
    // Other bytes at the held version, such as a publish by hand, fail, and nothing publishes (ruling 67 of plan 12j, Low 2).
    const other = held("sha512-b3RoZXI=");
    expect(publishLines(publish(out, other.seams))).toEqual([
      "publish: FAIL published=0 skipped=0 failures=1",
      `  @authtempo/core@0.1.0: the registry holds this version with dist.integrity sha512-b3RoZXI=, not ${integrity} of the tarball`,
    ]);
    expect(other.published()).toEqual([]);
  });

  it("refuses a tarball whose SHA-256 differs", () => {
    const out = downloaded("0.1.0");
    const path = join(out, CLIENT("0.1.0"));
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    writeFileSync(path, bytes);
    const f = fake({});
    const outcome = publish(out, f.seams);
    expect(f.published()).toEqual([]);
    expect(outcome.failures).toEqual([`the SHA-256 of ${CLIENT("0.1.0")} differs from SHA256SUMS`]);
    expect(publishLines(outcome)[0]).toBe("publish: FAIL published=0 skipped=0 failures=1");
  });

  it("refuses a tarball with no line in SHA256SUMS, and a line with no tarball", () => {
    const out = downloaded("0.1.0");
    const lines = readFileSync(join(out, "SHA256SUMS"), "utf8").split("\n");
    writeFileSync(join(out, "SHA256SUMS"), `${lines[0]}\n${"0".repeat(64)}  other.tgz\n`);
    const f = fake({});
    expect(publish(out, f.seams).failures).toEqual([
      `${CORE("0.1.0")} has no line in SHA256SUMS`,
      "SHA256SUMS names other.tgz, and the folder has no such tarball",
    ]);
    expect(f.published()).toEqual([]);
  });

  it("refuses an npm below 11.5.1", () => {
    const out = downloaded("0.1.0");
    const f = fake({ npm: "11.5.0" });
    expect(publish(out, f.seams).failures).toEqual([
      "npm 11.5.0 is below 11.5.1, the floor of trusted publishing",
    ]);
    expect(f.published()).toEqual([]);
    expect(publish(out, fake({ npm: "11.5.1" }).seams).failures).toEqual([]);
  });

  it("tags an older minor with release-<major>.<minor>", () => {
    const out = downloaded("0.1.3");
    const f = fake({
      view: (_spec, field) =>
        field === "dist-tags.latest" ? { found: "0.2.0" } : { missing: true },
    });
    expect(publish(out, f.seams).failures).toEqual([]);
    expect(f.calls.filter((c) => c[1] === "publish").map((c) => c[c.indexOf("--tag") + 1])).toEqual(
      ["release-0.1", "release-0.1"],
    );
  });

  it("stops on a registry error that is not E404", () => {
    const out = downloaded("0.1.0");
    const f = fake({
      view: (spec) =>
        spec.startsWith("@authtempo/client") ? { error: "ETIMEDOUT" } : { missing: true },
    });
    const outcome = publish(out, f.seams);
    expect(f.published()).toEqual([]);
    expect(outcome.failures).toEqual([
      "@authtempo/client: the registry answered ETIMEDOUT; nothing is published",
    ]);
  });

  it("stops at the first npm publish that fails", () => {
    const out = downloaded("0.1.0");
    const f = fake({ publishCode: (file) => (file.endsWith(CORE("0.1.0")) ? 1 : 0) });
    const outcome = publish(out, f.seams);
    expect(f.published()).toEqual([CORE("0.1.0")]);
    expect(publishLines(outcome)).toEqual([
      "publish: FAIL published=0 skipped=0 failures=1",
      `  npm publish ${CORE("0.1.0")} exited 1; rerun the workflow on the same tag`,
      "  not published: @authtempo/core@0.1.0 is not on the registry",
      "  not published: @authtempo/client@0.1.0 is not on the registry",
    ]);
  });

  it("names each version on the registry and each version not on it after a half release", () => {
    // core publishes, the client fails, and react, which needs the client, gets no call.
    const out = downloaded("0.1.0", true);
    const f = fake({ publishCode: (file) => (file.endsWith(CLIENT("0.1.0")) ? 1 : 0) });
    const outcome = publish(out, f.seams);
    expect(f.published()).toEqual([CORE("0.1.0"), CLIENT("0.1.0")]);
    expect(publishLines(outcome)).toEqual([
      "publish: FAIL published=1 skipped=0 failures=1",
      `  npm publish ${CLIENT("0.1.0")} exited 1; rerun the workflow on the same tag`,
      "  published: @authtempo/core@0.1.0 is on the registry",
      "  not published: @authtempo/client@0.1.0 is not on the registry",
      "  not published: @authtempo/react@0.1.0 is not on the registry",
    ]);
    expect(f.calls.some((c) => (c[2] ?? "").endsWith(REACT("0.1.0")))).toBe(false);
  });

  it("publishes with --access public and no --provenance flag", () => {
    const out = downloaded("0.1.0");
    const f = fake({});
    publish(out, f.seams);
    for (const call of f.calls.filter((c) => c[1] === "publish")) {
      expect(call).toContain("--access");
      expect(call[call.indexOf("--access") + 1]).toBe("public");
      // Provenance comes from publishConfig.provenance and the OIDC token.
      expect(call).not.toContain("--provenance");
      // The call holds no token.
      expect(call.join(" ")).not.toMatch(/token|_auth/i);
    }
    expect(f.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "npm --version",
      "npm publish",
      "npm publish",
    ]);
  });

  it("decides nothing when one rule fails", () => {
    const tarball = (name: string, version: string): Tarball => ({
      file: `${name.replace("@authtempo/", "authtempo-")}-${version}.tgz`,
      name,
      version,
      sha256: "a".repeat(64),
      integrity: "sha512-a",
      dependencies: [],
    });
    const plan = (tarballs: Tarball[], registry: Parameters<typeof publishPlan>[0]["registry"]) =>
      publishPlan({
        tarballs,
        sums: new Map(tarballs.map((t) => [t.file, t.sha256])),
        registry,
        npmVersion: "11.19.1",
      });
    const free = { held: false, latest: null };
    expect(plan([tarball("@authtempo/core", "0.1.0")], { "@authtempo/core": free })).toEqual({
      publish: [{ file: "authtempo-core-0.1.0.tgz", tag: "latest" }],
      skip: [],
      failures: [],
    });
    // One registry error: the plan holds no publish, also for the package that answered.
    expect(
      plan([tarball("@authtempo/core", "0.1.0"), tarball("@authtempo/client", "0.1.0")], {
        "@authtempo/core": free,
        "@authtempo/client": { error: "ETIMEDOUT" },
      }),
    ).toEqual({
      publish: [],
      skip: [],
      failures: ["@authtempo/client: the registry answered ETIMEDOUT; nothing is published"],
    });
    // The fixed group has one version.
    expect(
      plan([tarball("@authtempo/core", "0.1.0"), tarball("@authtempo/client", "0.1.1")], {
        "@authtempo/core": free,
        "@authtempo/client": free,
      }).failures,
    ).toEqual(["the tarballs hold 2 versions: 0.1.0, 0.1.1"]);
  });

  it("fails a cycle in the dependency graph and a version that is not x.y.z", () => {
    const tarball = (name: string, version: string, dependencies: string[]): Tarball => ({
      file: `${name.replace("@authtempo/", "authtempo-")}-${version}.tgz`,
      name,
      version,
      sha256: "a".repeat(64),
      integrity: "sha512-a",
      dependencies,
    });
    const plan = (tarballs: Tarball[]) =>
      publishPlan({
        tarballs,
        sums: new Map(tarballs.map((t) => [t.file, t.sha256])),
        registry: Object.fromEntries(tarballs.map((t) => [t.name, { held: false, latest: null }])),
        npmVersion: "11.19.1",
      });
    expect(
      plan([
        tarball("@authtempo/core", "0.1.0", ["@authtempo/client"]),
        tarball("@authtempo/client", "0.1.0", ["@authtempo/core"]),
      ]),
    ).toEqual({
      publish: [],
      skip: [],
      failures: [
        "the dependency graph has a cycle: @authtempo/client -> @authtempo/core -> @authtempo/client",
      ],
    });
    expect(plan([tarball("@authtempo/core", "0.1", [])])).toEqual({
      publish: [],
      skip: [],
      failures: ["authtempo-core-0.1.tgz: the version 0.1 is not x.y.z"],
    });
  });

  it("refuses a SHA256SUMS line that is not <sha256>  <file>", () => {
    const out = downloaded("0.1.0");
    const lines = readFileSync(join(out, "SHA256SUMS"), "utf8").split("\n");
    // One space in place of two: sha256sum never writes this form.
    const bad = (lines[0] ?? "").replace("  ", " ");
    writeFileSync(join(out, "SHA256SUMS"), `${bad}\n${lines[1]}\n`);
    const f = fake({});
    expect(publish(out, f.seams).failures).toEqual([
      `SHA256SUMS: the line ${bad} is not <sha256>  <file>`,
      `${CLIENT("0.1.0")} has no line in SHA256SUMS`,
    ]);
    expect(f.published()).toEqual([]);
  });

  it("prints a FAIL line, not a stack, when SHA256SUMS is missing", () => {
    const out = downloaded("0.1.0");
    rmSync(join(out, "SHA256SUMS"));
    const f = fake({});
    expect(publishLines(publish(out, f.seams))).toEqual([
      "publish: FAIL published=0 skipped=0 failures=1",
      "  the folder has no SHA256SUMS; the job check writes it",
    ]);
    expect(f.published()).toEqual([]);
  });

  it("prints a FAIL line, not a stack, for a tarball that it cannot read (ruling 64 of plan 12j, Minor 3)", () => {
    const out = downloaded("0.1.0");
    // A tarball with no package/package.json, and a file that is not gzip.
    const empty = join(out, "..", "empty");
    mkdirSync(join(empty, "package"), { recursive: true });
    writeFileSync(join(empty, "package/README.md"), "# none\n");
    execFileSync("tar", ["-czf", join(out, CORE("0.1.0")), "-C", empty, "package"]);
    writeFileSync(join(out, CLIENT("0.1.0")), "not a tarball\n");
    const sums = [CLIENT("0.1.0"), CORE("0.1.0")].map(
      (file) =>
        `${createHash("sha256")
          .update(readFileSync(join(out, file)))
          .digest("hex")}  ${file}\n`,
    );
    writeFileSync(join(out, "SHA256SUMS"), sums.join(""));
    const f = fake({});
    expect(publishLines(publish(out, f.seams))).toEqual([
      "publish: FAIL published=0 skipped=0 failures=2",
      `  ${CLIENT("0.1.0")}: incorrect header check`,
      `  ${CORE("0.1.0")}: the tarball has no package/package.json`,
    ]);
    expect(f.views).toEqual([]);
    expect(f.published()).toEqual([]);
  });

  it("reads each answer of npm view, and an answer that is not JSON is an error", () => {
    expect(readView(0, '"0.1.0"\n', "")).toEqual({ found: "0.1.0" });
    expect(readView(0, "\n", "")).toEqual({ missing: true });
    expect(readView(1, "", "npm error code E404\n")).toEqual({ missing: true });
    expect(readView(1, "", "\nnpm error ETIMEDOUT\n")).toEqual({ error: "npm error ETIMEDOUT" });
    expect(readView(0, '["0.1.0"]', "")).toEqual({ error: 'the answer ["0.1.0"]' });
    expect(readView(0, "<html>", "")).toEqual({ error: "the answer <html> is not JSON" });
  });

  it("fails when it reads zero tarballs", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-release-publish-"));
    folders.push(out);
    writeFileSync(join(out, "SHA256SUMS"), "");
    expect(publishLines(publish(out, fake({}).seams))).toEqual([
      "publish: FAIL published=0 skipped=0 failures=1",
      "  read 0 tarballs",
    ]);
  });

  it("publishes each released package after each package that it needs, peers too", () => {
    // The real manifests of the fixed group. The pack writes workspace:* as the
    // exact version in dependencies, peerDependencies, and optionalDependencies.
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const released = new Set(releasedNames(root));
    const manifests = readWorkspace(root)
      .filter((p) => released.has(p.name))
      .map((p) => p.manifest as unknown as Record<string, unknown>);
    expect(manifests.length).toBe(released.size);
    const tarballs: Tarball[] = manifests.map((m) => ({
      file: `${String(m.name)}.tgz`,
      name: String(m.name),
      version: "0.1.0",
      sha256: "a".repeat(64),
      integrity: "sha512-a",
      dependencies: dependencyNames(m),
    }));
    const plan = publishPlan({
      tarballs,
      sums: new Map(tarballs.map((t) => [t.file, t.sha256])),
      registry: Object.fromEntries(tarballs.map((t) => [t.name, { held: false, latest: null }])),
      npmVersion: "11.19.1",
    });
    expect(plan.failures).toEqual([]);
    const order = plan.publish.map((p) => p.file.replace(/\.tgz$/, ""));
    const at = (name: string) => order.indexOf(name);
    expect(at("@authtempo/compat-better-auth")).toBeGreaterThan(at("@authtempo/client"));
    expect(at("@authtempo/compat-better-auth")).toBeGreaterThan(at("@authtempo/handoff"));
    // Each edge of the group in the three fields, in the order of the plan.
    const late: string[] = [];
    for (const m of manifests)
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"])
        for (const dep of Object.keys((m[field] as Record<string, string> | undefined) ?? {}))
          if (released.has(dep) && at(dep) > at(String(m.name)))
            late.push(`${String(m.name)} before its ${field} entry ${dep}`);
    expect(late).toEqual([]);
  });

  it("reads the graph from dependencies, peerDependencies, and optionalDependencies", () => {
    // No real manifest has an optional entry of the group today, so this row holds the field.
    expect(
      dependencyNames({
        dependencies: { "@authtempo/core": "0.1.0" },
        peerDependencies: { "@authtempo/client": "0.1.0", "@authtempo/core": "0.1.0" },
        optionalDependencies: { "@authtempo/handoff": "0.1.0" },
      }),
    ).toEqual(["@authtempo/core", "@authtempo/client", "@authtempo/handoff"]);
    expect(dependencyNames({ name: "@authtempo/core" })).toEqual([]);
  });

  it("names the public registry at each npm call, over a committed .npmrc", () => {
    // npm reads the project .npmrc of the checkout, where publish.ts runs, and
    // a scope registry there wins over --registry (review of the Task 6 fix, I5).
    // The real npm reads both values from the arguments, not from the .npmrc
    // of the checkout. npm config get sends no request.
    const root = mkdtempSync(join(tmpdir(), "authtempo-publish-npmrc-"));
    folders.push(root);
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "package.json"), '{ "name": "authtempo", "private": true }\n');
    writeFileSync(
      join(checkout, ".npmrc"),
      "registry=http://127.0.0.1:1/\n@authtempo:registry=http://127.0.0.1:1/\n",
    );
    mkdirSync(join(root, "home"));
    writeFileSync(join(root, "user"), "");
    writeFileSync(join(root, "global"), "");
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      NPM_CONFIG_USERCONFIG: join(root, "user"),
      NPM_CONFIG_GLOBALCONFIG: join(root, "global"),
    };
    const get = (key: string, args: readonly string[]) =>
      execFileSync("npm", ["config", "get", key, ...args], {
        cwd: checkout,
        env,
        encoding: "utf8",
      }).trim();
    const keys = ["registry", "@authtempo:registry"];
    expect(keys.map((k) => get(k, []))).toEqual(["http://127.0.0.1:1/", "http://127.0.0.1:1/"]);
    expect(keys.map((k) => get(k, REGISTRY_ARGS))).toEqual([
      "https://registry.npmjs.org/",
      "https://registry.npmjs.org/",
    ]);
    expect(REGISTRY_ARGS).toEqual([
      "--registry=https://registry.npmjs.org/",
      "--@authtempo:registry=https://registry.npmjs.org/",
    ]);
    expect(viewArgs("@authtempo/core@0.1.0", "version")).toEqual([
      "view",
      "@authtempo/core@0.1.0",
      "version",
      "--json",
      "--registry=https://registry.npmjs.org/",
      "--@authtempo:registry=https://registry.npmjs.org/",
    ]);
  });

  it("imports only Node modules and release-facts", () => {
    // The job publish runs no install, so each import must resolve with none.
    const imports = (file: string) =>
      [
        ...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(
          /\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g,
        ),
      ].map((m) => m[1] ?? m[2]);
    expect(imports("../src/publish.ts")).toEqual([
      "node:child_process",
      "node:crypto",
      "node:fs",
      "node:path",
      "node:zlib",
      "./lib/release-facts.ts",
    ]);
    expect(imports("../src/lib/release-facts.ts")).toEqual([]);
  });
});
