import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
};

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
      rmSync(root, { recursive: true, force: true });
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
