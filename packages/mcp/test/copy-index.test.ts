import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PKG } from "./support/bin.js";
import { SITE_INDEX, siteIndex } from "./support/index.js";

const SCRIPT = join(PKG, "scripts/copy-index.mjs");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A source index, a content tree with one page, and a target path, in a new folder. */
function setup(o: { source: boolean; sourceAge: number; pageAge: number }) {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-copy-index-"));
  made.push(dir);
  const source = join(dir, "site/index.json");
  const content = join(dir, "content");
  const target = join(dir, "out/agent/index.json");
  mkdirSync(join(dir, "site"));
  mkdirSync(content);
  const now = Date.now() / 1000;
  writeFileSync(join(content, "page.md"), "# A page\n");
  utimesSync(join(content, "page.md"), now - o.pageAge, now - o.pageAge);
  if (o.source) {
    copyFileSync(SITE_INDEX, source);
    utimesSync(source, now - o.sourceAge, now - o.sourceAge);
  }
  return { source, content, target };
}

function run(p: { source: string; content: string; target: string }) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--source", p.source, "--content", p.content, "--target", p.target],
    { encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("copy-index", () => {
  it("copies a fresh index and prints its page count", () => {
    const p = setup({ source: true, sourceAge: 10, pageAge: 100 });
    const r = run(p);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`copy-index: PASS pages=${siteIndex().pages.length}\n`);
    expect(r.status).toBe(0);
    expect(readFileSync(p.target, "utf8")).toBe(readFileSync(SITE_INDEX, "utf8"));
  });

  it("refuses an index that is older than a page source, and copies nothing", () => {
    const p = setup({ source: true, sourceAge: 100, pageAge: 10 });
    const r = run(p);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("is older than a page source");
    expect(r.stderr).toContain("run pnpm turbo run build --filter=@authtempo/site");
    expect(() => readFileSync(p.target)).toThrow();
  });

  it("refuses a missing index", () => {
    const p = setup({ source: false, sourceAge: 0, pageAge: 10 });
    const r = run(p);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("is missing");
  });
});
