import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSecurityPolicy,
  type SupportRow,
  supportTable,
} from "../../../apps/site/scripts/check-security-policy.ts";
import {
  CHANNELS_CLOSED,
  PRE_RELEASE_SENTENCES,
  RESOURCES_EMPTY,
} from "../../../apps/site/src/data/unpublished.ts";
import { groupVersion } from "../src/lib/released.ts";
import {
  checkFailures,
  copyCheck,
  DATES_FILE,
  HAND_EDITS,
  PLAN_FILE,
  planFailures,
  type RehearsalPlan,
  readPlan,
  rehearsalLine,
  rehearse,
  withReleaseDates,
  withSupportTable,
} from "../src/rehearse.ts";
import type { Exec } from "../src/release-check.ts";
import { changesetVersion, RELEASE_COPY_FIXTURE } from "./support/release-copy.ts";

// The rehearsal of the version pull request (ruling 65 of plan 12j, C1 b).
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const PLAN = JSON.parse(read(PLAN_FILE)) as RehearsalPlan;
/** SECURITY.md before the first release: the fixture of the site probes. */
const SECURITY = read("apps/site/test/fixtures/site/pre-release/SECURITY.md");
const REPOSITORY = {
  url: "https://github.com/BirdTempo/authtempo",
  owner: "BirdTempo",
  name: "authtempo",
};
const policy = (text: string, rows: readonly SupportRow[]) =>
  checkSecurityPolicy({ text, rows, repository: REPOSITORY, origin: "https://authtempo.com" })
    .failures;
/** The texts that the owner edits by hand, in PRE_RELEASE_SENTENCES. */
const HAND = PRE_RELEASE_SENTENCES.filter((e) => e.published === null);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the planned values of release/rehearsal.json", () => {
  it("passes the planned values of the tree, and fails each broken part", () => {
    expect(readPlan(ROOT)).toEqual({ plan: PLAN, failures: [] });
    const with_ = (change: Record<string, unknown>) => planFailures({ ...PLAN, ...change });
    expect(with_({ publish: "2026-11-31T15:00:00Z" })).toEqual([
      `${PLAN_FILE}: publish is not a real UTC time YYYY-MM-DDTHH:MM:SSZ`,
    ]);
    const row = PLAN.support[0] as SupportRow;
    expect(with_({ support: [row, row] })).toEqual([
      `${PLAN_FILE}: support has 2 rows with the status current, not 1`,
    ]);
    expect(with_({ support: [{ ...row, schemaFrom: [] }] })).toEqual([
      `${PLAN_FILE}: support row 1 needs minor, status, released, and schemaFrom in the form of release/support.json`,
    ]);
    expect(with_({ resources: [] })).toEqual([`${PLAN_FILE}: resources is not a list of lines`]);
    expect(with_({ dates: {} })).toEqual([
      `${PLAN_FILE} holds the key dates; it holds publish, support, and resources`,
    ]);
    expect(planFailures([])).toEqual([`${PLAN_FILE} is not a JSON object`]);
  });

  it("plans the quotes of the runbook while no release exists", () => {
    // The plan of the first release is what "The first release" of the runbook quotes.
    const runbook = read("docs/release/RUNBOOK.md");
    const part = runbook.slice(runbook.indexOf("\n### The first release\n"));
    const json = /```json\n([\s\S]*?)```/.exec(part)?.[1] ?? "";
    const table = /```text\n(\| Minor \|[\s\S]*?)```/.exec(part)?.[1] ?? "";
    expect(table.trimEnd()).toBe(supportTable(JSON.parse(json) as SupportRow[]));
    if (groupVersion(ROOT) === "0.0.0") {
      expect(PLAN.support).toEqual(JSON.parse(json));
      expect(supportTable(PLAN.support)).toBe(table.trimEnd());
    } else expect(PLAN.support.some((r) => r.status === "current")).toBe(true);
  });

  it("gives a scripted edit to each text by hand, and to no other text", () => {
    expect(Object.keys(HAND_EDITS).sort()).toEqual([...new Set(HAND.map((e) => e.file))].sort());
    // The support table takes the place of the text by hand of SECURITY.md.
    expect(HAND.filter((e) => HAND_EDITS[e.file] === "support").map((e) => e.file)).toEqual([
      "SECURITY.md",
    ]);
  });
});

describe("the scripted edits", () => {
  it("adds one row of RELEASE_DATES for each key, after the rows it holds", () => {
    const empty = read(DATES_FILE).replace(
      /(RELEASE_DATES: Readonly<Record<string, string>> = )\{[^}]*\};/,
      "$1{};",
    );
    const one = withReleaseDates(empty, ["@a/x@0.1.0", "@a/y@0.1.0"], "2026-11-02T15:00:00Z");
    expect(one).toContain(
      'RELEASE_DATES: Readonly<Record<string, string>> = {\n  "@a/x@0.1.0": "2026-11-02T15:00:00Z",\n  "@a/y@0.1.0": "2026-11-02T15:00:00Z",\n};',
    );
    const two = withReleaseDates(one, ["@a/x@0.2.0"], "2027-01-04T15:00:00Z");
    expect(two).toContain(
      '  "@a/y@0.1.0": "2026-11-02T15:00:00Z",\n  "@a/x@0.2.0": "2027-01-04T15:00:00Z",\n};',
    );
    expect(() => withReleaseDates(two, ["@a/x@0.2.0"], "2027-01-04T15:00:00Z")).toThrow(
      "RELEASE_DATES already holds @a/x@0.2.0",
    );
    expect(() => withReleaseDates("export const OTHER = {};", ["@a/x@0.1.0"], "x")).toThrow(
      "has no RELEASE_DATES literal",
    );
  });

  it("writes the support table at the first release and at a later minor", () => {
    const [support] = HAND.filter((e) => HAND_EDITS[e.file] === "support");
    const rows = PLAN.support;
    // The rewrite removes the closed channels; the table takes the place of the text by hand.
    const first = withSupportTable(
      SECURITY.replace(`${CHANNELS_CLOSED}\n\n`, ""),
      rows,
      support?.sentence ?? "",
    );
    expect(policy(first, rows)).toEqual([]);
    // Without the table, the same rows fail.
    expect(policy(SECURITY.replace(`${CHANNELS_CLOSED}\n\n`, ""), rows)).not.toEqual([]);
    const next: SupportRow[] = [
      { minor: "0.2", status: "current", released: "2027-01-04", schemaFrom: [15, 16] },
      { ...(rows[0] as SupportRow), status: "security", securityUntil: "2027-04-04" },
    ];
    const later = withSupportTable(first, next, null);
    expect(policy(later, next)).toEqual([]);
    expect(later).toContain(supportTable(next));
    expect(later).not.toContain("| 0.1 | current |");
    expect(() => withSupportTable(SECURITY, next, null)).toThrow(
      'SECURITY.md has no table in the section "Supported versions"',
    );
    expect(() => withSupportTable(first, rows, support?.sentence ?? "")).toThrow(
      "SECURITY.md does not hold the text by hand once",
    );
  });
});

describe("the failure lines of release-check", () => {
  it("reads the summary, each failure line, and each named vitest failure", () => {
    const out = [
      "authtempo-release:test:  FAIL  test/check-pack.test.ts > check-pack > holds the tree",
      "\u001b[31m@authtempo/site:test:  FAIL  test/a.test.ts > a > b\u001b[39m",
      "@authtempo/site:test: check-pre-release: FAIL listed=14 failures=13",
      "authtempo-release:test:  FAIL  test/check-pack.test.ts > check-pack > holds the tree",
      "release-check: FAIL tasks=134 of 135 cached=0 packages=50 of 51 checks=0 of 10 dry-run=not-run load=1.00 failures=2",
      "  @authtempo/site:test: check-pre-release: FAIL listed=14 failures=13",
      "  authtempo-release:test: Tests 1 failed | 381 passed (382)",
      "  note: uptime 1 days",
    ].join("\n");
    expect(checkFailures(out)).toEqual({
      summary:
        "release-check: FAIL tasks=134 of 135 cached=0 packages=50 of 51 checks=0 of 10 dry-run=not-run load=1.00 failures=2",
      failures: [
        "authtempo-release: FAIL test/check-pack.test.ts > check-pack > holds the tree",
        "@authtempo/site: FAIL test/a.test.ts > a > b",
        "@authtempo/site:test: check-pre-release: FAIL listed=14 failures=13",
        "authtempo-release:test: Tests 1 failed | 381 passed (382)",
      ],
    });
    expect(checkFailures("no summary").summary).toBeNull();
  });
});

/** The files of the site and of the release that the edits read, beside the fixture packages. */
function addSiteFiles(dir: string): void {
  const files: Record<string, string> = {
    [DATES_FILE]: "export const RELEASE_DATES: Readonly<Record<string, string>> = {};\n",
    "release/support.json": "[]\n",
    "SECURITY.md": SECURITY,
  };
  for (const e of HAND.filter((x) => HAND_EDITS[x.file] !== "support"))
    files[e.file] = `# Page\n\nIntro.\n\n${e.sentence}\n\n## Next\n\nMore.\n`;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  mkdirSync(join(dir, "release"), { recursive: true });
  writeFileSync(join(dir, PLAN_FILE), `${JSON.stringify(PLAN)}\n`);
}

const PASS =
  "release-check: PASS tasks=135 of 135 cached=0 packages=51 of 51 checks=9 of 10 dry-run=not-run load=1.00 failures=0\n";

/**
 * A fake of each child process, with the commands that it got. The clone
 * copies the fixture tree, and changeset version writes 0.1.0 as Changesets
 * does. `answer` changes the answer of one command.
 */
function fakeExec(
  source: string,
  answer: (line: string) => { status: number; stdout: string } | undefined = () => undefined,
) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args, cwd) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const own = answer(line);
    if (own !== undefined) return { ...own, stderr: "" };
    if (line.startsWith("git clone")) cpSync(source, args.at(-1) ?? "", { recursive: true });
    if (line === "pnpm changeset version") changesetVersion(cwd, "A fixture change.");
    if (line === "git rev-parse HEAD")
      return { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    if (line.endsWith("rewrite-unpublished.ts"))
      return {
        status: 0,
        stdout:
          "rewrite-unpublished: PASS files=0 notes=0 pages=0 lines=0 texts=0 hand=3 failures=0\n",
        stderr: "",
      };
    if (line.includes("release-check.ts")) return { status: 0, stdout: PASS, stderr: "" };
    if (line === "node scripts/test-servers.mjs down")
      return { status: 0, stdout: "removed the set of slot 3 (authtempo-s3)\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

/** A new parent folder of the copy, and a source tree of the fixture packages at 0.0.0 with the site files. */
function folders(): { tmp: string; source: string } {
  const tmp = mkdtempSync(join(tmpdir(), "authtempo-rehearse-test-"));
  made.push(tmp);
  const source = join(tmp, "source");
  cpSync(RELEASE_COPY_FIXTURE, source, { recursive: true });
  addSiteFiles(source);
  return { tmp, source };
}

describe("rehearse", () => {
  it("runs each step in order in a copy, writes the planned edits, and takes the servers down", async () => {
    const { tmp, source } = folders();
    const { calls, exec } = fakeExec(source);
    const r = await rehearse({ root: source, exec, tmp, keep: true });
    expect(r.failures).toEqual([]);
    expect(rehearsalLine(r)).toBe(
      `release-rehearsal: PASS version=0.1.0 first=yes dates=2 support=1 resources=${PLAN.resources.length} removed=1 release-check=PASS failures=0`,
    );
    const repo = r.dir ?? "";
    const base = "a".repeat(40);
    expect(calls).toEqual([
      "git status --porcelain",
      "git rev-parse HEAD",
      `git clone --quiet --no-checkout ${source} ${repo}`,
      `git checkout --quiet --detach ${base}`,
      "pnpm install --frozen-lockfile --offline",
      "pnpm changeset version",
      "node scripts/release/src/rewrite-unpublished.ts",
      "pnpm format",
      copyCheck(base).join(" "),
      "node scripts/test-servers.mjs down",
    ]);
    // The edits of the runbook, in the copy only.
    const copy = (path: string) => readFileSync(join(repo, path), "utf8");
    expect(copy(DATES_FILE)).toContain('"@authtempo/client@0.1.0": "2026-11-02T15:00:00Z",');
    expect(copy(DATES_FILE)).toContain('"@authtempo/core@0.1.0": "2026-11-02T15:00:00Z",');
    expect(JSON.parse(copy("release/support.json"))).toEqual(PLAN.support);
    expect(copy("SECURITY.md")).toContain(supportTable(PLAN.support));
    const resources = HAND.find((e) => HAND_EDITS[e.file] === "resources");
    expect(copy(resources?.file ?? "")).toContain(PLAN.resources.join("\n"));
    expect(copy(resources?.file ?? "")).not.toContain(RESOURCES_EMPTY);
    const removed = HAND.find((e) => HAND_EDITS[e.file] === "remove");
    expect(copy(removed?.file ?? "")).toBe("# Page\n\nIntro.\n\n## Next\n\nMore.\n");
    // The checkout keeps its files.
    expect(readFileSync(join(source, DATES_FILE), "utf8")).toContain("= {};");
    expect(r.notes).toContain(PASS.trim());
    expect(r.notes).toContain("test-servers down: removed the set of slot 3 (authtempo-s3)");
  });

  it("stops on a dirty checkout with exit 2, and makes no copy", async () => {
    const { tmp, source } = folders();
    const { calls, exec } = fakeExec(source, (line) =>
      line === "git status --porcelain" ? { status: 0, stdout: " M README.md\n" } : undefined,
    );
    const r = await rehearse({ root: source, exec, tmp });
    expect(r.exit).toBe(2);
    expect(r.failures).toEqual([
      "the checkout has changes that the copy of HEAD does not hold: M README.md",
    ]);
    expect(calls).toEqual(["git status --porcelain"]);
    expect(r.dir).toBeNull();
  });

  it("fails with the named failures of release-check, and still takes the servers down", async () => {
    const { tmp, source } = folders();
    const fail = [
      "authtempo-release:test:  FAIL  test/check-pack.test.ts > check-pack > holds the tree",
      "release-check: FAIL tasks=134 of 135 cached=0 packages=50 of 51 checks=0 of 10 dry-run=not-run load=1.00 failures=1",
      "  authtempo-release:test: Tests 1 failed | 381 passed (382)",
    ].join("\n");
    const { calls, exec } = fakeExec(source, (line) =>
      line.includes("release-check.ts") ? { status: 1, stdout: fail } : undefined,
    );
    const r = await rehearse({ root: source, exec, tmp });
    expect(r.exit).toBe(1);
    expect(r.check).toBe("FAIL");
    expect(r.failures).toEqual([
      "release-check exited 1: release-check: FAIL tasks=134 of 135 cached=0 packages=50 of 51 checks=0 of 10 dry-run=not-run load=1.00 failures=1",
      "authtempo-release: FAIL test/check-pack.test.ts > check-pack > holds the tree",
      "authtempo-release:test: Tests 1 failed | 381 passed (382)",
    ]);
    expect(calls.at(-1)).toBe("node scripts/test-servers.mjs down");
    expect(existsSync(r.dir ?? "")).toBe(false);
  });

  it("stops at the first step that fails, and starts no server", async () => {
    const { tmp, source } = folders();
    const { calls, exec } = fakeExec(source, (line) =>
      line.startsWith("pnpm install") ? { status: 1, stdout: "ERR_PNPM_NO_OFFLINE" } : undefined,
    );
    const r = await rehearse({ root: source, exec, tmp });
    expect(r.stopped).toBe("install");
    expect(r.failures).toEqual([
      "install: pnpm install --frozen-lockfile --offline exited 1: ERR_PNPM_NO_OFFLINE",
    ]);
    expect(calls.at(-1)).toBe("pnpm install --frozen-lockfile --offline");
    expect(r.notes).toContain("not run: release-check, after the failed install");
    expect(rehearsalLine(r)).toMatch(
      /^release-rehearsal: FAIL .* release-check=not-run failures=1$/,
    );
  });

  it("reads the plan from the checkout, so a change of the plan alone needs no commit", async () => {
    const { tmp, source } = folders();
    // The owner moves the publish a day, and the support row with it.
    const plan = {
      ...PLAN,
      publish: "2026-11-03T15:00:00Z",
      support: [{ ...(PLAN.support[0] as SupportRow), released: "2026-11-03" }],
    };
    writeFileSync(join(source, PLAN_FILE), `${JSON.stringify(plan)}\n`);
    const { exec } = fakeExec(source, (line) =>
      line === "git status --porcelain" ? { status: 0, stdout: ` M ${PLAN_FILE}\n` } : undefined,
    );
    const r = await rehearse({ root: source, exec, tmp, keep: true });
    expect(r.failures).toEqual([]);
    const copy = (path: string) => readFileSync(join(r.dir ?? "", path), "utf8");
    expect(copy(DATES_FILE)).toContain('"@authtempo/core@0.1.0": "2026-11-03T15:00:00Z",');
    expect(JSON.parse(copy("release/support.json"))).toEqual(plan.support);
  });

  it("fails a new minor whose support row gives another day than the publish", async () => {
    const { tmp, source } = folders();
    // Step 5 of the runbook writes the UTC day of the publish in released.
    const plan = { ...PLAN, publish: "2026-11-03T15:00:00Z" };
    writeFileSync(join(source, PLAN_FILE), `${JSON.stringify(plan)}\n`);
    const { calls, exec } = fakeExec(source);
    const r = await rehearse({ root: source, exec, tmp });
    expect(r.stopped).toBe("edits");
    expect(r.failures).toEqual([
      `edits: the support row of 0.1 in ${PLAN_FILE} gives released 2026-11-02; the day of publish is 2026-11-03`,
    ]);
    expect(calls).not.toContain("pnpm format");
  });

  it("fails a run where changeset version moves no version", async () => {
    const { tmp, source } = folders();
    const { exec } = fakeExec(source, (line) =>
      line === "pnpm changeset version"
        ? { status: 0, stdout: "No unreleased changesets found" }
        : undefined,
    );
    const r = await rehearse({ root: source, exec, tmp });
    expect(r.failures).toEqual([
      "changeset version: the group stays at 0.0.0; no changeset names a released package",
    ]);
  });
});
