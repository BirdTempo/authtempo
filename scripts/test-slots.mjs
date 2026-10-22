// The slot table of the test servers (design
// docs/superpowers/specs/2026-10-22-test-servers-per-worktree-design.md).
// One JSON file in the git common directory, shared by every worktree of the
// repo and never tracked. A lock guards each change, so two worktrees cannot
// take one slot. scripts/test-servers.mjs is the only caller in the repo.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { MAX_SLOT } from "./test-ports.mjs";

/** The file name of the table in `git rev-parse --git-common-dir`. */
export const TABLE_FILE = "authtempo-test-slots.json";

/**
 * The cap of sets of slots 1 and up. The lead runs at most 8 agents, so at
 * most 8 worktrees run tests at one time (design, 2026-10-22). A tuned set
 * needs about 0.8 GB, so 8 sets and the slot 0 set (1.4 GB) fit in the
 * 15.7 GB of Docker. Raise it only with the agent limit and a new memory count.
 */
export const MAX_ACTIVE_SETS = 8;

/** A set with no use for this time is idle, and reap removes it. The first value of the design. */
export const IDLE_MS = 30 * 60 * 1000;

/** The longest wait for the lock. An up of another worktree holds it for a short write only. */
const LOCK_WAIT_MS = 2 * 60 * 1000;
/** A lock folder with no pid file for this time is stale: its holder died between mkdir and the write. */
const LOCK_NO_PID_MS = 30 * 1000;

/**
 * @typedef {{ worktree: string, slot: number, lastUse: number, services: string[], runs: number[] }} SlotRow
 * @typedef {{ version: 1, rows: SlotRow[] }} SlotTable
 */

/**
 * The compose project of a slot. Slot 0 is the running set of main, which
 * docker-compose.yml runs and no script manages, so it has none.
 * @param {number} slot
 * @returns {string}
 */
export function projectOf(slot) {
  if (slot === 0) throw new Error("slot 0 is the running set of main: no script manages it");
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT)
    throw new Error(`slot ${slot} is outside 1 to ${MAX_SLOT}`);
  return `authtempo-s${slot}`;
}

/** @param {number} pid */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, under another user.
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Takes the lock folder `<path>.lock`. mkdir is atomic on one file system, and
 * Node has no flock. The folder holds the pid of its holder, so the lock of a
 * dead process is taken over.
 * @param {string} lock
 * @param {number} waitMs
 */
function takeLock(lock, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(`${lock}/pid`, String(process.pid));
      return;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
    }
    /** @type {number | null} */
    let holder = null;
    try {
      holder = Number(readFileSync(`${lock}/pid`, "utf8"));
    } catch {
      // No pid file yet: the holder is between mkdir and its write, or died there.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_NO_PID_MS)
          rmSync(lock, { recursive: true, force: true });
      } catch {}
    }
    if (holder !== null && !pidAlive(holder)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= until)
      throw new Error(
        `the slot table ${lock.slice(0, -".lock".length)} is locked by pid ${holder}`,
      );
    sleep(50);
  }
}

/**
 * Runs `change` on the table under the lock, then writes the table. When
 * `change` throws, nothing is written. `holdMs` keeps the lock after the
 * change, for the lock test only.
 * @template T
 * @param {string} path
 * @param {(table: SlotTable) => T} change
 * @param {{ holdMs?: number, waitMs?: number }} [opts]
 * @returns {T}
 */
export function withTable(path, change, opts = {}) {
  const lock = `${path}.lock`;
  takeLock(lock, opts.waitMs ?? LOCK_WAIT_MS);
  try {
    /** @type {SlotTable} */
    let table = { version: 1, rows: [] };
    try {
      table = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
    }
    const result = change(table);
    if (opts.holdMs !== undefined) sleep(opts.holdMs);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(table, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * @param {SlotTable} table
 * @param {string} worktree
 */
export function rowOf(table, worktree) {
  return table.rows.find((r) => r.worktree === worktree);
}

/**
 * The idle sets of slots 1 and up, as `reap` sees them.
 * @param {SlotTable} table
 * @param {number} now
 */
function idleText(table, now) {
  return table.rows
    .filter((r) => r.slot !== 0 && r.runs.length === 0 && now - r.lastUse > IDLE_MS)
    .map((r) => `slot ${r.slot} (${r.worktree}, idle ${Math.floor((now - r.lastUse) / 60000)} min)`)
    .join(", ");
}

/**
 * Takes or reuses the slot of a worktree, and adds the services to its row.
 * The main worktree has slot 0. Any other worktree takes the lowest free slot
 * from 1, and a new set above MAX_ACTIVE_SETS is refused.
 * @param {SlotTable} table
 * @param {{ worktree: string, main: string, services: readonly string[], now: number }} claim
 * @returns {SlotRow}
 */
export function claimSlot(table, { worktree, main, services, now }) {
  let row = rowOf(table, worktree);
  if (row === undefined) {
    let slot = 0;
    if (worktree !== main) {
      const active = table.rows.filter((r) => r.slot !== 0);
      if (active.length >= MAX_ACTIVE_SETS) {
        const idle = idleText(table, now);
        throw new Error(
          `${active.length} test server sets are up, the cap. ` +
            (idle === ""
              ? "No set is idle: wait for a run to end, or remove a set with down in its worktree"
              : `Run node scripts/test-servers.mjs reap to remove the idle sets: ${idle}`),
        );
      }
      const taken = new Set(table.rows.map((r) => r.slot));
      slot = 1;
      while (taken.has(slot)) slot++;
      if (slot > MAX_SLOT) throw new Error(`no free slot from 1 to ${MAX_SLOT}`);
    }
    row = { worktree, slot, lastUse: now, services: [], runs: [] };
    table.rows.push(row);
  }
  row.services = [...new Set([...row.services, ...services])].sort();
  row.lastUse = now;
  return row;
}

/**
 * The rows of slots 1 and up whose worktree `git worktree list` no longer shows.
 * @param {SlotTable} table
 * @param {readonly string[]} worktrees
 */
export function goneRows(table, worktrees) {
  return table.rows.filter((r) => r.slot !== 0 && !worktrees.includes(r.worktree));
}

/**
 * The rows that reap removes: a worktree that is gone, or a set idle for more
 * than `idleMs`. Never slot 0, and never a set with a live test run.
 * @param {SlotTable} table
 * @param {{ worktrees: readonly string[], now: number, idleMs: number, alive: (pid: number) => boolean }} opts
 */
export function reapRows(table, { worktrees, now, idleMs, alive }) {
  return table.rows.filter((r) => {
    if (r.slot === 0) return false;
    if (r.runs.some(alive)) return false;
    return !worktrees.includes(r.worktree) || now - r.lastUse > idleMs;
  });
}

/**
 * @param {SlotTable} table
 * @param {string} worktree
 */
export function dropRow(table, worktree) {
  table.rows = table.rows.filter((r) => r.worktree !== worktree);
}

/**
 * Marks a test run of the worktree, so reap leaves its set.
 * @param {SlotTable} table
 * @param {string} worktree
 * @param {number} pid
 */
export function addRun(table, worktree, pid) {
  const row = rowOf(table, worktree);
  if (row === undefined) throw new Error(`no slot for ${worktree}`);
  row.runs = [...row.runs.filter(pidAlive), pid];
}

/**
 * @param {SlotTable} table
 * @param {string} worktree
 * @param {number} pid
 */
export function removeRun(table, worktree, pid) {
  const row = rowOf(table, worktree);
  if (row !== undefined) row.runs = row.runs.filter((p) => p !== pid);
}
