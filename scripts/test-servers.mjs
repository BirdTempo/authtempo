#!/usr/bin/env node
// The test servers of one worktree (design
// docs/superpowers/specs/2026-10-22-test-servers-per-worktree-design.md).
//
//   node scripts/test-servers.mjs register-main
//   node scripts/test-servers.mjs up [--only postgres,mysql84]
//   node scripts/test-servers.mjs env
//   node scripts/test-servers.mjs down
//   node scripts/test-servers.mjs status
//   node scripts/test-servers.mjs reap [--idle-minutes 30]
//   node scripts/test-servers.mjs run [--only postgres] -- <command> [args]
//
// Each worktree that runs tests has its own slot and its own set of servers,
// so a sweep, a drop, or a reset in one worktree cannot reach another. Slot 0
// is the one main worktree that register-main names in the slot table of the
// machine. It uses the running set of docker-compose.yml, and this script
// only reads that set. Every compose call names the project of
// projectOf(slot), which throws for slot 0.
import { spawn, spawnSync } from "node:child_process";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envFileText, envOf, portOf, SERVICES } from "./test-ports.mjs";
import {
  addRun,
  checkSlot0,
  claimSlot,
  dropRow,
  goneRows,
  IDLE_MS,
  pidAlive,
  projectOf,
  reapRows,
  registerMain,
  removeRun,
  rowOf,
  tablePath,
  withTable,
} from "./test-slots.mjs";

/** The compose file of slots 1 and up, in the checkout of this script. */
const COMPOSE_FILE = fileURLToPath(new URL("../docker-compose.slots.yml", import.meta.url));
/** The env file of a worktree. The root .gitignore keeps it out of git. */
export const ENV_FILE = ".test-servers.env";
/** The longest wait for one server to answer after its container starts. */
const READY_MS = 120_000;
const ALL = SERVICES.map((s) => s.name);
/** The label that names the worktree of each container of a set (docker-compose.slots.yml). */
const WORKTREE_LABEL = "authtempo.worktree";

/** An error that exits 2: a refusal or a wrong call, not a failure. */
class Refusal extends Error {}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0)
    throw new Refusal(`git ${args.join(" ")} failed in ${cwd}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

/** @param {string} path */
function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * True when `path` is the top folder of a live git worktree. The table holds
 * the rows of every clone on the machine, so each row is checked by its own
 * path. A folder that is gone, or that git no longer knows, counts as removed.
 * @param {string} path
 */
function liveWorktree(path) {
  if (realOrNull(path) === null) return false;
  const run = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" });
  return run.status === 0 && realOrNull(run.stdout.trim()) === path;
}

/**
 * The live worktrees among the rows of the table.
 * @param {{ rows: { worktree: string }[] }} table
 */
const liveOf = (table) => table.rows.map((r) => r.worktree).filter(liveWorktree);

/**
 * The worktree of `cwd`, whether it is the main worktree of its repo, and the
 * path of the slot table of the machine.
 * @param {string} cwd
 */
export function contextOf(cwd) {
  const worktree = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  const listed = git(cwd, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  const main = realOrNull(listed[0] ?? "") ?? listed[0] ?? "";
  return { worktree, isMain: worktree === main, table: tablePath() };
}

/**
 * The variables of the compose file: the ports of the slot and the worktree
 * that owns the set.
 * @param {number} slot
 * @param {string} worktree
 */
function composeEnv(slot, worktree) {
  /** @type {Record<string, string>} */
  const env = { AUTHTEMPO_WORKTREE: worktree };
  for (const name of ALL)
    env[`AUTHTEMPO_PORT_${name.toUpperCase().replaceAll("-", "_")}`] = String(portOf(slot, name));
  return env;
}

/**
 * Runs docker compose for the project of a slot of 1 or more.
 * @param {number} slot
 * @param {string} worktree
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [opts]
 */
function compose(slot, worktree, args, opts = {}) {
  const project = projectOf(slot);
  return spawnSync("docker", ["compose", "-p", project, "-f", COMPOSE_FILE, ...args], {
    env: { ...process.env, ...composeEnv(slot, worktree) },
    stdio: opts.quiet === true ? "pipe" : ["ignore", "inherit", "inherit"],
    encoding: "utf8",
  });
}

/**
 * Stops when a container of the project of the slot belongs to another
 * worktree. The slot table is the first guard, and this label check is the
 * second. So a hand edit or a second table cannot start or remove the set of
 * another worktree.
 * @param {number} slot
 * @param {string} worktree
 */
function checkOwner(slot, worktree) {
  const project = projectOf(slot);
  const ps = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      `{{.Names}}\t{{.Label "${WORKTREE_LABEL}"}}`,
    ],
    { encoding: "utf8" },
  );
  for (const line of (ps.stdout ?? "").split("\n").filter((l) => l !== "")) {
    const [name, owner] = line.split("\t");
    if (owner !== worktree)
      throw new Refusal(
        `the container ${name} of ${project} belongs to ${owner || "no worktree"}, not ${worktree}. ` +
          "The script touches no set of another worktree.",
      );
  }
}

/**
 * Removes the set of a slot of 1 or more, after the owner check.
 * @param {number} slot
 * @param {string} worktree
 */
function composeDown(slot, worktree) {
  checkOwner(slot, worktree);
  return compose(slot, worktree, ["down", "-v", "--remove-orphans"]).status === 0;
}

/**
 * Stops a taken port before a set starts. A port that a container of
 * `project` and of `worktree` publishes is the set's own. The script never
 * takes another port.
 * @param {readonly number[]} ports
 * @param {string} project
 * @param {string} worktree
 */
export function checkPortsFree(ports, project, worktree) {
  for (const port of ports) {
    const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
    });
    if (lsof.stdout.trim() === "") continue;
    const owner = spawnSync(
      "docker",
      [
        "ps",
        "--filter",
        `publish=${port}`,
        "--format",
        `{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "${WORKTREE_LABEL}"}}`,
      ],
      { encoding: "utf8" },
    );
    const container = (owner.stdout ?? "").trim().split("\n")[0] ?? "";
    const [name, ownProject, ownWorktree] = container.split("\t");
    if (container !== "" && ownProject === project && ownWorktree === worktree) continue;
    const pid = /^p(\d+)$/m.exec(lsof.stdout)?.[1];
    const command = /^c(.+)$/m.exec(lsof.stdout)?.[1];
    const who = container !== "" ? `the container ${name}` : `${command} (pid ${pid})`;
    throw new Refusal(
      `port ${port} is taken by ${who}. Free it, or remove the set that holds it. ` +
        "The script never takes another port.",
    );
  }
}

/**
 * Answers when a TCP connect to the port succeeds.
 * @param {number} port
 */
function tcpOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
  });
}

/**
 * True when one server of a slot of 1 or more answers a real request. The
 * images run a first server during init that the health checks can reach, so
 * Postgres and MySQL get a query over TCP inside the container.
 * @param {number} slot
 * @param {string} worktree
 * @param {string} name
 */
async function answers(slot, worktree, name) {
  const port = portOf(slot, name);
  if (!(await tcpOpen(port))) return false;
  if (name === "postgres")
    return (
      compose(
        slot,
        worktree,
        [
          "exec",
          "-T",
          name,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "tempo",
          "-d",
          "tempo_auth",
          "-tAc",
          "select 1",
        ],
        { quiet: true },
      ).status === 0
    );
  if (name.startsWith("mysql"))
    return (
      compose(
        slot,
        worktree,
        ["exec", "-T", name, "mysql", "-h127.0.0.1", "-uroot", "-ptempo", "-e", "select 1"],
        { quiet: true },
      ).status === 0
    );
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
  } catch {
    return false;
  }
}

/** @param {number} ms */
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {number} slot
 * @param {string} worktree
 * @param {readonly string[]} names
 */
async function waitReady(slot, worktree, names) {
  for (const name of names) {
    const until = Date.now() + READY_MS;
    while (!(await answers(slot, worktree, name))) {
      if (Date.now() > until)
        throw new Error(`${name} of slot ${slot} did not answer in ${READY_MS / 1000} s`);
      await pause(500);
    }
  }
}

/**
 * @param {string} worktree
 * @param {number} slot
 * @param {readonly string[]} names
 */
function writeEnvFile(worktree, slot, names) {
  writeFileSync(
    join(worktree, ENV_FILE),
    `# The test servers of this worktree, slot ${slot}. Written by scripts/test-servers.mjs up.\n${envFileText(slot, names)}`,
  );
}

/**
 * Takes the slot of the worktree, starts its services, waits for each, and
 * writes the env file. Answers the row.
 * @param {string} cwd
 * @param {readonly string[]} names
 */
export async function up(cwd, names) {
  const ctx = contextOf(cwd);
  const { row, gone } = withTable(ctx.table, (table) => ({
    gone: goneRows(table, liveOf(table)).map((r) => ({ ...r })),
    row: {
      ...claimSlot(table, {
        worktree: ctx.worktree,
        isMain: ctx.isMain,
        services: names,
        now: Date.now(),
      }),
    },
  }));
  // The sets of removed worktrees go after the lock is free: a down of many
  // sets can take longer than the lock wait of other calls (review m6).
  removeGone(ctx.table, gone);
  if (row.slot === 0) {
    for (const name of names)
      if (!(await tcpOpen(portOf(0, name))))
        throw new Refusal(
          `slot 0 is the running set of docker-compose.yml, and ${name} on port ${portOf(0, name)} does not answer. ` +
            `Start it in the main worktree: docker compose up -d ${name}`,
        );
  } else {
    checkPortsFree(
      row.services.map((n) => portOf(row.slot, n)),
      projectOf(row.slot),
      ctx.worktree,
    );
    checkOwner(row.slot, ctx.worktree);
    const started = compose(row.slot, ctx.worktree, ["up", "-d", "--wait", ...row.services]);
    if (started.status !== 0) throw new Error(`docker compose up failed for slot ${row.slot}`);
    await waitReady(row.slot, ctx.worktree, row.services);
  }
  writeEnvFile(ctx.worktree, row.slot, row.services);
  return row;
}

/**
 * Removes the sets of removed worktrees, outside the lock, then drops their
 * rows under the lock. A failed down keeps its row, so no slot is given twice
 * while its containers live. A row that changed in the meantime stays.
 * @param {string} tableFile
 * @param {readonly import("./test-slots.mjs").SlotRow[]} gone
 */
function removeGone(tableFile, gone) {
  const removed = gone.filter((r) => {
    try {
      return composeDown(r.slot, r.worktree);
    } catch (e) {
      console.error(`test-servers: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  });
  if (removed.length === 0) return;
  withTable(tableFile, (table) => {
    for (const r of removed) {
      const now = rowOf(table, r.worktree);
      if (now !== undefined && now.slot === r.slot && now.lastUse === r.lastUse)
        dropRow(table, r.worktree);
    }
  });
}

/**
 * Gives slot 0 to the main worktree of `cwd`. A person runs it once, in the
 * one main worktree whose running set of docker-compose.yml is slot 0.
 * @param {string} cwd
 */
function registerCommand(cwd) {
  const ctx = contextOf(cwd);
  withTable(ctx.table, (table) =>
    registerMain(table, { worktree: ctx.worktree, isMain: ctx.isMain, now: Date.now() }),
  );
  console.log(`slot 0 is ${ctx.worktree}, in ${ctx.table}`);
}

/**
 * The container that publishes the Postgres port of a slot, for the evidence script.
 * @param {number} slot
 */
function pgContainer(slot) {
  const ps = spawnSync(
    "docker",
    ["ps", "--filter", `publish=${portOf(slot, "postgres")}`, "--format", "{{.Names}}"],
    {
      encoding: "utf8",
    },
  );
  return (ps.stdout ?? "").trim().split("\n")[0] ?? "";
}

/**
 * The variables of the worktree's set: the registered main worktree has all six of slot 0.
 * @param {string} cwd
 */
function envCommand(cwd) {
  const ctx = contextOf(cwd);
  const row = withTable(ctx.table, (table) => rowOf(table, ctx.worktree));
  if (row === undefined)
    throw new Refusal(`no test servers for ${ctx.worktree}. Run: node scripts/test-servers.mjs up`);
  checkSlot0(row, ctx.isMain);
  const { slot, services: names } = row;
  let text = envFileText(slot, names);
  text += `AUTHTEMPO_TEST_SLOT=${slot}\n`;
  if (names.includes("postgres")) text += `AUTHTEMPO_TEST_PG_CONTAINER=${pgContainer(slot)}\n`;
  process.stdout.write(text);
}

/** @param {string} cwd */
function down(cwd) {
  const ctx = contextOf(cwd);
  const row = withTable(ctx.table, (table) => rowOf(table, ctx.worktree));
  if (row === undefined) {
    console.log(`no test servers for ${ctx.worktree}`);
    return;
  }
  if (row.slot === 0)
    throw new Refusal(
      "down refuses slot 0: it is the running set of main, and no script manages it",
    );
  if (!composeDown(row.slot, ctx.worktree))
    throw new Error(`docker compose down failed for slot ${row.slot}`);
  withTable(ctx.table, (table) => dropRow(table, ctx.worktree));
  rmSync(join(ctx.worktree, ENV_FILE), { force: true });
  console.log(`removed the set of slot ${row.slot} (${projectOf(row.slot)})`);
}

/**
 * The memory of each container of a slot, by the ports it publishes.
 * @param {number} slot
 * @param {readonly string[]} names
 */
function memoryOf(slot, names) {
  const ids = names.flatMap((n) => {
    const ps = spawnSync("docker", ["ps", "-q", "--filter", `publish=${portOf(slot, n)}`], {
      encoding: "utf8",
    });
    return (ps.stdout ?? "")
      .trim()
      .split("\n")
      .filter((l) => l !== "");
  });
  if (ids.length === 0) return "no container";
  const stats = spawnSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", ...ids], {
    encoding: "utf8",
  });
  const mib = (stats.stdout ?? "")
    .split("\n")
    .map((l) => /^([\d.]+)(KiB|MiB|GiB)/.exec(l.trim()))
    .filter((m) => m !== null)
    .reduce(
      (sum, m) => sum + Number(m[1]) * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2] ?? "MiB"],
      0,
    );
  return `${Math.round(mib)} MiB in ${ids.length} containers`;
}

/** @param {string} cwd */
function status(cwd) {
  const ctx = contextOf(cwd);
  const table = withTable(ctx.table, (t) => structuredClone(t));
  if (table.rows.length === 0) console.log("no slot is taken");
  for (const row of [...table.rows].sort((a, b) => a.slot - b.slot)) {
    const idle = Math.floor((Date.now() - row.lastUse) / 60000);
    const runs = row.runs.filter(pidAlive);
    const gone = row.slot !== 0 && !liveWorktree(row.worktree) ? ", worktree removed" : "";
    console.log(
      `slot ${row.slot}  ${row.worktree}  ${row.services.join(",")}  ${memoryOf(row.slot, row.services)}  ` +
        `last use ${idle} min ago${runs.length > 0 ? `, ${runs.length} run(s) alive` : ""}${gone}`,
    );
  }
}

/**
 * @param {string} cwd
 * @param {number} idleMs
 */
function reap(cwd, idleMs) {
  const ctx = contextOf(cwd);
  const removed = withTable(ctx.table, (table) => {
    const rows = reapRows(table, {
      worktrees: liveOf(table),
      now: Date.now(),
      idleMs,
      alive: pidAlive,
    });
    /** @type {typeof rows} */
    const removed = [];
    for (const row of rows) {
      // A failed down keeps the row, so no slot is given twice while its containers live.
      // reap keeps the lock for its downs: a run that starts meanwhile must not lose its set.
      let ok = false;
      try {
        ok = composeDown(row.slot, row.worktree);
      } catch (e) {
        console.error(`test-servers: ${/** @type {Error} */ (e).message}`);
      }
      if (!ok) {
        console.error(`docker compose down failed for slot ${row.slot}; its row stays`);
        continue;
      }
      dropRow(table, row.worktree);
      rmSync(join(row.worktree, ENV_FILE), { force: true });
      removed.push(row);
    }
    return removed;
  });
  if (removed.length === 0) console.log("no set to reap");
  for (const row of removed) console.log(`reaped slot ${row.slot} (${row.worktree})`);
}

/**
 * Starts the set, then runs the command with its variables. The run marks
 * itself in the table, so reap leaves the set while the command runs.
 * @param {string} cwd
 * @param {readonly string[]} names
 * @param {string[]} command
 */
async function run(cwd, names, command) {
  const [bin, ...args] = command;
  if (bin === undefined) throw new Refusal("run needs a command after --");
  checkCommand(command);
  const row = await up(cwd, names);
  const ctx = contextOf(cwd);
  withTable(ctx.table, (table) => addRun(table, ctx.worktree, process.pid));
  const child = spawn(bin, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...envOf(row.slot, row.services) },
  });
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"]))
    process.on(signal, () => child.kill(signal));
  const code = await new Promise((done) => {
    child.on("exit", (c, signal) => done(c ?? (signal === null ? 1 : 128)));
    child.on("error", (e) => {
      console.error(e.message);
      done(127);
    });
  });
  withTable(ctx.table, (table) => {
    removeRun(table, ctx.worktree, process.pid);
    const mine = rowOf(table, ctx.worktree);
    if (mine !== undefined) mine.lastUse = Date.now();
  });
  return /** @type {number} */ (code);
}

/**
 * Turbo flags. After a second "--", turbo gives them to the task scripts, not
 * to turbo. So a filtered run becomes a run of every package (review m3).
 */
const TURBO_FLAG =
  /^(-F|--(filter|force|continue|dry|dry-run|concurrency|affected|cache|cache-dir|only|summarize|output-logs|log-order|parallel|graph|env-mode|ui|log-prefix|daemon|no-daemon|global-deps|profile|remote-only)(=.*)?)$/;

/**
 * Refuses a second "--" before turbo flags. `pnpm test -- --filter=x` passes
 * the "--" on, so the run must be `pnpm test --filter=x`.
 * @param {readonly string[]} command
 */
export function checkCommand(command) {
  const cut = command.indexOf("--");
  if (cut !== -1 && command.slice(cut + 1).some((a) => TURBO_FLAG.test(a)))
    throw new Refusal(
      `the command holds a second "--" before the turbo flags ${command.slice(cut + 1).join(" ")}. ` +
        "Turbo then runs every package. Remove it: pnpm test --filter=<pkg>, or run -- pnpm turbo run test --filter=<pkg>",
    );
}

/** @param {string[]} args */
function onlyOf(args) {
  const at = args.indexOf("--only");
  if (at === -1) return ALL;
  const list = args[at + 1];
  if (list === undefined || list.startsWith("--"))
    throw new Refusal("--only needs a list, such as --only postgres,mysql84");
  const names = list.split(",").filter((n) => n !== "");
  for (const name of names)
    if (!ALL.includes(name)) throw new Refusal(`unknown test service: ${name}`);
  return names;
}

const USAGE =
  "usage: node scripts/test-servers.mjs register-main | up [--only a,b] | env | down | status | reap [--idle-minutes n] | run [--only a,b] -- <command>";

/** @param {string[]} argv */
async function main(argv) {
  const cwd = process.cwd();
  const cut = argv.indexOf("--");
  const own = cut === -1 ? argv : argv.slice(0, cut);
  const [command, ...rest] = own;
  switch (command) {
    case "register-main":
      registerCommand(cwd);
      return 0;
    case "up": {
      const row = await up(cwd, onlyOf(rest));
      console.log(`slot ${row.slot}: ${row.services.join(", ")}. Variables in ${ENV_FILE}`);
      return 0;
    }
    case "env":
      envCommand(cwd);
      return 0;
    case "down":
      down(cwd);
      return 0;
    case "status":
      status(cwd);
      return 0;
    case "reap": {
      const at = rest.indexOf("--idle-minutes");
      const minutes = at === -1 ? IDLE_MS / 60000 : Number(rest[at + 1]);
      if (!Number.isFinite(minutes) || minutes < 0)
        throw new Refusal("--idle-minutes needs a number");
      reap(cwd, minutes * 60000);
      return 0;
    }
    case "run":
      if (cut === -1) throw new Refusal(USAGE);
      return await run(cwd, onlyOf(rest), argv.slice(cut + 1));
    default:
      throw new Refusal(USAGE);
  }
}

if (
  process.argv[1] !== undefined &&
  realOrNull(process.argv[1]) === realOrNull(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(`test-servers: ${/** @type {Error} */ (e).message}`);
    process.exitCode = e instanceof Refusal ? 2 : 1;
  }
}
