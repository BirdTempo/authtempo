import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDeprecations, entry, sourceFiles } from "../src/check-deprecations.ts";
import { type Deprecation, readDeprecations } from "../src/lib/deprecations.ts";
import { summaryLine } from "../src/lib/report.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** Three items in the form of release/deprecations.json, with one or two markers each. */
const ENTRIES: Deprecation[] = [
  {
    id: "authtempo-import",
    what: "The alias binary authtempo-import.",
    since: "0.1.0",
    removeIn: "0.2.0",
    markers: [
      { file: "packages/cli/package.json", text: '"authtempo-import":' },
      { file: "packages/cli/src/commands/import-alias.ts", text: "for one release" },
    ],
    docs: "/docs/reference/deprecations/#authtempo-import",
  },
  {
    id: "tempo-session-read",
    what: "The read of the old session cookie tempo_session.",
    since: "0.1.0",
    removeIn: "0.2.0",
    markers: [
      { file: "packages/core/src/http/router.ts", text: "async function moveLegacyCookie(" },
    ],
    docs: "/docs/reference/deprecations/#tempo-session-read",
  },
  {
    id: "handoff-oauth-reexports",
    what: "The five re-exports of @authtempo/handoff.",
    since: "0.1.0",
    removeIn: "0.2.0",
    markers: [{ file: "packages/handoff/src/pkce.ts", text: "Re-exported for one release" }],
    docs: "/docs/reference/deprecations/#handoff-oauth-reexports",
  },
];

/** The file texts of a tree that still holds each item. */
const LIVE_TREE: Record<string, string> = {
  "packages/cli/package.json":
    '{ "bin": { "authtempo-import": "./dist/bin/authtempo-import.js" } }',
  "packages/cli/src/commands/import-alias.ts":
    "// `authtempo-import`, the old binary, for one release.",
  "packages/core/src/http/router.ts": "async function moveLegacyCookie(config) {}",
  "packages/handoff/src/pkce.ts": "// Re-exported for one release, so no import breaks.",
};

const reader = (tree: Record<string, string>) => (file: string) => tree[file] ?? null;

const run = (
  version: string,
  options: { entries?: Deprecation[]; tree?: Record<string, string>; sources?: string[] } = {},
) =>
  checkDeprecations({
    version,
    entries: options.entries ?? ENTRIES,
    read: reader(options.tree ?? LIVE_TREE),
    sources: options.sources ?? [],
  });

const withEntry = (index: number, change: (e: Deprecation) => void): Deprecation[] =>
  ENTRIES.map((e, i) => {
    const copy = structuredClone(e);
    if (i === index) change(copy);
    return copy;
  });

describe("check-deprecations", () => {
  it("passes live items below removeIn", () => {
    const r = run("0.1.0");
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe("check-deprecations: PASS items=3 live=3 due=0 failures=0");
    expect(summaryLine(run("0.1.7"))).toBe(
      "check-deprecations: PASS items=3 live=3 due=0 failures=0",
    );
  });

  it("fails a marker that is gone below removeIn", () => {
    const tree = { ...LIVE_TREE, "packages/cli/package.json": '{ "bin": { "authtempo": "x" } }' };
    const r = run("0.1.0", { tree });
    expect(r.failures).toEqual([
      'authtempo-import: the marker packages/cli/package.json is gone before 0.2.0 ("authtempo-import":)',
    ]);
    expect(summaryLine(r)).toBe("check-deprecations: FAIL items=3 live=3 due=0 failures=1");
    // A file that is gone is a marker that is gone.
    const { "packages/handoff/src/pkce.ts": _, ...noFile } = LIVE_TREE;
    expect(run("0.1.0", { tree: noFile }).failures).toEqual([
      "handoff-oauth-reexports: the marker packages/handoff/src/pkce.ts is gone before 0.2.0 (Re-exported for one release)",
    ]);
  });

  it("fails a marker that is present at or above removeIn", () => {
    const tree = {
      "packages/cli/package.json": '{ "bin": { "authtempo-import": "./dist/x.js" } }',
    };
    const r = run("0.2.0", { tree });
    expect(r.failures).toEqual([
      'authtempo-import is due for removal in 0.2.0: the marker packages/cli/package.json is present ("authtempo-import":)',
    ]);
    expect(summaryLine(r)).toBe("check-deprecations: FAIL items=3 live=0 due=3 failures=1");
    // Each marker gone at 0.2.0 and later: each item is removed.
    expect(summaryLine(run("0.2.0", { tree: {} }))).toBe(
      "check-deprecations: PASS items=3 live=0 due=3 failures=0",
    );
    expect(run("0.3.1", { tree: LIVE_TREE }).failures).toHaveLength(4);
  });

  it("treats 0.0.0 as before the first release", () => {
    const r = run("0.0.0");
    expect(summaryLine(r)).toBe("check-deprecations: PASS items=3 live=3 due=0 failures=0");
    expect(run("0.0.0", { tree: {} }).failures).toHaveLength(4);
    // No release carries 0.0.0, so an item cannot be deprecated since it.
    const zero = withEntry(0, (e) => {
      e.since = "0.0.0";
      e.removeIn = "0.1.0";
    });
    expect(run("0.0.0", { entries: zero }).failures).toEqual([
      "authtempo-import: since is 0.0.0, which no release carries; the first release is 0.1.0",
    ]);
  });

  it("refuses a removeIn that is not the minor after since", () => {
    const late = withEntry(1, (e) => {
      e.removeIn = "0.3.0";
    });
    expect(run("0.1.0", { entries: late }).failures).toEqual([
      "tempo-session-read: removeIn is 0.3.0, not 0.2.0, the minor after since 0.1.0",
    ]);
    const patch = withEntry(1, (e) => {
      e.since = "0.1.4";
      e.removeIn = "0.2.1";
    });
    expect(run("0.1.4", { entries: patch }).failures).toEqual([
      "tempo-session-read: removeIn is 0.2.1, not 0.2.0, the minor after since 0.1.4",
    ]);
    // A deprecation that starts in a patch is removed at the next minor too.
    const fromPatch = withEntry(1, (e) => {
      e.since = "0.1.4";
    });
    expect(run("0.1.4", { entries: fromPatch }).failures).toEqual([]);
  });

  it("fails when it reads zero entries", () => {
    const r = run("0.1.0", { entries: [] });
    expect(r.failures).toEqual(["read 0 items"]);
    expect(summaryLine(r)).toBe("check-deprecations: FAIL items=0 live=0 due=0 failures=1");
  });

  it("refuses a version that is not <major>.<minor>.<patch>", () => {
    expect(run("0.1").failures).toEqual(["the group version 0.1 is not <major>.<minor>.<patch>"]);
    const bad = withEntry(2, (e) => {
      e.since = "0.1.0-rc.1";
    });
    expect(run("0.1.0", { entries: bad }).failures).toEqual([
      "handoff-oauth-reexports: since 0.1.0-rc.1 is not <major>.<minor>.<patch>",
    ]);
    const short = withEntry(2, (e) => {
      e.removeIn = "0.2";
    });
    expect(run("0.1.0", { entries: short }).failures).toEqual([
      "handoff-oauth-reexports: removeIn 0.2 is not <major>.<minor>.<patch>",
    ]);
  });

  it("refuses an entry with no marker or a marker with an empty text", () => {
    const none = withEntry(1, (e) => {
      e.markers = [];
    });
    expect(run("0.1.0", { entries: none }).failures).toEqual(["tempo-session-read has no marker"]);
    // Every text holds the empty text, so that marker could never be gone.
    const empty = withEntry(1, (e) => {
      e.markers = [{ file: "packages/core/src/http/router.ts", text: "  " }];
    });
    expect(run("0.1.0", { entries: empty }).failures).toEqual([
      "tempo-session-read: the marker packages/core/src/http/router.ts has an empty text",
    ]);
  });

  it("refuses a second entry with one id, and a docs link that is not the id's anchor", () => {
    const twice = [...ENTRIES, structuredClone(ENTRIES[0] as Deprecation)];
    expect(run("0.1.0", { entries: twice }).failures).toEqual([
      "authtempo-import is the id of 2 entries",
    ]);
    const docs = withEntry(2, (e) => {
      e.docs = "/docs/reference/deprecations/";
    });
    expect(run("0.1.0", { entries: docs }).failures).toEqual([
      "handoff-oauth-reexports: docs is /docs/reference/deprecations/, not /docs/reference/deprecations/#handoff-oauth-reexports",
    ]);
  });

  it("fails a line with 'for one release' that no marker of its file holds", () => {
    const tree = {
      ...LIVE_TREE,
      "packages/next/src/index.ts":
        "// The old name counts too, For One Release, as core reads it.",
      "packages/next/README.md": "No such line here.",
    };
    const sources = [
      "packages/next/src/index.ts",
      "packages/next/README.md",
      ...Object.keys(LIVE_TREE),
    ];
    expect(run("0.1.0", { tree, sources }).failures).toEqual([
      "packages/next/src/index.ts:1 says for one release, and no marker of the register holds the line",
    ]);
    // The line of import-alias.ts holds its marker text, so the register names it.
    expect(run("0.1.0", { sources: Object.keys(LIVE_TREE) }).failures).toEqual([]);
    expect(run("0.1.0", { sources: Object.keys(LIVE_TREE) }).notes).toEqual([
      "4 shipped files, 2 with for one release",
    ]);
  });

  it("reads the real register", () => {
    const entries = readDeprecations(repo);
    expect(entries.map((e) => e.id)).toEqual([
      "authtempo-import",
      "tempo-session-read",
      "handoff-oauth-reexports",
    ]);
    for (const e of entries) {
      expect(e.since, e.id).toBe("0.1.0");
      expect(e.removeIn, e.id).toBe("0.2.0");
    }
    const { lines, code } = entry(repo, undefined);
    expect(lines[0]).toBe("check-deprecations: PASS items=3 live=3 due=0 failures=0");
    expect(code).toBe(0);
    // The scan reads the shipped source and each README of packages/.
    const files = sourceFiles(repo);
    expect(files).toContain("packages/core/src/http/cookies.ts");
    expect(files).toContain("packages/handoff/README.md");
    expect(files.some((f) => f.includes("/test/") || f.includes("/dist/"))).toBe(false);
  });

  it("keeps the Expo storage key and the cookie constant out of the markers", () => {
    // Ruling 22: the Expo storage key of the compat client reads the constant.
    // A new key signs every Expo user out (plan 12b), so the key stays after 0.2.0.
    const markers = readDeprecations(repo).flatMap((e) => e.markers);
    const client = "packages/compat-better-auth/src/client/create-auth-client.ts";
    expect(markers.filter((m) => m.file === client)).toEqual([]);
    expect(readFileSync(join(repo, client), "utf8")).toContain(`_\${LEGACY_SESSION_COOKIE}`);
    // The removal of each marker text of cookies.ts keeps the constant line.
    const cookies = "packages/core/src/http/cookies.ts";
    let text = readFileSync(join(repo, cookies), "utf8");
    for (const m of markers) if (m.file === cookies) text = text.split(m.text).join("");
    expect(text).toContain('export const LEGACY_SESSION_COOKIE = "tempo_session";');
  });

  it("refuses a register that is not a list of entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "authtempo-deprecations-"));
    try {
      const write = (text: string) => {
        rmSync(join(dir, "release"), { recursive: true, force: true });
        mkdirSync(join(dir, "release"), { recursive: true });
        writeFileSync(join(dir, "release/deprecations.json"), text);
      };
      write("{}");
      expect(() => readDeprecations(dir)).toThrow(
        "release/deprecations.json: the register is not a list",
      );
      write(JSON.stringify([{ ...ENTRIES[0], markers: [{ file: "a" }] }]));
      expect(() => readDeprecations(dir)).toThrow(
        "release/deprecations.json: entry 0 is not { id, what, since, removeIn, markers: { file, text }[], docs }",
      );
      write(JSON.stringify([{ ...ENTRIES[0], what: "" }]));
      expect(() => readDeprecations(dir)).toThrow("entry 0 is not");
      // The entry prints its summary line also when it cannot read the register.
      const { lines, code } = entry(dir, "0.1.0");
      expect(lines[0]).toBe("check-deprecations: FAIL items=0 live=0 due=0 failures=1");
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
