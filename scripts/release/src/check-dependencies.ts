import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { releasedNames } from "./lib/released.ts";
import { type Report, requireCounts, summaryLine } from "./lib/report.ts";
import { readWorkspace, type WorkspacePackage } from "./lib/workspace.ts";

/**
 * One row of release/dependencies.json: one direct dependency of the workspace
 * packages, by name and kind (spec 33 item 9). Spec 13 stays the prose record.
 * A platform row instead gives the license of a platform package of the
 * runtime closure, for each machine where pnpm skips that package.
 */
export interface DependencyRow {
  name: string;
  kind: "runtime" | "peer" | "dev" | "platform";
  /** Each version range that a manifest writes for this name and kind. A new version needs a new read. */
  versions: string[];
  /** Each workspace package that takes it in this kind, by name. A platform row has none. */
  users: string[];
  reason: string;
  /** The date of the last check of its version, license, and install script (YYYY-MM-DD). */
  read: string;
  /** The file that holds each import of a runtime dependency. */
  seam?: string;
  /** The license of a platform package, with its source in the reason. */
  license?: string;
}

/** One package of the runtime closure of the released packages, with its license. */
export interface ClosurePackage {
  name: string;
  version: string;
  license: string;
  /** The first released package whose closure holds it. */
  from: string;
  /** True when the lockfile limits the package to an os, a cpu, or a libc. */
  platform?: true;
  /** True when pnpm skipped the package on this machine: its license comes from its platform row. */
  skipped?: true;
}

export interface DependenciesInput {
  /** Each workspace package and the root package. */
  packages: WorkspacePackage[];
  /** release/dependencies.json as read: the check tests each field. */
  rows: Record<string, unknown>[];
  /** The text of pnpm-workspace.yaml. */
  workspaceYaml: string;
  closure: ClosurePackage[];
  /** release/license-exempt.json as read: each package outside LICENSE_ALLOW that the lead let in. */
  licenseExempt: Record<string, unknown>[];
}

/** The licenses that the runtime closure of a released package may hold (spec 33 item 9). */
export const LICENSE_ALLOW = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD"];

/** The lowest minimumReleaseAge, in minutes: a version younger than one day is the common window for a malicious publish. */
const MINIMUM_RELEASE_AGE = 1440;

const KINDS = ["runtime", "peer", "dev", "platform"] as const;

/** The kind of the row for each dependency key of a manifest. */
const KIND_OF_KEY = {
  dependencies: "runtime",
  optionalDependencies: "runtime",
  peerDependencies: "peer",
  devDependencies: "dev",
} as const;

/** The keys of an importer or a snapshot that an app installs with the package. */
const INSTALLED_KEYS = ["dependencies", "optionalDependencies"] as const;

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The keys of pnpm-workspace.yaml that change what pnpm installs, and that no
 * rule here reads yet. An override can put another package in place of a row,
 * and no row changes. A later plan that needs one of them adds its rule first.
 */
const UNREAD_KEYS = [
  "overrides",
  "packageExtensions",
  "patchedDependencies",
  "catalog",
  "catalogs",
] as const;

const unquoteName = (v: string) => v.trim().replace(/^'(.*)'$|^"(.*)"$/, "$1$2");

/**
 * One top-level key of pnpm-workspace.yaml: the value on its own line, with no
 * comment, and each indented or empty line after it. Undefined when the key is absent.
 */
function topKey(yaml: string, key: string): { inline: string; lines: string[] } | undefined {
  const all = yaml.split("\n");
  const start = all.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return undefined;
  const inline = (all[start] ?? "")
    .slice(key.length + 1)
    .replace(/\s#.*$/, "")
    .trim();
  const lines: string[] = [];
  // A line with no indent starts the next key.
  for (const raw of all.slice(start + 1)) {
    if (/^\S/.test(raw)) break;
    lines.push(raw);
  }
  return { inline, lines };
}

/** The entries of a list key in block form (`- x` lines) or flow form (`[x, y]`). Undefined for another form. */
function listEntries(value: { inline: string; lines: string[] }): string[] | undefined {
  if (value.inline.startsWith("[")) {
    if (!value.inline.endsWith("]")) return undefined;
    const body = value.inline.slice(1, -1).trim();
    return body === "" ? [] : body.split(",").map(unquoteName);
  }
  if (value.inline !== "") return undefined;
  const entries: string[] = [];
  for (const raw of value.lines) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith("- ")) return undefined;
    entries.push(unquoteName(line.slice(2)));
  }
  return entries;
}

/**
 * The rules of pnpm-workspace.yaml: the release age, its exclusions, a reason
 * on each allowBuilds entry, and no key that changes the install unread.
 */
function checkWorkspaceYaml(
  yaml: string,
  rows: readonly Record<string, unknown>[],
  failures: string[],
): number {
  const age = /^minimumReleaseAge:\s*(\S+)\s*(?:#.*)?$/m.exec(yaml);
  if (age === null) failures.push("minimumReleaseAge is gone from pnpm-workspace.yaml");
  else {
    const minutes = Number(age[1]);
    if (!Number.isInteger(minutes) || minutes < MINIMUM_RELEASE_AGE)
      failures.push(`minimumReleaseAge is ${age[1]}, below ${MINIMUM_RELEASE_AGE}`);
  }

  // An exclusion turns the age rule off for its packages, and pnpm 12 can write
  // one itself. Each entry names a row, by name or by name@version, so a reason
  // and a read date stand behind it. A pattern such as "*" names no row.
  const exclude = topKey(yaml, "minimumReleaseAgeExclude");
  if (exclude !== undefined) {
    const entries = listEntries(exclude);
    if (entries === undefined)
      failures.push("minimumReleaseAgeExclude: the value is not a list in block or flow form");
    for (const entry of entries ?? []) {
      const at = entry.lastIndexOf("@");
      const name = at > 0 ? entry.slice(0, at) : entry;
      const version = at > 0 ? entry.slice(at + 1) : undefined;
      const held = rows.some(
        (r) =>
          r.name === name &&
          isText(r.reason) &&
          isDate(r.read) &&
          (version === undefined || (Array.isArray(r.versions) && r.versions.includes(version))),
      );
      if (!held)
        failures.push(`minimumReleaseAgeExclude: ${entry} has no row in release/dependencies.json`);
    }
  }

  if (topKey(yaml, "dangerouslyAllowAllBuilds") !== undefined)
    failures.push(
      "dangerouslyAllowAllBuilds is in pnpm-workspace.yaml: list each build in allowBuilds with a reason",
    );
  for (const key of UNREAD_KEYS)
    if (topKey(yaml, key) !== undefined)
      failures.push(`${key} is in pnpm-workspace.yaml: no rule of check-dependencies reads it yet`);

  // pnpm runs the build script of each package on this list. The reason says what
  // the script does, so a reader can see that the entry is still safe. pnpm reads
  // the block form and the flow form; a flow form on one line has no place for a
  // reason on each entry, so each of its entries fails.
  const builds = topKey(yaml, "allowBuilds");
  if (builds === undefined) return 0;
  let count = 0;
  const entry = (text: string, reason: string) => {
    count += 1;
    const name = unquoteName(text.replace(/:.*$/, ""));
    if (reason.trim() === "") failures.push(`allowBuilds: ${name} has no reason comment`);
  };
  if (/^\{.*\}$/.test(builds.inline)) {
    const body = builds.inline.slice(1, -1).trim();
    for (const text of body === "" ? [] : body.split(",")) entry(text, "");
    return count;
  }
  if (builds.inline !== "" && builds.inline !== "{") {
    failures.push(
      `allowBuilds: the value "${builds.inline}" is not a list of "<name>: <value> # <reason>"`,
    );
    return count;
  }
  for (const raw of builds.lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (builds.inline === "{" && line === "}") break;
    const m = /^('[^']+'|"[^"]+"|[^\s:'"]+):\s*([^\s#,]+)\s*(,?)\s*(?:#(.*))?$/.exec(line);
    if (m === null || (builds.inline === "" && m[3] === ",")) {
      failures.push(`allowBuilds: the line "${line}" is not "<name>: <value> # <reason>"`);
      continue;
    }
    entry(m[1] ?? "", m[4] ?? "");
  }
  return count;
}

/**
 * Each direct dependency of each workspace package has one row, each row holds
 * its facts, and the runtime closure of the released packages holds only the
 * licenses of LICENSE_ALLOW (spec 33 item 9).
 */
export function checkDependencies(input: DependenciesInput): Report {
  const failures: string[] = [];
  const builds = checkWorkspaceYaml(input.workspaceYaml, input.rows, failures);

  // What the manifests take, by name and kind. A workspace reference is owned
  // code; check-packages holds its form.
  const taken = new Map<
    string,
    { name: string; kind: string; users: Set<string>; versions: Set<string> }
  >();
  for (const p of input.packages)
    for (const [key, kind] of Object.entries(KIND_OF_KEY))
      for (const [name, range] of Object.entries(p.manifest[key] ?? {})) {
        if (range.startsWith("workspace:")) continue;
        const id = `${name}\0${kind}`;
        const entry = taken.get(id) ?? { name, kind, users: new Set(), versions: new Set() };
        entry.users.add(p.name);
        entry.versions.add(range);
        taken.set(id, entry);
      }

  const rowUsers = new Map<string, Set<string>>();
  const rowCount = new Map<string, number>();
  const kindCount: Record<string, number> = { runtime: 0, peer: 0, dev: 0, platform: 0 };
  // The license of each platform package by name@version, from a platform row.
  const platformLicense = new Map<string, string>();
  for (const row of input.rows) {
    const name = isText(row.name) ? row.name : "(no name)";
    const kind = row.kind;
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
      failures.push(
        `${name}: the row has the kind ${String(kind)}, not runtime, peer, dev, or platform`,
      );
      continue;
    }
    kindCount[kind] = (kindCount[kind] ?? 0) + 1;
    const id = `${name}\0${kind}`;
    rowCount.set(id, (rowCount.get(id) ?? 0) + 1);

    const users = Array.isArray(row.users) ? row.users.filter(isText) : [];
    if (kind !== "platform" && users.length === 0)
      failures.push(`${name}: the ${kind} row has no user`);
    if (!isText(row.reason)) failures.push(`${name}: the ${kind} row has no reason`);
    if (!isDate(row.read))
      failures.push(`${name}: the ${kind} row has no read date in the form YYYY-MM-DD`);
    if (kind === "runtime" && !isText(row.seam))
      failures.push(`${name}: the runtime row has no seam`);

    // A platform row is the owner of the license of a package that pnpm skips on
    // some machines, so the check gives one result on each machine. No manifest
    // names the package, so the row has no user.
    if (kind === "platform") {
      const listed = Array.isArray(row.versions) ? row.versions.filter(isText) : [];
      if (listed.length === 0) failures.push(`${name}: the platform row lists no version`);
      if (!isText(row.license)) failures.push(`${name}: the platform row has no license`);
      for (const version of listed) {
        if (isText(row.license) && isText(row.reason) && isDate(row.read))
          platformLicense.set(`${name}@${version}`, row.license);
        if (!input.closure.some((c) => c.platform && c.name === name && c.version === version))
          failures.push(
            `${name}@${version}: the platform row matches no platform package of the runtime closure`,
          );
      }
      continue;
    }

    const expected = taken.get(id);
    const versions = Array.isArray(row.versions) ? row.versions.filter(isText).sort() : [];
    const held = [...(expected?.versions ?? [])].sort();
    if (!sameList(versions, held))
      failures.push(
        `${name}: the ${kind} row lists ${versions.join(", ") || "no version"}, and the manifests hold ${held.join(", ") || "no version"}`,
      );
    for (const user of users)
      if (!expected?.users.has(user))
        failures.push(`${name}: the ${kind} row names ${user}, and ${user} does not take it`);
    rowUsers.set(id, new Set([...(rowUsers.get(id) ?? []), ...users]));
  }

  for (const [id, n] of rowCount)
    if (n > 1) failures.push(`${id.split("\0")[0]}: ${n} ${id.split("\0")[1]} rows, not 1`);

  for (const [id, entry] of [...taken].sort(([a], [b]) => a.localeCompare(b)))
    for (const user of [...entry.users].sort())
      if (!rowUsers.get(id)?.has(user))
        failures.push(
          `${entry.name}: ${user} takes it and no row names that user (kind ${entry.kind})`,
        );

  // A skipped package takes the license of its platform row. An installed package
  // keeps the license of its package.json, and a platform row must agree with it.
  let skipped = 0;
  const unread = new Set<string>();
  const closure = input.closure.map((c) => {
    const row = platformLicense.get(`${c.name}@${c.version}`);
    if (c.skipped) {
      skipped += 1;
      if (row === undefined) {
        failures.push(
          `${c.name}@${c.version}: pnpm skipped this platform package on this machine, and no platform row in release/dependencies.json gives its license`,
        );
        unread.add(`${c.name}@${c.version}`);
      }
      return { ...c, license: row ?? "" };
    }
    if (row !== undefined && row !== c.license)
      failures.push(
        `${c.name}@${c.version}: the platform row gives the license ${row}, and the installed package.json gives ${c.license}`,
      );
    return c;
  });

  // An exemption names one package at one version with one license (ruling 15
  // of plan 12j), so another version, another license, or another package fails.
  const exemptions = new Set<string>();
  for (const e of input.licenseExempt) {
    const at = `${String(e.name)}@${String(e.version)}`;
    let ok = true;
    if (!isText(e.reason)) {
      failures.push(`${at}: the license exemption has no reason`);
      ok = false;
    }
    if (!isDate(e.read)) {
      failures.push(`${at}: the license exemption has no read date in the form YYYY-MM-DD`);
      ok = false;
    }
    const match = closure.some(
      (c) => c.name === e.name && c.version === e.version && c.license === e.license,
    );
    if (!match)
      failures.push(
        `${at} (${String(e.license)}): the license exemption matches no package in the runtime closure`,
      );
    if (ok) exemptions.add(`${String(e.name)}\0${String(e.version)}\0${String(e.license)}`);
  }

  let exempt = 0;
  // A skipped package with no platform row has its own failure above.
  for (const c of closure)
    if (unread.has(`${c.name}@${c.version}`)) continue;
    else if (exemptions.has(`${c.name}\0${c.version}\0${c.license}`)) exempt += 1;
    else if (!LICENSE_ALLOW.includes(c.license))
      failures.push(
        `${c.name}@${c.version} has the license ${c.license || "(none)"} in the runtime closure of ${c.from}, outside the allow list`,
      );

  return requireCounts(
    {
      name: "check-dependencies",
      counts: {
        rows: input.rows.length,
        runtime: kindCount.runtime ?? 0,
        peer: kindCount.peer ?? 0,
        dev: kindCount.dev ?? 0,
        platform: kindCount.platform ?? 0,
        packages: input.packages.length,
        closure: input.closure.length,
        skipped,
        exempt,
        builds,
      },
      failures,
      notes: [],
    },
    ["rows", "packages", "closure"],
  );
}

/** One importer or snapshot of pnpm-lock.yaml: each installed key, as dependency name to version. */
type LockEntry = Partial<Record<string, Record<string, string>>>;

const unquote = (v: string) => v.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");

/**
 * The `importers` and `snapshots` sections of the workspace document of a
 * lockfile in the version 9 form, and each key of `packages` with an `os`, a
 * `cpu`, or a `libc` field. pnpm 12 writes the document of its own version
 * first, then `---`, then the workspace document. Each document must say
 * version 9.0, so a new lockfile form stops the check.
 */
function readLockfile(text: string): {
  importers: Map<string, LockEntry>;
  snapshots: Map<string, LockEntry>;
  platforms: Set<string>;
} {
  const docs = text.split(/^---$/m).filter((d) => d.trim() !== "");
  for (const doc of docs) {
    const version = /^lockfileVersion: '?([^'\s]+)'?$/m.exec(doc)?.[1] ?? "(none)";
    if (version !== "9.0") throw new Error(`pnpm-lock.yaml: lockfileVersion ${version} is not 9.0`);
  }
  const doc = docs.at(-1) ?? "";
  const importers = new Map<string, LockEntry>();
  const snapshots = new Map<string, LockEntry>();
  const platforms = new Set<string>();
  let pkg: string | undefined;
  let section = "";
  let entry: LockEntry | undefined;
  let key: string | undefined;
  let dep: string | undefined;
  for (const line of doc.split("\n")) {
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      entry = undefined;
      continue;
    }
    if (section === "packages") {
      const top = /^ {2}(\S.*?):$/.exec(line);
      if (top !== null) pkg = unquote(top[1] ?? "");
      else if (pkg !== undefined && /^ {4}(os|cpu|libc):/.test(line)) platforms.add(pkg);
      continue;
    }
    if (section !== "importers" && section !== "snapshots") continue;
    const top = /^ {2}(\S.*?):( \{\})?$/.exec(line);
    if (top !== null) {
      entry = {};
      (section === "importers" ? importers : snapshots).set(unquote(top[1] ?? ""), entry);
      key = undefined;
      continue;
    }
    const sub = /^ {4}(\w+):/.exec(line);
    if (sub !== null) {
      key = (INSTALLED_KEYS as readonly string[]).includes(sub[1] ?? "") ? sub[1] : undefined;
      if (key !== undefined && entry !== undefined) entry[key] = {};
      continue;
    }
    const target = key === undefined ? undefined : entry?.[key];
    if (target === undefined) continue;
    if (section === "snapshots") {
      const m = /^ {6}('(?:[^']|'')+'|[^\s:']+): (.+)$/.exec(line);
      if (m === null)
        throw new Error(`pnpm-lock.yaml: the snapshot line "${line.trim()}" has another form`);
      target[unquote(m[1] ?? "")] = unquote(m[2] ?? "");
      continue;
    }
    const name = /^ {6}('(?:[^']|'')+'|[^\s:']+):$/.exec(line);
    if (name !== null) {
      dep = unquote(name[1] ?? "");
      continue;
    }
    const version = /^ {8}version: (.+)$/.exec(line);
    if (version !== null && dep !== undefined) target[dep] = unquote(version[1] ?? "");
  }
  return { importers, snapshots, platforms };
}

/** The snapshot key of a dependency: `<name>@<version>`, or the target of an alias. */
const snapshotKey = (name: string, version: string) =>
  /^\d/.test(version) ? `${name}@${version}` : version;

/**
 * The runtime closure of the released packages: each package that an app gets
 * from `dependencies` and `optionalDependencies`, by name and version, with the
 * license that `license` reads. A workspace link to another released package
 * is that package's own closure. `license` gives undefined for a package that
 * is not installed. That is a skipped platform package, or else an error.
 */
export function runtimeClosure(
  lockfileText: string,
  released: readonly { name: string; dir: string }[],
  license: (name: string, version: string) => string | undefined,
): ClosurePackage[] {
  const { importers, snapshots, platforms } = readLockfile(lockfileText);
  const releasedDirs = new Set(released.map((r) => r.dir));
  const found = new Map<string, { name: string; version: string; from: string }>();
  const seen = new Set<string>();

  const visitSnapshot = (key: string, from: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const snapshot = snapshots.get(key);
    if (snapshot === undefined) throw new Error(`pnpm-lock.yaml: no snapshot for ${key}`);
    // The peer suffix "(...)" names the peers that pnpm resolved; the files are the same.
    const base = key.replace(/\(.*$/, "");
    const at = base.lastIndexOf("@");
    if (!found.has(base))
      found.set(base, { name: base.slice(0, at), version: base.slice(at + 1), from });
    for (const k of INSTALLED_KEYS)
      for (const [name, version] of Object.entries(snapshot[k] ?? {}))
        visitSnapshot(snapshotKey(name, version), from);
  };

  const visitImporter = (dir: string, from: string) => {
    if (seen.has(`importer:${dir}`)) return;
    seen.add(`importer:${dir}`);
    const importer = importers.get(dir);
    if (importer === undefined) throw new Error(`pnpm-lock.yaml: no importer ${dir}`);
    for (const k of INSTALLED_KEYS)
      for (const [name, version] of Object.entries(importer[k] ?? {})) {
        if (version.startsWith("link:")) {
          const target = posix.normalize(posix.join(dir, version.slice("link:".length)));
          if (!releasedDirs.has(target)) visitImporter(target, from);
          continue;
        }
        visitSnapshot(snapshotKey(name, version), from);
      }
  };

  for (const r of released) visitImporter(r.dir, r.name);
  return [...found.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((p) => {
      const platform = platforms.has(`${p.name}@${p.version}`);
      const read = license(p.name, p.version);
      if (read === undefined && !platform)
        throw new Error(
          `no package.json for ${p.name}@${p.version} under node_modules/.pnpm: run pnpm install --offline --frozen-lockfile`,
        );
      return {
        name: p.name,
        version: p.version,
        license: read ?? "",
        from: p.from,
        ...(platform ? { platform: true as const } : {}),
        ...(read === undefined ? { skipped: true as const } : {}),
      };
    });
}

/**
 * The license of an installed package, from its package.json in the virtual
 * store of `root`. The folder is `<name with "/" as "+">@<version>`, with a
 * peer suffix after "_" when pnpm resolved a peer. Undefined when the package
 * is not installed.
 */
export function storeLicense(root: string): (name: string, version: string) => string | undefined {
  const store = join(root, "node_modules/.pnpm");
  const folders = existsSync(store) ? readdirSync(store) : [];
  return (name, version) => {
    const folder = `${name.replace("/", "+")}@${version}`;
    const match =
      folders.find((f) => f === folder) ?? folders.find((f) => f.startsWith(`${folder}_`));
    const path =
      match === undefined ? undefined : join(store, match, "node_modules", name, "package.json");
    if (path === undefined || !existsSync(path)) return undefined;
    const value = (JSON.parse(readFileSync(path, "utf8")) as { license?: unknown }).license;
    if (typeof value === "string") return value;
    // An old manifest writes { "type": "<id>" }.
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string"
    )
      return (value as { type: string }).type;
    return "";
  };
}

/** A JSON file that holds a list of objects. */
function readList(root: string, file: string): Record<string, unknown>[] {
  const list = JSON.parse(readFileSync(join(root, file), "utf8")) as unknown;
  if (!Array.isArray(list)) throw new Error(`${file} is not a list`);
  return list as Record<string, unknown>[];
}

/** Reads the input of `checkDependencies` from the repository at `root`. */
export function readInput(root: string): DependenciesInput {
  const workspace = readWorkspace(root);
  const rootManifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as WorkspacePackage["manifest"];
  const packages = [...workspace, { name: rootManifest.name, dir: ".", manifest: rootManifest }];
  const released = releasedNames(root).map((name) => {
    const p = workspace.find((w) => w.name === name);
    if (p === undefined) throw new Error(`the released ${name} is not a workspace package`);
    return { name, dir: p.dir };
  });
  return {
    packages,
    rows: readList(root, "release/dependencies.json"),
    workspaceYaml: readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
    closure: runtimeClosure(
      readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
      released,
      storeLicense(root),
    ),
    licenseExempt: readList(root, "release/license-exempt.json"),
  };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const report = checkDependencies(readInput(root));
  console.log(summaryLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  for (const note of report.notes) console.log(`  note: ${note}`);
  if (report.failures.length > 0) process.exit(1);
}
