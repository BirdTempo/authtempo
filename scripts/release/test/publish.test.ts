import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publish,
  publishLines,
  publishPlan,
  type Seams,
  type Tarball,
  type ViewAnswer,
} from "../src/publish.ts";

const folders: string[] = [];
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

/**
 * The folder that the job publish downloads: one pnpm pack tarball of core and
 * one of client at `version`, and SHA256SUMS in the form of sha256sum (the
 * hash, two spaces, the file name). client depends on core.
 */
function downloaded(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "authtempo-release-publish-"));
  folders.push(root);
  const out = join(root, "out");
  mkdirSync(out);
  // The client comes first in the folder, so the order of the plan comes from the graph.
  const manifests = [
    { name: "@authtempo/client", version, dependencies: { "@authtempo/core": version } },
    { name: "@authtempo/core", version },
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
      ["npm", "publish", join(out, CORE("0.1.0")), "--access", "public", "--tag", "latest"],
      ["npm", "publish", join(out, CLIENT("0.1.0")), "--access", "public", "--tag", "latest"],
    ]);
    expect(publishLines(outcome)).toEqual(["publish: PASS published=2 skipped=0 failures=0"]);
  });

  it("skips a version that the registry holds", () => {
    // A rerun after a partial publish: core 0.1.0 is on the registry.
    const out = downloaded("0.1.0");
    const f = fake({
      view: (spec, field) => {
        if (spec === "@authtempo/core@0.1.0" && field === "version") return { found: "0.1.0" };
        if (spec === "@authtempo/core" && field === "dist-tags.latest") return { found: "0.1.0" };
        return { missing: true };
      },
    });
    const outcome = publish(out, f.seams);
    expect(f.published()).toEqual([CLIENT("0.1.0")]);
    expect(publishLines(outcome)).toEqual([
      "publish: PASS published=1 skipped=1 failures=0",
      "  skipped: @authtempo/core@0.1.0 is on the registry",
    ]);
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
    expect(f.calls.filter((c) => c[1] === "publish").map((c) => c.at(-1))).toEqual([
      "release-0.1",
      "release-0.1",
    ]);
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
    ]);
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
      expect(call.join(" ")).not.toMatch(/token|_auth|registry/i);
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

  it("fails when it reads zero tarballs", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-release-publish-"));
    folders.push(out);
    writeFileSync(join(out, "SHA256SUMS"), "");
    expect(publishLines(publish(out, fake({}).seams))).toEqual([
      "publish: FAIL published=0 skipped=0 failures=1",
      "  read 0 tarballs",
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
