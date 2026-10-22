#!/usr/bin/env node
// The test servers of one worktree (design
// docs/superpowers/specs/2026-10-22-test-servers-per-worktree-design.md).
//
//   node scripts/test-servers.mjs up [--only postgres,mysql84]
//   node scripts/test-servers.mjs env
//   node scripts/test-servers.mjs down
//   node scripts/test-servers.mjs status
//   node scripts/test-servers.mjs reap [--idle-minutes 30]
//   node scripts/test-servers.mjs run [--only postgres] -- <command> [args]
//
// Each worktree that runs tests has its own slot and its own set of servers,
// so a sweep, a drop, or a reset in one worktree cannot reach another. Slot 0
// is the main worktree: it uses the running set of docker-compose.yml, and
// this script only reads that set. Every compose call names the project of
// projectOf(slot), which throws for slot 0.
import { spawn, spawnSync } from "node:child_process";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envFileText, envOf, portOf, SERVICES } from "./test-ports.mjs";
import {
  addRun,
  claimSlot,
  dropRow,
  goneRows,
  IDLE_MS,
  pidAlive,
  projectOf,
  reapRows,
  removeRun,
  rowOf,
  TABLE_FILE,
  withTable,
} from "./test-slots.mjs";

/** The compose file of slots 1 and up, in the checkout of this script. */
const COMPOSE_FILE = fileURLToPath(new URL("../docker-compose.slots.yml", import.meta.url));
/** The env file of a worktree. The root .gitignore keeps it out of git. */
export const ENV_FILE = ".test-servers.env";
/** The longest wait for one server to answer after its container starts. */
const READY_MS = 120_000;
const ALL = SERVICES.map((s) => s.name);

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
 * The worktree of `cwd`, the main worktree, every live worktree, and the table path.
 * A listed worktree whose folder is gone counts as removed.
 * @param {string} cwd
 */
export function contextOf(cwd) {
  const worktree = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const listed = git(cwd, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  const main = realOrNull(listed[0] ?? "") ?? listed[0] ?? "";
  const worktrees = listed.map(realOrNull).filter((p) => p !== null);
  return { worktree, main, worktrees, table: join(common, TABLE_FILE) };
}

/** @param {number} slot */
function portEnv(slot) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of ALL)
    env[`AUTHTEMPO_PORT_${name.toUpperCase().replaceAll("-", "_")}`] = String(portOf(slot, name));
  return env;
}

/**
 * Runs docker compose for the project of a slot of 1 or more.
 * @param {number} slot
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [opts]
 */
function compose(slot, args, opts = {}) {
  const project = projectOf(slot);
  return spawnSync("docker", ["compose", "-p", project, "-f", COMPOSE_FILE, ...args], {
    env: { ...process.env, ...portEnv(slot) },
    stdio: opts.quiet === true ? "pipe" : ["ignore", "inherit", "inherit"],
    encoding: "utf8",
  });
}

/**
 * Stops a taken port before a set starts. A port that a container of
 * `project` publishes is the set's own. The script never takes another port.
 * @param {readonly number[]} ports
 * @param {string} project
 */
export function checkPortsFree(ports, project) {
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
        '{{.Names}} {{.Label "com.docker.compose.project"}}',
      ],
      { encoding: "utf8" },
    );
    const container = (owner.stdout ?? "").trim().split("\n")[0] ?? "";
    if (container !== "" && container.split(" ")[1] === project) continue;
    const pid = /^p(\d+)$/m.exec(lsof.stdout)?.[1];
    const command = /^c(.+)$/m.exec(lsof.stdout)?.[1];
    const who =
      container !== "" ? `the container ${container.split(" ")[0]}` : `${command} (pid ${pid})`;
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
 * @param {string} name
 */
async function answers(slot, name) {
  const port = portOf(slot, name);
  if (!(await tcpOpen(port))) return false;
  if (name === "postgres")
    return (
      compose(
        slot,
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
 * @param {readonly string[]} names
 */
async function waitReady(slot, names) {
  for (const name of names) {
    const until = Date.now() + READY_MS;
    while (!(await answers(slot, name))) {
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
  const row = withTable(ctx.table, (table) => {
    // The set of a removed worktree goes first, so its slot is free again.
    // A failed down keeps the row, so no slot is given twice while its containers live.
    for (const gone of goneRows(table, ctx.worktrees))
      if (compose(gone.slot, ["down", "-v", "--remove-orphans"]).status === 0)
        dropRow(table, gone.worktree);
    return {
      ...claimSlot(table, {
        worktree: ctx.worktree,
        main: ctx.main,
        services: names,
        now: Date.now(),
      }),
    };
  });
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
    );
    const started = compose(row.slot, ["up", "-d", "--wait", ...row.services]);
    if (started.status !== 0) throw new Error(`docker compose up failed for slot ${row.slot}`);
    await waitReady(row.slot, row.services);
  }
  writeEnvFile(ctx.worktree, row.slot, row.services);
  return row;
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
 * The variables of the worktree's set: the main worktree has all six of slot 0.
 * @param {string} cwd
 */
function envCommand(cwd) {
  const ctx = contextOf(cwd);
  let slot = 0;
  let names = ALL;
  if (ctx.worktree !== ctx.main) {
    const row = withTable(ctx.table, (table) => rowOf(table, ctx.worktree));
    if (row === undefined)
      throw new Refusal(
        `no test servers for ${ctx.worktree}. Run: node scripts/test-servers.mjs up`,
      );
    slot = row.slot;
    names = row.services;
  }
  let text = envFileText(slot, names);
  text += `AUTHTEMPO_TEST_SLOT=${slot}\n`;
  if (names.includes("postgres")) text += `AUTHTEMPO_TEST_PG_CONTAINER=${pgContainer(slot)}\n`;
  process.stdout.write(text);
}

/** @param {string} cwd */
function down(cwd) {
  const ctx = contextOf(cwd);
  if (ctx.worktree === ctx.main)
    throw new Refusal(
      "down refuses slot 0: it is the running set of main, and no script manages it",
    );
  const row = withTable(ctx.table, (table) => rowOf(table, ctx.worktree));
  if (row === undefined) {
    console.log(`no test servers for ${ctx.worktree}`);
    return;
  }
  const stopped = compose(row.slot, ["down", "-v", "--remove-orphans"]);
  if (stopped.status !== 0) throw new Error(`docker compose down failed for slot ${row.slot}`);
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
    const gone =
      row.slot !== 0 && !ctx.worktrees.includes(row.worktree) ? ", worktree removed" : "";
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
      worktrees: ctx.worktrees,
      now: Date.now(),
      idleMs,
      alive: pidAlive,
    });
    /** @type {typeof rows} */
    const removed = [];
    for (const row of rows) {
      // A failed down keeps the row, so no slot is given twice while its containers live.
      if (compose(row.slot, ["down", "-v", "--remove-orphans"]).status !== 0) {
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
  "usage: node scripts/test-servers.mjs up [--only a,b] | env | down | status | reap [--idle-minutes n] | run [--only a,b] -- <command>";

/** @param {string[]} argv */
async function main(argv) {
  const cwd = process.cwd();
  const cut = argv.indexOf("--");
  const own = cut === -1 ? argv : argv.slice(0, cut);
  const [command, ...rest] = own;
  switch (command) {
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
