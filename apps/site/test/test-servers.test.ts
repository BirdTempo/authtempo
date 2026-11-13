import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envFileText, MAX_SLOT, portOf, SERVICES } from "../../../scripts/test-ports.mjs";
import { checkPortsFree, setsUp } from "../../../scripts/test-servers.mjs";
import { type SlotTable, tablePath } from "../../../scripts/test-slots.mjs";
import { REPO } from "../scripts/lib/paths.ts";

// The command line of the test servers (plan test-servers-per-worktree, Task 4).
// These tests start no container. Each spawn of the script gets a HOME of its
// own. So it reads a slot table of its own, never the table of the machine.
// It also gets a fake docker first on its PATH, so no call can reach a real
// set. The fake writes each call to a log, after "held" or "free" for the
// lock of the slot table. A compose down passes, and every other compose
// call fails. The read of the sets (a ps call with the filter of the label
// authtempo.worktree) prints FAKE_DOCKER_SETS only for SETS_FORMAT. A read
// with another format fails, so a wrong format in the script fails these
// tests. Every other ps call prints FAKE_DOCKER_PS. A compose up passes only
// with FAKE_DOCKER_UP=pass. With FAKE_DOCKER_GATE, the
// compose call FAKE_DOCKER_GATE_ON (down or up) writes a file of that name
// there. It then waits for the file go-<call>, so a test can order two calls.
//
// A fake lsof is first on the PATH too. It shows a listener only on a port
// of FAKE_LSOF_PORTS. A real set on this machine can hold a port of a slot
// that the fake table gives. The real lsof then made the port check refuse
// first, and that refusal hid the refusal that the test reads.

const SCRIPT = `${REPO}scripts/test-servers.mjs`;
/**
 * The format of the read of the sets in setsUp of the script. This is a copy,
 * not an import, so a change of the format in the script fails these tests.
 * The real docker read below holds this copy.
 */
const SETS_FORMAT = '{{.Label "authtempo.worktree"}}\t{{.Label "com.docker.compose.project"}}';
const temp = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-servers-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const BIN = join(temp, "bin");
mkdirSync(BIN);
writeFileSync(
  join(BIN, "docker"),
  [
    "#!/bin/sh",
    'if [ -d "$HOME/.cache/authtempo/test-slots.json.lock" ]; then s=held; else s=free; fi',
    'echo "$s $*" >> "$FAKE_DOCKER_LOG"',
    'if [ "$1" = compose ] && [ -n "$FAKE_DOCKER_GATE" ]; then',
    '  case " $* " in',
    '    *" $FAKE_DOCKER_GATE_ON "*)',
    '      : > "$FAKE_DOCKER_GATE/$FAKE_DOCKER_GATE_ON"',
    "      i=0",
    '      while [ ! -e "$FAKE_DOCKER_GATE/go-$FAKE_DOCKER_GATE_ON" ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done ;;',
    "  esac",
    "fi",
    'case "$1 $*" in',
    '  "compose "*" down "*) exit 0 ;;',
    '  "compose "*" up "*) [ "$FAKE_DOCKER_UP" = pass ] && exit 0; exit 1 ;;',
    "  compose*) exit 1 ;;",
    '  "ps "*" label=authtempo.worktree "*)',
    `    if [ $# -eq 6 ] && [ "$2 $3 $4 $5" = "-a --filter label=authtempo.worktree --format" ] && [ "$6" = '${SETS_FORMAT}' ]; then`,
    '      printf "%s" "$FAKE_DOCKER_SETS"; exit 0',
    "    fi",
    '    echo "fake docker: no answer for this read of the sets: $*" >&2; exit 1 ;;',
    '  ps*) printf "%s" "$FAKE_DOCKER_PS" ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(join(BIN, "docker"), 0o755);
writeFileSync(
  join(BIN, "lsof"),
  [
    "#!/bin/sh",
    'for a in "$@"; do',
    '  case "$a" in',
    '    -iTCP:*) port=$(printf %s "$a" | cut -d: -f2) ;;',
    "  esac",
    "done",
    'case ",$FAKE_LSOF_PORTS," in',
    '  *",$port,"*) printf "p4242\\ncfake-listener\\n"; exit 0 ;;',
    "esac",
    "exit 1",
    "",
  ].join("\n"),
);
chmodSync(join(BIN, "lsof"), 0o755);

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
};
/** A new git repo with one empty commit: a clone, or a git-init copy. */
function repo(path: string) {
  git(temp, "init", "-q", "-b", "main", path);
  git(
    path,
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
}
const MAIN = join(temp, "main");
const LANE = join(temp, "lane");
const CLONE = join(temp, "clone");
repo(MAIN);
git(MAIN, "worktree", "add", "-q", "-b", "lane", LANE);
repo(CLONE);

let n = 0;
/** A HOME of its own, so a test starts from an empty slot table. */
function newHome() {
  const home = join(temp, `home-${++n}`);
  mkdirSync(home);
  return home;
}

/** Runs the script in `cwd` with `home` and answers its exit code, its output, and the docker calls. */
function servers(home: string, cwd: string, ...args: string[]) {
  return serversWith({}, home, cwd, ...args);
}
/** The environment of one spawn of the script: its HOME, the fakes, and their answers. */
const scriptEnv = (env: Record<string, string>, home: string) => ({
  ...process.env,
  HOME: home,
  PATH: `${BIN}:${process.env.PATH ?? ""}`,
  FAKE_DOCKER_LOG: join(home, "docker.log"),
  FAKE_DOCKER_SETS: "",
  FAKE_DOCKER_PS: "",
  FAKE_LSOF_PORTS: "",
  ...env,
});
function serversWith(env: Record<string, string>, home: string, cwd: string, ...args: string[]) {
  const log = join(home, "docker.log");
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: scriptEnv(env, home),
  });
  const docker = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, docker };
}
/** Starts the script and does not wait. Answers its pid and the promise of its end. */
function serversLater(env: Record<string, string>, home: string, cwd: string, ...args: string[]) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: scriptEnv(env, home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const end = new Promise<{ status: number | null; stdout: string; stderr: string }>((done) =>
    child.on("close", (status) => done({ status, stdout, stderr })),
  );
  return { pid: child.pid, end };
}
const tableOf = (home: string) =>
  (JSON.parse(readFileSync(tablePath(home), "utf8")) as SlotTable).rows;
const rowsOf = (home: string) => tableOf(home).map((r) => [r.worktree, r.slot]);

describe("the test-servers command", () => {
  it("refuses down in the registered main worktree, because slot 0 is the running set of main", () => {
    const home = newHome();
    expect(servers(home, MAIN, "register-main").status).toBe(0);
    const run = servers(home, MAIN, "down");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      "down refuses slot 0: it is the running set of main, and no script manages it",
    );
    expect(run.docker).toBe("");
  });

  it("prints the six variables of slot 0 in the registered main worktree", () => {
    const home = newHome();
    expect(servers(home, MAIN, "register-main").status).toBe(0);
    const run = servers(home, MAIN, "env");
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
    const run = servers(newHome(), LANE, "env");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      `no test servers for ${LANE}. Run: node scripts/test-servers.mjs up`,
    );
  });

  it("gives two slots to two clones, from one table for the machine", () => {
    const home = newHome();
    servers(home, MAIN, "up", "--only", "libsql");
    servers(home, CLONE, "up", "--only", "libsql");
    // Each clone is the main worktree of its repo, and none is registered: no slot 0.
    expect(rowsOf(home)).toEqual([
      [MAIN, 1],
      [CLONE, 2],
    ]);
  });

  it("never gives slot 0 to a git-init copy or a linked worktree", () => {
    const home = newHome();
    expect(servers(home, MAIN, "register-main").status).toBe(0);
    servers(home, CLONE, "up", "--only", "libsql");
    servers(home, LANE, "up", "--only", "libsql");
    expect(rowsOf(home)).toEqual([
      [MAIN, 0],
      [CLONE, 1],
      [LANE, 2],
    ]);
    const lane = servers(home, LANE, "register-main");
    expect(lane.status).toBe(1);
    expect(lane.stderr).toContain(`${LANE} is a linked worktree: slot 0 is for a main worktree`);
    const clone = servers(home, CLONE, "register-main");
    expect(clone.stderr).toContain(`slot 0 belongs to ${MAIN}. Only one path holds slot 0`);
  });

  it("refuses env and up in a linked worktree with a hand-written slot 0 row", () => {
    const home = newHome();
    // A person can edit the table by hand; this row sends a lane to the servers of main.
    mkdirSync(join(home, ".cache", "authtempo"), { recursive: true });
    writeFileSync(
      tablePath(home),
      JSON.stringify({
        version: 1,
        rows: [{ worktree: LANE, slot: 0, lastUse: Date.now(), services: ["libsql"], runs: [] }],
      }),
    );
    const refusal = `the slot table gives slot 0 to ${LANE}, which is a linked worktree`;
    const env = servers(home, LANE, "env");
    expect(env.status).toBe(1);
    expect(env.stderr).toContain(refusal);
    expect(env.stdout).toBe("");
    const up = servers(home, LANE, "up", "--only", "libsql");
    expect(up.status).toBe(1);
    expect(up.stderr).toContain(refusal);
    expect(existsSync(join(LANE, ".test-servers.env"))).toBe(false);
  });

  it("refuses an unknown command and an unknown service", () => {
    const home = newHome();
    expect(servers(home, LANE, "start").status).toBe(2);
    const run = servers(home, LANE, "up", "--only", "redis");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown test service: redis");
  });

  it("refuses a second -- before turbo flags, which turbo gives to every package", () => {
    const home = newHome();
    // pnpm test -- --filter=x passes the -- on to the script.
    const run = servers(
      home,
      LANE,
      "run",
      "--",
      "turbo",
      "run",
      "test",
      "--",
      "--filter=@authtempo/cli",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      'the command holds a second "--" before the turbo flags --filter=@authtempo/cli. Turbo then runs every package.',
    );
    expect(run.docker).toBe("");
    expect(existsSync(tablePath(home))).toBe(false);
  });

  it("stops up on a taken port before any compose call", () => {
    const home = newHome();
    const port = portOf(1, "libsql-cli-compat");
    const run = serversWith(
      { FAKE_LSOF_PORTS: String(port) },
      home,
      LANE,
      "up",
      "--only",
      "libsql-cli-compat",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(
      new RegExp(`^test-servers: port ${port} is taken by fake-listener \\(pid 4242\\)\\. `),
    );
    expect(run.docker).not.toMatch(/^\w+ compose /m);
  });

  it("refuses to remove a set whose containers name another worktree", () => {
    const home = newHome();
    servers(home, LANE, "up", "--only", "libsql");
    expect(rowsOf(home)).toEqual([[LANE, 1]]);
    // A second table, or a hand edit, gave this slot to another clone, which runs its set now.
    const run = serversWith(
      { FAKE_DOCKER_PS: "authtempo-s1-libsql-1\t/elsewhere/clone\n" },
      home,
      LANE,
      "down",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      `the container authtempo-s1-libsql-1 of authtempo-s1 belongs to /elsewhere/clone, not ${LANE}.`,
    );
    expect(run.docker).not.toMatch(/ down /);
    expect(rowsOf(home)).toEqual([[LANE, 1]]);
  });

  it("refuses up when a container of its slot names another worktree", () => {
    const home = newHome();
    // A second table, or a hand edit, gave slot 1 to another clone, which runs its set now.
    // The fake lsof shows no listener, so the port check passes and the owner check refuses.
    const run = serversWith(
      { FAKE_DOCKER_PS: "authtempo-s1-libsql-1\t/elsewhere/clone\n" },
      home,
      LANE,
      "up",
      "--only",
      "libsql",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      `the container authtempo-s1-libsql-1 of authtempo-s1 belongs to /elsewhere/clone, not ${LANE}.`,
    );
    expect(run.docker).toMatch(/ ps -a --filter label=com\.docker\.compose\.project=authtempo-s1 /);
    expect(run.docker).not.toMatch(/^\w+ compose /m);
  });

  it("refuses up when a port of its slot is held by a container of another worktree", () => {
    const home = newHome();
    const port = portOf(1, "libsql-cli-compat");
    // The project matches, and only the label names another worktree.
    const run = serversWith(
      {
        FAKE_LSOF_PORTS: String(port),
        FAKE_DOCKER_PS: "authtempo-s1-libsql-cli-compat-1\tauthtempo-s1\t/elsewhere/clone\n",
      },
      home,
      LANE,
      "up",
      "--only",
      "libsql-cli-compat",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      `port ${port} is taken by the container authtempo-s1-libsql-cli-compat-1. `,
    );
    expect(run.docker).toMatch(new RegExp(` ps --filter publish=${port} `));
    expect(run.docker).not.toMatch(/^\w+ compose /m);
  });

  // Plan 12q decision 7. A second table (another HOME) or a lost row gives
  // the table no row for slot 1 while its set runs.
  it("takes slot 2 when the set of slot 1 runs under another worktree's label and no row names it", () => {
    const home = newHome();
    const run = serversWith(
      { FAKE_DOCKER_SETS: "/elsewhere/clone\tauthtempo-s1\n" },
      home,
      LANE,
      "up",
      "--only",
      "libsql",
    );
    // The fake fails each compose call but down, so up stops after the take.
    expect(run.stderr).toContain("docker compose up failed for slot 2");
    expect(rowsOf(home)).toEqual([[LANE, 2]]);
    // The take read the sets in the format of SETS_FORMAT while it held the lock of the table.
    expect(run.docker).toContain(
      `held ps -a --filter label=authtempo.worktree --format ${SETS_FORMAT}\n`,
    );
  });

  it("takes no slot when the read of the sets gives a line that it cannot read", () => {
    const home = newHome();
    // A space for the tab: the form that a wrong format string gives.
    const run = serversWith(
      { FAKE_DOCKER_SETS: "/elsewhere/clone authtempo-s1\n" },
      home,
      LANE,
      "up",
      "--only",
      "libsql",
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'docker ps gave the line "/elsewhere/clone authtempo-s1", not <worktree label><tab><compose project>.',
    );
    expect(existsSync(tablePath(home))).toBe(false);
    expect(run.docker).not.toMatch(/^\w+ compose /m);
  });

  // The fake docker answers only SETS_FORMAT. This test holds that format
  // against real docker. It makes two containers and starts none of them.
  it("lists the sets under their worktree labels in a real docker read", (ctx) => {
    const daemon = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    ctx.skip(
      daemon.status !== 0,
      `docker does not answer on this machine: ${(daemon.stderr ?? "").trim() || daemon.error?.message}`,
    );
    // The libSQL image of the test servers. This test pulls no image.
    const image =
      /image: (ghcr\.io\/tursodatabase\/libsql-server\S+)/.exec(
        readFileSync(`${REPO}docker-compose.yml`, "utf8"),
      )?.[1] ?? "no libSQL image in docker-compose.yml";
    ctx.skip(
      spawnSync("docker", ["image", "inspect", image]).status !== 0,
      `the image ${image} is not on this machine, and this test pulls no image`,
    );
    // No take gives a slot above MAX_SLOT, and no owner check reads one.
    const sets = [MAX_SLOT + 1, MAX_SLOT + 2].map((slot) => ({
      slot,
      worktree: join(temp, `real-read-${slot}`),
    }));
    const names = sets.map((s) => `authtempo-read-test-${process.pid}-${s.slot}`);
    try {
      sets.forEach((s, i) => {
        const create = spawnSync(
          "docker",
          [
            "create",
            "--pull",
            "never",
            "--name",
            names[i] as string,
            "--label",
            `authtempo.worktree=${s.worktree}`,
            "--label",
            `com.docker.compose.project=authtempo-s${s.slot}`,
            image,
          ],
          { encoding: "utf8" },
        );
        expect(create.status, create.stderr).toBe(0);
      });
      const mine = setsUp().filter((s) => s.worktree.startsWith(join(temp, "real-read-")));
      expect(mine.sort((a, b) => a.slot - b.slot)).toEqual(sets);
    } finally {
      spawnSync("docker", ["rm", "-f", ...names]);
    }
  });

  it("keeps the row when the set is not gone after compose down", () => {
    const home = newHome();
    servers(home, LANE, "up", "--only", "libsql");
    expect(rowsOf(home)).toEqual([[LANE, 1]]);
    // Compose down exits 0, but a container of the set is left. An up of the
    // same worktree that ends in the gap of a down gives this.
    const left = serversWith(
      { FAKE_DOCKER_PS: `authtempo-s1-libsql-1\t${LANE}\n` },
      home,
      LANE,
      "down",
    );
    expect(left.status).toBe(1);
    expect(left.stderr).toContain(
      "docker compose down left authtempo-s1-libsql-1 of authtempo-s1; the row of slot 1 stays",
    );
    // The read of the containers runs under the lock of the drop, after compose down.
    expect(left.docker).toMatch(
      /^held ps -a --filter label=com\.docker\.compose\.project=authtempo-s1 --format \{\{\.Names\}\}$/m,
    );
    expect(rowsOf(home)).toEqual([[LANE, 1]]);
    const gone = servers(home, LANE, "down");
    expect(gone.status).toBe(0);
    expect(rowsOf(home)).toEqual([]);
  });

  // Review of Task 0 of 12q, Low 3. down drops the row under a second lock,
  // after compose down. A start of the same worktree in that gap kept its row
  // and started the set after the drop. A take of another worktree then got
  // the slot. The fake stops down in compose down and the start in compose up.
  for (const [who, start] of [
    ["a run", ["run", "--only", "libsql", "--", "true"]],
    ["an up", ["up", "--only", "libsql"]],
  ] as const)
    it(`keeps the row while ${who} of its worktree starts the set in the gap of a down`, async () => {
      const home = newHome();
      servers(home, LANE, "up", "--only", "libsql");
      expect(rowsOf(home)).toEqual([[LANE, 1]]);
      const gate = join(home, "gate");
      mkdirSync(gate);
      const until = (file: string) =>
        expect
          .poll(() => existsSync(join(gate, file)), { timeout: 10_000, interval: 20 })
          .toBe(true);
      try {
        const down = serversLater(
          { FAKE_DOCKER_GATE: gate, FAKE_DOCKER_GATE_ON: "down" },
          home,
          LANE,
          "down",
        );
        await until("down");
        // The start takes the slot of its row. No container of the set exists yet.
        const begun = serversLater(
          { FAKE_DOCKER_GATE: gate, FAKE_DOCKER_GATE_ON: "up" },
          home,
          LANE,
          ...start,
        );
        await until("up");
        writeFileSync(join(gate, "go-down"), "");
        const downEnd = await down.end;
        expect(downEnd.stderr).toContain(
          `a start or a test run of ${LANE} (pid ${begun.pid}) is alive; the row of slot 1 stays`,
        );
        expect(downEnd.status).toBe(1);
        // A take of another worktree while the start holds slot 1.
        servers(home, CLONE, "up", "--only", "libsql");
        expect(rowsOf(home)).toEqual([
          [LANE, 1],
          [CLONE, 2],
        ]);
        writeFileSync(join(gate, "go-up"), "");
        expect((await begun.end).stderr).toContain("docker compose up failed for slot 1");
        // Each start that ended took its pid out of its row, so the next down drops the row.
        expect(tableOf(home).map((r) => r.runs)).toEqual([[], []]);
        expect(servers(home, LANE, "down").status).toBe(0);
        expect(rowsOf(home)).toEqual([[CLONE, 2]]);
      } finally {
        writeFileSync(join(gate, "go-down"), "");
        writeFileSync(join(gate, "go-up"), "");
      }
    }, 30_000);

  it("keeps the mark of a run in its row until its command ends", async () => {
    const home = newHome();
    // Sets of another worktree on slots 1 to 89 send the take to slot 90.
    // This test serves the health check of its libSQL port.
    const sets = Array.from({ length: 89 }, (_, i) => `/elsewhere/clone\tauthtempo-s${i + 1}\n`);
    const health = createHttpServer((_, res) => res.end("ok"));
    await new Promise<void>((done) => health.listen(portOf(90, "libsql"), "127.0.0.1", done));
    try {
      // The command prints its parent, the run, and the marks of the table.
      const show =
        "const t = JSON.parse(require('node:fs').readFileSync(process.env.HOME + '/.cache/authtempo/test-slots.json', 'utf8'));" +
        "console.log(JSON.stringify({ parent: process.ppid, runs: t.rows.map((r) => r.runs) }));";
      const run = serversLater(
        { FAKE_DOCKER_SETS: sets.join(""), FAKE_DOCKER_UP: "pass" },
        home,
        LANE,
        "run",
        "--only",
        "libsql",
        "--",
        process.execPath,
        "-e",
        show,
      );
      const end = await run.end;
      expect(end.stderr).toBe("");
      expect(end.status).toBe(0);
      expect(JSON.parse(end.stdout)).toEqual({ parent: run.pid, runs: [[run.pid]] });
      expect(tableOf(home).map((r) => [r.worktree, r.slot, r.runs])).toEqual([[LANE, 90, []]]);
    } finally {
      await new Promise((done) => health.close(done));
      servers(home, LANE, "down");
    }
    expect(existsSync(join(LANE, ".test-servers.env"))).toBe(false);
  });

  it("removes the set of a removed worktree after it frees the lock", () => {
    const home = newHome();
    const gone = join(temp, `gone-${n}`);
    git(MAIN, "worktree", "add", "-q", "--detach", gone);
    servers(home, gone, "up", "--only", "libsql");
    git(MAIN, "worktree", "remove", gone);
    servers(home, LANE, "up", "--only", "libsql");
    const downs = servers(home, LANE, "status")
      .docker.split("\n")
      .filter((l) => / down /.test(l));
    // A down of many sets under the lock can pass the lock wait of other calls.
    expect(downs.length).toBe(1);
    expect(downs[0]).toMatch(/^free compose -p authtempo-s1 /);
    expect(rowsOf(home)).toEqual([[LANE, 2]]);
  });

  it("stops on a taken port and names the port and its owner", async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      // lsof gives the name of the thread that holds the socket. On macOS that is
      // `node`. On Linux it is `node-MainThread` (seen on a GitHub runner on 2026-11-13,
      // where the test held `node` only and failed). So the name starts with node.
      expect(() => checkPortsFree([port], "authtempo-s1", LANE)).toThrow(
        new RegExp(`^port ${port} is taken by node[\\w-]* \\(pid ${process.pid}\\)\\. `),
      );
    } finally {
      await new Promise((done) => server.close(done));
    }
    expect(() => checkPortsFree([port], "authtempo-s1", LANE)).not.toThrow();
  });
});
