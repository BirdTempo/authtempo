import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkWorkflows, entry, readYaml } from "../src/check-workflows.ts";
import { NODE_FLOOR, NPM_FLOOR } from "../src/lib/release-facts.ts";
import { summaryLine } from "../src/lib/report.ts";

// Each case reads the real workflow files and changes one part, so a copy of
// the files cannot drift from them.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const real = (name: string) => readFileSync(`${root}.github/workflows/${name}`, "utf8");
const CI = real("ci.yml");
const RELEASE = real("release.yml");

/** Replaces the one place of `from` in `text`. A change that does not apply throws. */
function swap(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at === -1 || text.indexOf(from, at + 1) !== -1)
    throw new Error(`the text holds ${from} not exactly once`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

const check = (ci: string, release: string) =>
  checkWorkflows({
    files: [
      { name: "ci.yml", text: ci },
      { name: "release.yml", text: release },
    ],
  });
const ciFailures = (ci: string) => check(ci, RELEASE).failures;
const releaseFailures = (release: string) => check(CI, release).failures;

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
/** The checkout of the job check, with its first with key. It is in each file once. */
const HISTORY = "\n        with:\n          fetch-depth: 0";
const PUBLISH_PERMISSIONS = "    permissions:\n      id-token: write\n      contents: read\n";

describe("check-workflows", () => {
  it("passes the real files", () => {
    const r = check(CI, RELEASE);
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe("check-workflows: PASS files=2 uses=10 pinned=10 failures=0");
  });

  it("holds each pin to the read of 2026-10-20", () => {
    // git ls-remote of each action repository on 2026-10-20 22:54 CST. A new
    // pin changes this list together with the read date.
    const pins = [...`${CI}${RELEASE}`.matchAll(/uses: (\S+ # \S+)/g)].map((m) => m[1]);
    expect([...new Set(pins)].sort()).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2",
      "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
      "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
      "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0",
    ]);
  });

  it("holds the floors of npm and Node", () => {
    // npm trusted publishing needs npm 11.5.1. Node strips types by default
    // from 22.18.0, and the release scripts and the pack proofs are .ts files.
    expect(NPM_FLOOR).toBe("11.5.1");
    expect(NODE_FLOOR).toBe("22.18.0");
  });

  it("fails a uses with a tag or a branch", () => {
    expect(
      releaseFailures(swap(RELEASE, CHECKOUT + HISTORY, `actions/checkout@v5${HISTORY}`)),
    ).toContain(
      "release.yml: jobs.check step 1: actions/checkout@v5 is not pinned to a 40-character commit SHA",
    );
    expect(ciFailures(swap(CI, CHECKOUT, "actions/checkout@main # v7.0.1"))).toContain(
      "ci.yml: jobs.check step 1: actions/checkout@main is not pinned to a 40-character commit SHA",
    );
    expect(
      check(CI, swap(RELEASE, CHECKOUT + HISTORY, `actions/checkout@v5${HISTORY}`)).counts,
    ).toEqual({
      files: 2,
      uses: 10,
      pinned: 9,
    });
  });

  it("fails a pin with no version comment", () => {
    const bare = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
    expect(releaseFailures(swap(RELEASE, CHECKOUT + HISTORY, bare + HISTORY))).toEqual([
      `release.yml: jobs.check step 1: ${bare} has no version comment # v<major>.<minor>.<patch>`,
    ]);
    expect(releaseFailures(swap(RELEASE, CHECKOUT + HISTORY, `${bare} # v7${HISTORY}`))).toEqual([
      `release.yml: jobs.check step 1: ${bare} has no version comment # v<major>.<minor>.<patch>`,
    ]);
  });

  it("fails top-level permissions that are not {}", () => {
    expect(
      releaseFailures(swap(RELEASE, "permissions: {}\n", "permissions:\n  contents: read\n")),
    ).toEqual(["release.yml: the top-level permissions are not {}"]);
    expect(releaseFailures(swap(RELEASE, "permissions: {}\n", ""))).toEqual([
      "release.yml: the top-level permissions are not {}",
    ]);
    // In ci.yml anything other than contents: read fails.
    expect(ciFailures(swap(CI, "  contents: read\n", "  contents: write\n"))).toEqual([
      "ci.yml: the top-level permissions are not { contents: read }",
    ]);
    expect(
      ciFailures(swap(CI, "  contents: read\n", "  contents: read\n  pull-requests: write\n")),
    ).toEqual(["ci.yml: the top-level permissions are not { contents: read }"]);
    expect(
      ciFailures(swap(CI, "permissions:\n  contents: read\n", "permissions: write-all\n")),
    ).toEqual(["ci.yml: the top-level permissions are not { contents: read }"]);
  });

  it("fails id-token: write at the top level, or in any job but publish", () => {
    expect(
      releaseFailures(swap(RELEASE, "permissions: {}\n", "permissions:\n  id-token: write\n")),
    ).toEqual([
      "release.yml: the top-level permissions are not {}",
      "release.yml: id-token: write at the top level; only jobs.publish may mint a token",
    ]);
    expect(
      releaseFailures(
        swap(
          RELEASE,
          "    permissions:\n      contents: read\n",
          "    permissions:\n      contents: read\n      id-token: write\n",
        ),
      ),
    ).toEqual(["release.yml: jobs.check: id-token: write; only jobs.publish may mint a token"]);
    expect(
      ciFailures(swap(CI, "    runs-on:", "    permissions:\n      id-token: write\n    runs-on:")),
    ).toEqual(["ci.yml: jobs.check: id-token: write; only jobs.publish may mint a token"]);
  });

  it("fails a job permission that writes", () => {
    expect(
      releaseFailures(
        swap(
          RELEASE,
          "    permissions:\n      contents: read\n",
          "    permissions:\n      contents: write\n",
        ),
      ),
    ).toEqual(["release.yml: jobs.check: the permission contents: write; a job here only reads"]);
  });

  it("fails a publish job with no environment release, or with another permission than id-token: write and contents: read", () => {
    expect(releaseFailures(swap(RELEASE, "    environment: release\n", ""))).toEqual([
      "release.yml: jobs.publish: the environment is not release",
    ]);
    expect(
      releaseFailures(swap(RELEASE, "    environment: release\n", "    environment: production\n")),
    ).toEqual(["release.yml: jobs.publish: the environment is not release"]);
    expect(
      releaseFailures(
        swap(RELEASE, PUBLISH_PERMISSIONS, `${PUBLISH_PERMISSIONS}      packages: write\n`),
      ),
    ).toEqual([
      "release.yml: jobs.publish: the permissions are not { id-token: write, contents: read }",
    ]);
    expect(
      releaseFailures(
        swap(RELEASE, PUBLISH_PERMISSIONS, "    permissions:\n      id-token: write\n"),
      ),
    ).toEqual([
      "release.yml: jobs.publish: the permissions are not { id-token: write, contents: read }",
    ]);
    expect(releaseFailures(swap(RELEASE, "    needs: check\n", ""))).toEqual([
      "release.yml: jobs.publish: needs is not check",
    ]);
  });

  it("fails another trigger", () => {
    expect(
      releaseFailures(swap(RELEASE, '    tags: ["v*"]\n', '    branches: ["main"]\n')),
    ).toEqual(['release.yml: on is not { push: { tags: ["v*"] } }']);
    expect(releaseFailures(swap(RELEASE, "on:\n", "on:\n  workflow_dispatch:\n"))).toEqual([
      'release.yml: on is not { push: { tags: ["v*"] } }',
    ]);
    expect(releaseFailures(swap(RELEASE, "on:\n", "on:\n  workflow_run:\n"))).toEqual([
      "release.yml: the trigger workflow_run runs with the secrets of the repository",
      'release.yml: on is not { push: { tags: ["v*"] } }',
    ]);
    expect(ciFailures(swap(CI, "  pull_request:\n", "  pull_request_target:\n"))).toEqual([
      "ci.yml: the trigger pull_request_target runs with the secrets of the repository",
      'ci.yml: on is not { pull_request, push: { branches: ["main"] } }',
    ]);
    expect(ciFailures(swap(CI, '    branches: ["main"]\n', '    branches: ["*"]\n'))).toEqual([
      'ci.yml: on is not { pull_request, push: { branches: ["main"] } }',
    ]);
  });

  it("fails an event expression in a run line", () => {
    expect(
      ciFailures(
        swap(
          CI,
          "      - run: docker compose up -d --wait\n",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template.
          "      - run: echo ${{ github.event.head_commit.message }}\n      - run: docker compose up -d --wait\n",
        ),
      ),
    ).toContain(
      "ci.yml: jobs.check step 4: an expression in a run line; pass the value through env",
    );
  });

  it("fails a self-hosted runner", () => {
    expect(ciFailures(swap(CI, "runs-on: ubuntu-24.04", "runs-on: self-hosted"))).toEqual([
      "ci.yml: jobs.check: runs-on self-hosted is not an ubuntu-<version> runner of GitHub",
    ]);
    expect(ciFailures(swap(CI, "runs-on: ubuntu-24.04", "runs-on: [self-hosted, linux]"))).toEqual([
      "ci.yml: jobs.check: runs-on is not one label",
    ]);
  });

  it("fails a publish step that is not node scripts/release/src/publish.ts", () => {
    const step = "      - run: node scripts/release/src/publish.ts out\n";
    expect(releaseFailures(swap(RELEASE, step, "      - run: npm publish out/*.tgz\n"))).toEqual([
      "release.yml: jobs.publish step 4: a publish command outside node scripts/release/src/publish.ts",
      "release.yml: jobs.publish: step 4 is not node scripts/release/src/publish.ts out",
    ]);
    // The publish job runs no install, so no other code runs beside the token.
    expect(
      releaseFailures(swap(RELEASE, step, `      - run: pnpm install --frozen-lockfile\n${step}`)),
    ).toEqual(["release.yml: jobs.publish: 5 steps, not the 4 steps of the rule"]);
  });

  it("fails a publish command or a token outside the publish step", () => {
    expect(
      ciFailures(
        swap(
          CI,
          "      - run: pnpm install --frozen-lockfile\n",
          "      - run: pnpm install --frozen-lockfile && pnpm publish -r\n",
        ),
      ),
    ).toEqual([
      "ci.yml: jobs.check step 5: a publish command outside node scripts/release/src/publish.ts",
      "ci.yml: jobs.check: step 5 is not pnpm install --frozen-lockfile",
    ]);
    expect(
      releaseFailures(
        swap(
          RELEASE,
          "    environment: release\n",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template.
          "    environment: release\n    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM }}\n",
        ),
      ),
    ).toEqual(["release.yml: line 108: a token or a secret; trusted publishing uses no token"]);
  });

  it("fails a removed, an added, or a moved step", () => {
    const tag =
      '      - name: Check the tag\n        run: node scripts/release/src/check-tag.ts "$GITHUB_REF_NAME"\n';
    expect(releaseFailures(swap(RELEASE, tag, ""))).toContain(
      "release.yml: jobs.check: 14 steps, not the 15 steps of the rule",
    );
    expect(ciFailures(swap(CI, "\n  check:\n", "\n  test:\n"))).toContain(
      "ci.yml: the jobs are not check",
    );
    const docker = "      - run: docker compose up -d --wait\n";
    expect(ciFailures(swap(CI, docker, ""))).toEqual([
      "ci.yml: jobs.check: 5 steps, not the 6 steps of the rule",
    ]);
    expect(ciFailures(swap(CI, docker, `${docker}      - run: echo extra\n`))).toEqual([
      "ci.yml: jobs.check: 7 steps, not the 6 steps of the rule",
    ]);
    const install = "      - run: pnpm install --frozen-lockfile\n";
    expect(ciFailures(swap(swap(CI, install, ""), docker, `${install}${docker}`))).toEqual([
      "ci.yml: jobs.check: step 4 is not docker compose up -d --wait",
      "ci.yml: jobs.check: step 5 is not pnpm install --frozen-lockfile",
    ]);
    // prepare runs in the release copy, and the tag check runs in the checkout.
    const prepare =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template.
      "        run: node scripts/release/src/prepare.ts\n        working-directory: ${{ runner.temp }}/release-copy\n";
    expect(
      releaseFailures(swap(RELEASE, prepare, "        run: node scripts/release/src/prepare.ts\n")),
    ).toEqual(["release.yml: jobs.check: step 10 is not in the release copy"]);
    expect(
      releaseFailures(
        swap(RELEASE, tag, `${tag}        working-directory: \${{ runner.temp }}/release-copy\n`),
      ),
    ).toEqual(["release.yml: jobs.check: step 4 has a working-directory, and it must have none"]);
  });

  it("fails a setup that changes", () => {
    expect(ciFailures(swap(CI, 'node-version: "26.10.0"', 'node-version: "22.17.0"'))).toEqual([
      "ci.yml: jobs.check step 3: node-version 22.17.0 is not a full version at or above 22.18.0",
    ]);
    expect(ciFailures(swap(CI, 'node-version: "26.10.0"', 'node-version: "26"'))).toEqual([
      "ci.yml: jobs.check step 3: node-version 26 is not a full version at or above 22.18.0",
    ]);
    expect(
      ciFailures(swap(CI, "package-manager-cache: false", "package-manager-cache: true")),
    ).toEqual(["ci.yml: jobs.check step 3: the setup-node cache is on; a cache is never evidence"]);
    expect(ciFailures(swap(CI, "persist-credentials: false", "persist-credentials: true"))).toEqual(
      ["ci.yml: jobs.check step 1: the checkout keeps its token in the git config"],
    );
    expect(ciFailures(swap(CI, "fetch-depth: 0", "fetch-depth: 1"))).toEqual([
      "ci.yml: jobs.check step 1: the checkout has no full history (fetch-depth: 0)",
    ]);
    const pnpm = "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n";
    expect(ciFailures(swap(CI, pnpm, `${pnpm}        with:\n          version: 12.8.1\n`))).toEqual(
      [
        "ci.yml: jobs.check step 2: pnpm/action-setup names a version; the packageManager field of package.json is the one source",
      ],
    );
    expect(
      releaseFailures(
        swap(
          RELEASE,
          "          name: tarballs\n          path: out\n",
          "          name: tarballs\n          path: dist\n",
        ),
      ),
    ).toEqual([
      "release.yml: jobs.publish step 3: the download is not the artifact tarballs in out",
    ]);
    expect(
      releaseFailures(swap(RELEASE, "if-no-files-found: error", "if-no-files-found: warn")),
    ).toEqual([
      "release.yml: jobs.check step 15: the upload is not the artifact tarballs with if-no-files-found: error",
    ]);
  });

  it("refuses a YAML form outside the subset", () => {
    expect(() => readYaml("a: &x 1\nb: *x\n")).toThrow("line 1: an anchor, an alias, or a tag");
    expect(() => readYaml("a: >\n  text\n")).toThrow("line 1: a block scalar other than |");
    expect(() => readYaml("a:\n\tb: 1\n")).toThrow("line 2: a tab");
    expect(() => readYaml("a: 1\na: 2\n")).toThrow("line 2: the key a again");
    expect(() => readYaml("a: { b: 1 }\n")).toThrow("line 1: a flow mapping other than {}");
    expect(readYaml('a:\n  - b: "x" # c\n    d: |\n      one\n        two\n  - e\n')).toEqual({
      kind: "map",
      line: 1,
      entries: {
        a: {
          kind: "list",
          line: 2,
          items: [
            {
              kind: "map",
              line: 2,
              entries: {
                b: { kind: "scalar", line: 2, value: "x", comment: "c" },
                d: { kind: "scalar", line: 3, value: "one\n  two\n", comment: null },
              },
            },
            { kind: "scalar", line: 6, value: "e", comment: null },
          ],
        },
      },
    });
    expect(check(swap(CI, "on:\n", "on: &trigger\n"), RELEASE).failures).toEqual([
      "ci.yml: line 8: an anchor, an alias, or a tag",
    ]);
  });

  it("fails when it reads zero files", () => {
    const r = checkWorkflows({ files: [] });
    expect(r.failures).toEqual([
      "ci.yml: the file is missing",
      "release.yml: the file is missing",
      "read 0 files",
    ]);
    expect(summaryLine(r)).toBe("check-workflows: FAIL files=0 uses=0 pinned=0 failures=3");
    // A third workflow has no rules here, so it fails.
    expect(
      checkWorkflows({
        files: [
          { name: "ci.yml", text: CI },
          { name: "deploy.yml", text: CI },
          { name: "release.yml", text: RELEASE },
        ],
      }).failures,
    ).toEqual(["deploy.yml: another workflow; a workflow needs its rules in check-workflows"]);
  });

  it("reads the two files of the tree", () => {
    expect(entry(root)).toEqual({
      lines: ["check-workflows: PASS files=2 uses=10 pinned=10 failures=0"],
      code: 0,
    });
  });
});
