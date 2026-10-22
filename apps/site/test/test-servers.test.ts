import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envFileText, SERVICES } from "../../../scripts/test-ports.mjs";
import { checkPortsFree } from "../../../scripts/test-servers.mjs";
import { REPO } from "../scripts/lib/paths.ts";

// The command line of the test servers (plan test-servers-per-worktree, Task 4).
// These tests start no container: each case stops before a compose call.
// The repo below is a new git repo with one linked worktree, so the slot
// table lives in its own common directory, not in the one of this checkout.

const SCRIPT = `${REPO}scripts/test-servers.mjs`;
const temp = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-servers-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
};
const MAIN = join(temp, "main");
const LANE = join(temp, "lane");
git(temp, "init", "-q", "-b", "main", MAIN);
git(
  MAIN,
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.test",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "start",
);
git(MAIN, "worktree", "add", "-q", "-b", "lane", LANE);

/** Runs the script in `cwd` and answers its exit code, stdout, and stderr. */
function servers(cwd: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("the test-servers command", () => {
  it("refuses down in the main worktree, because slot 0 is the running set of main", () => {
    const run = servers(MAIN, "down");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      "down refuses slot 0: it is the running set of main, and no script manages it",
    );
  });

  it("prints the six variables of slot 0 in the main worktree", () => {
    const run = servers(MAIN, "env");
    expect(run.status).toBe(0);
    const lines = run.stdout.split("\n").filter((l) => l !== "");
    // test-ports.test.ts pins the ports of slot 0; this test pins that main gets them all.
    const slot0 = envFileText(
      0,
      SERVICES.map((s) => s.name),
    );
    expect(lines.filter((l) => !l.startsWith("AUTHTEMPO_TEST_"))).toEqual(
      slot0.split("\n").filter((l) => l !== ""),
    );
    expect(slot0.match(/=/g)?.length).toBe(6);
    expect(lines).toContain("AUTHTEMPO_TEST_SLOT=0");
  });

  it("names up when a worktree has no slot yet", () => {
    const run = servers(LANE, "env");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      `no test servers for ${LANE}. Run: node scripts/test-servers.mjs up`,
    );
  });

  it("refuses an unknown command and an unknown service", () => {
    expect(servers(LANE, "start").status).toBe(2);
    const run = servers(LANE, "up", "--only", "redis");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown test service: redis");
  });

  it("stops on a taken port and names the port and its owner", async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      expect(() => checkPortsFree([port], "authtempo-s1")).toThrow(
        new RegExp(`^port ${port} is taken by node \\(pid ${process.pid}\\)\\. `),
      );
    } finally {
      await new Promise((done) => server.close(done));
    }
    expect(() => checkPortsFree([port], "authtempo-s1")).not.toThrow();
  });
});
