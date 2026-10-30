import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Deprecation, readDeprecations } from "./lib/deprecations.ts";
import { FIRST_RELEASE } from "./lib/release-facts.ts";
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

/** The page that lists each entry (spec 33 item 8). Each entry links its own anchor. */
const DOCS_PAGE = "/docs/reference/deprecations/";

/**
 * The words that mark a deprecated item in the shipped text (spec 33 item 8).
 * The scan reads the whole text, so the words also count over a line break.
 */
const ONE_RELEASE = /for\s+one\s+release/gi;

type Version = readonly [number, number, number];

const parse = (v: string): Version | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const FORM = "<major>.<minor>.<patch>";

/** True when an occurrence of `marker` in `text` holds all of `text` from `start` to `end`. */
function holds(text: string, marker: string, start: number, end: number): boolean {
  for (let at = text.indexOf(marker); at !== -1 && at <= start; at = text.indexOf(marker, at + 1))
    if (at + marker.length >= end) return true;
  return false;
}

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

  // The register is the one list of the items. Words "for one release" in the
  // shipped text are a fourth item until a marker text of their file holds all
  // of them, so the removal of the marker text removes the words too.
  let marked = 0;
  for (const file of input.sources) {
    const text = input.read(file) ?? "";
    const markers = input.entries.flatMap((e) => e.markers.filter((m) => m.file === file));
    const matches = [...text.matchAll(ONE_RELEASE)];
    if (matches.length > 0) marked++;
    for (const match of matches) {
      const start = match.index;
      const end = start + match[0].length;
      if (markers.some((m) => holds(text, m.text, start, end))) continue;
      const line = text.slice(0, start).split("\n").length;
      failures.push(
        `${file}:${line} says for one release, and no marker of the register holds the line`,
      );
    }
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
 * The shipped text of each released package (`releasedNames`): its
 * README.md, each file under src/, and each file of its `files` field but
 * dist. The scan reads src/ for dist, which is built from it. Tests, the
 * docs pages, and a package that is not released are not in a tarball. The
 * site check of the deprecations page holds the docs.
 */
export function sourceFiles(root: string): string[] {
  const out = new Set<string>();
  const add = (path: string) => {
    if (!existsSync(join(root, path))) return;
    if (!statSync(join(root, path)).isDirectory()) {
      out.add(path);
      return;
    }
    for (const d of readdirSync(join(root, path), { withFileTypes: true }))
      if (d.isDirectory() || d.isFile()) add(`${path}/${d.name}`);
  };
  const released = new Set(releasedNames(root));
  for (const p of readWorkspace(root)) {
    if (!released.has(p.name)) continue;
    add(`${p.dir}/README.md`);
    add(`${p.dir}/src`);
    for (const f of p.manifest.files ?? []) {
      // A glob could match nothing, and the scan would miss the file in silence.
      if (!/^[\w.-]+(\/[\w.-]+)*$/.test(f))
        throw new Error(
          `${p.dir}/package.json: the files entry ${f} is not a file or a folder name`,
        );
      if (f !== "dist" && !f.startsWith("dist/")) add(`${p.dir}/${f}`);
    }
  }
  return [...out].sort();
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
