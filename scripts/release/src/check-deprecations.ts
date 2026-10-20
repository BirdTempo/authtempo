import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Deprecation, readDeprecations } from "./lib/deprecations.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, reportLines, requireCounts, unreadReport } from "./lib/report.ts";
import { readWorkspace } from "./lib/workspace.ts";

export interface DeprecationsInput {
  /** The group version: the version of every released package. */
  version: string;
  entries: Deprecation[];
  /** The text of a file of the tree, or null when it is absent. */
  read: (file: string) => string | null;
  /** The shipped files to scan for the words "for one release" (`sourceFiles`). */
  sources: string[];
}

const COUNT_KEYS = ["items", "live", "due"] as const;

/** The first version that a release carries (spec 33 item 1.2). */
const FIRST_RELEASE = "0.1.0";

/** The page that lists each entry (spec 33 item 8). Each entry links its own anchor. */
const DOCS_PAGE = "/docs/reference/deprecations/";

/** The words that mark a deprecated item in the shipped text (spec 33 item 8). */
const ONE_RELEASE = /for one release/i;

type Version = readonly [number, number, number];

const parse = (v: string): Version | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const FORM = "<major>.<minor>.<patch>";

/**
 * Holds each item of the register to its markers (spec 33 item 8). Below
 * `removeIn` the item is live, and each marker must be in the tree. At or
 * above `removeIn` the item is due, and each marker must be gone. At 0.0.0,
 * before the first release, every item is live. `removeIn` is the minor
 * after `since`: "for one release" means one minor.
 */
export function checkDeprecations(input: DeprecationsInput): Report {
  const failures: string[] = [];
  const counts = { items: input.entries.length, live: 0, due: 0 };
  const version = parse(input.version);
  if (version === null) failures.push(`the group version ${input.version} is not ${FORM}`);

  const ids = new Map<string, number>();
  for (const e of input.entries) ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) failures.push(`${id} is the id of ${n} entries`);

  for (const e of input.entries) {
    const since = parse(e.since);
    const removeIn = parse(e.removeIn);
    if (since === null) failures.push(`${e.id}: since ${e.since} is not ${FORM}`);
    if (removeIn === null) failures.push(`${e.id}: removeIn ${e.removeIn} is not ${FORM}`);
    if (since !== null) {
      if (compare(since, [0, 0, 0]) === 0)
        failures.push(
          `${e.id}: since is 0.0.0, which no release carries; the first release is ${FIRST_RELEASE}`,
        );
      const next = `${since[0]}.${since[1] + 1}.0`;
      if (removeIn !== null && e.removeIn !== next)
        failures.push(
          `${e.id}: removeIn is ${e.removeIn}, not ${next}, the minor after since ${e.since}`,
        );
    }
    const anchor = `${DOCS_PAGE}#${e.id}`;
    if (e.docs !== anchor) failures.push(`${e.id}: docs is ${e.docs}, not ${anchor}`);
    if (e.markers.length === 0) failures.push(`${e.id} has no marker`);

    if (version === null || removeIn === null) continue;
    const live = compare(version, removeIn) < 0;
    if (live) counts.live++;
    else counts.due++;
    for (const m of e.markers) {
      if (m.text.trim() === "") {
        failures.push(`${e.id}: the marker ${m.file} has an empty text`);
        continue;
      }
      const present = input.read(m.file)?.includes(m.text) ?? false;
      if (live && !present)
        failures.push(`${e.id}: the marker ${m.file} is gone before ${e.removeIn} (${m.text})`);
      if (!live && present)
        failures.push(
          `${e.id} is due for removal in ${e.removeIn}: the marker ${m.file} is present (${m.text})`,
        );
    }
  }

  // The register is the one list of the items. A line of the shipped text that
  // says "for one release" is a fourth item until a marker holds it.
  let marked = 0;
  for (const file of input.sources) {
    const lines = (input.read(file) ?? "").split("\n");
    if (lines.some((l) => ONE_RELEASE.test(l))) marked++;
    lines.forEach((line, i) => {
      if (!ONE_RELEASE.test(line)) return;
      const held = input.entries.some((e) =>
        e.markers.some((m) => m.file === file && m.text.trim() !== "" && line.includes(m.text)),
      );
      if (!held)
        failures.push(
          `${file}:${i + 1} says for one release, and no marker of the register holds the line`,
        );
    });
  }

  return requireCounts(
    {
      name: "check-deprecations",
      counts,
      failures,
      notes: [`${input.sources.length} shipped files, ${marked} with for one release`],
    },
    ["items"],
  );
}

/**
 * The shipped text of the packages: each file under `packages/<name>/src/`
 * and each `packages/<name>/README.md`. Tests and the docs pages are not in
 * a tarball; the site check of the deprecations page holds the docs.
 */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${d.name}`;
      if (d.isDirectory()) walk(path);
      else if (d.isFile()) out.push(path);
    }
  };
  for (const name of readdirSync(join(root, "packages")).sort()) {
    const dir = `packages/${name}`;
    if (!statSync(join(root, dir)).isDirectory()) continue;
    if (existsSync(join(root, dir, "src"))) walk(`${dir}/src`);
    if (existsSync(join(root, dir, "README.md"))) out.push(`${dir}/README.md`);
  }
  return out.sort();
}

/** The version of the first released package. check-packages holds the group to one version. */
function groupVersion(root: string): string {
  const [first] = releasedNames(root);
  const p = readWorkspace(root).find((w) => w.name === first);
  if (p === undefined) throw new Error(`${first} is released and is not a workspace package`);
  return p.manifest.version;
}

/** Runs the check on the tree at `root`, at `version` or else the group version. */
export function entry(
  root: string,
  version: string | undefined,
): { lines: string[]; code: number } {
  let report: Report;
  try {
    const entries = readDeprecations(root);
    report = checkDeprecations({
      version: version ?? groupVersion(root),
      entries,
      read: (file) => {
        const path = join(root, file);
        return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : null;
      },
      sources: sourceFiles(root),
    });
  } catch (error) {
    report = unreadReport(
      "check-deprecations",
      COUNT_KEYS,
      error instanceof Error ? error.message : String(error),
    );
  }
  return { lines: reportLines(report), code: report.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  const { lines, code } = entry(
    fileURLToPath(new URL("../../../", import.meta.url)),
    process.argv[2],
  );
  for (const line of lines) console.log(line);
  process.exit(code);
}
