import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A new git repository in its own temporary folder, for one test. */
export interface Repo {
  root: string;
  git(args: string[]): string;
  /** Runs a command in the repository with the same git environment. */
  run(command: string, args: string[]): string;
  write(path: string, text: string): void;
  /** Stages every file and makes one commit. */
  commit(message: string): void;
  remove(): void;
}

// The test repository reads no global or system git config, so a hook, a
// signing key, or a template of the user does not run. The test never reads
// the history of the real repository.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  // Git forks no detached maintenance process after a commit (git 2.54, read
  // 2026-11-04): `maintenance.auto` false stops the fork; `gc.auto` 0 alone
  // does not. The cause of the ENOTEMPTY of evidence run 3 of plan 12o is
  // not shown; this removes one possible writer of the folder.
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
};

/** The tries of `remove`, and the wait before the second try; each later wait grows by the first. */
const REMOVE_TRIES = 10;
const REMOVE_WAIT_MS = 50;

/** A wait of `ms` on this thread. Node allows `Atomics.wait` on its main thread. */
function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function makeRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "authtempo-release-git-"));
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, { cwd: root, env, encoding: "utf8" });
  const git = (args: string[]) => run("git", args);
  git(["init", "--quiet", "--initial-branch=main"]);
  return {
    root,
    git,
    run,
    write(path, text) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    commit(message) {
      git(["add", "--all"]);
      git(["commit", "--quiet", "--no-verify", "-m", message]);
    },
    remove() {
      // A delete under load answered ENOTEMPTY once (evidence run 3 of plan
      // 12o). The wait is owned here: on Node 26.10.0 the retry wait of
      // `rmSync` is in whole seconds (src/node_file.cc, RmSync, read
      // 2026-11-04). The last throw names the entries that are left.
      for (let i = 1; ; i++) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch (err) {
          let left: string[] = [];
          try {
            left = readdirSync(root, { recursive: true }).map(String);
          } catch {
            left = [];
          }
          if (i === REMOVE_TRIES)
            throw new Error(`remove of ${root}: ${i} tries; left: ${left.join(", ")}`, {
              cause: err,
            });
          wait(REMOVE_WAIT_MS * i);
        }
      }
    },
  };
}

/**
 * A repository whose branch "work" shares no commit with main, as a shallow
 * clone with no history of main does. git merge-base finds no commit.
 */
export function makeUnrelatedRepo(): Repo {
  const repo = makeRepo();
  repo.write("a.txt", "a\n");
  repo.commit("main");
  repo.git(["checkout", "--quiet", "--orphan", "work"]);
  repo.write("b.txt", "b\n");
  repo.commit("work");
  return repo;
}
