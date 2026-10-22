// The slot table of the test servers (design
// docs/superpowers/specs/2026-10-22-test-servers-per-worktree-design.md).
// One JSON file for the machine, keyed by the real path of each worktree. The
// compose projects and the ports are global on the machine. A table for each
// clone gave slot 1 to the first lane of each clone, so two clones shared one
// set (review of 2026-10-22, M1). A lock guards each change, so
// two worktrees cannot take one slot. scripts/test-servers.mjs is the only
// caller in the repo.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_SLOT, SERVICES } from "./test-ports.mjs";

/** Slot 0 is the whole running set of docker-compose.yml. */
const SLOT_0_SERVICES = SERVICES.map((s) => s.name).sort();

/**
 * The path of the table of the machine, in the cache folder of the user. Every
 * clone and every worktree on the machine reads this one file.
 * @param {string} [home] the home folder; the tests give a folder of their own
 */
export function tablePath(home = homedir()) {
  return join(home, ".cache", "authtempo", "test-slots.json");
}

/**
 * The cap of sets of slots 1 and up. The lead runs at most 8 agents, so at
 * most 8 worktrees run tests at one time (design, 2026-10-22). One set used
 * 0.6 GB idle and 1.4 GB at the peak of a full test and typecheck run
 * (docker stats, 2026-10-22 21:13 CST, load 33). So 8 sets at their peak and
 * the slot 0 set (1.4 GB) fit in the 15.7 GB of Docker. Raise the cap only
 * with the agent limit and a new memory count.
 */
export const MAX_ACTIVE_SETS = 8;

/** A set with no use for this time is idle, and reap removes it. The first value of the design. */
export const IDLE_MS = 30 * 60 * 1000;

/** The longest wait for the lock. An up of another worktree holds it for a short write only. */
const LOCK_WAIT_MS = 2 * 60 * 1000;

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

/** A name that no other process uses, beside the lock. */
const uniqueName = (/** @type {string} */ lock, /** @type {string} */ kind) =>
  `${lock}.${kind}-${process.pid}-${Math.random().toString(36).slice(2)}`;

/** @param {string} folder */
function pidIn(folder) {
  try {
    return Number(readFileSync(`${folder}/pid`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Takes the lock folder `<path>.lock`. Node has no flock. The folder is made
 * with the pid of its holder inside under a unique name, then renamed to the
 * lock name. A rename onto a folder that is not empty fails on one file
 * system, so a lock folder always holds its pid.
 *
 * The lock of a dead process is taken over. Two waiters can read the same
 * dead pid. The first takes over and holds the lock; the second then must not
 * remove the live lock of the first (review of 2026-10-22, m5). So a waiter
 * renames the lock folder to a unique name and reads the pid inside it. It
 * removes only that name, and only when the pid is the dead one. Else the
 * folder is a live lock, and it goes back to the lock name.
 * @param {string} lock
 * @param {number} waitMs
 * @param {() => void} onStale runs after a dead pid is read, for the lock test only
 */
function takeLock(lock, waitMs, onStale) {
  const until = Date.now() + waitMs;
  for (;;) {
    const mine = uniqueName(lock, "new");
    mkdirSync(mine);
    writeFileSync(`${mine}/pid`, String(process.pid));
    try {
      renameSync(mine, lock);
      return;
    } catch (e) {
      rmSync(mine, { recursive: true, force: true });
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
    }
    const holder = pidIn(lock);
    if (holder !== null && !pidAlive(holder)) {
      onStale();
      const stale = uniqueName(lock, "stale");
      try {
        renameSync(lock, stale);
      } catch {
        continue; // The lock is gone: another waiter took it over.
      }
      if (pidIn(stale) === holder) rmSync(stale, { recursive: true, force: true });
      else
        try {
          renameSync(stale, lock);
        } catch {
          // A third process took the lock in the moment that the name was free.
          // Two processes then hold a lock. This needs a dead holder, three
          // waiters, and a gap of microseconds, so the script accepts it.
          rmSync(stale, { recursive: true, force: true });
        }
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
 * Frees the lock, when this process still holds it.
 * @param {string} lock
 */
function freeLock(lock) {
  if (pidIn(lock) === process.pid) rmSync(lock, { recursive: true, force: true });
}

/**
 * Runs `change` on the table under the lock, then writes the table. When
 * `change` throws, nothing is written. `holdMs` keeps the lock after the
 * change, and `onStale` runs before a takeover, for the lock tests only.
 * @template T
 * @param {string} path
 * @param {(table: SlotTable) => T} change
 * @param {{ holdMs?: number, waitMs?: number, onStale?: () => void }} [opts]
 * @returns {T}
 */
export function withTable(path, change, opts = {}) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  takeLock(lock, opts.waitMs ?? LOCK_WAIT_MS, opts.onStale ?? (() => {}));
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
    freeLock(lock);
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
 * Refuses a slot 0 row of a worktree that is not the main worktree of its
 * repo. Only register-main writes a slot 0 row, so this row is a hand edit.
 * It sends the tests of a lane to the servers of main (review m2).
 * @param {SlotRow} row
 * @param {boolean} isMain
 */
export function checkSlot0(row, isMain) {
  if (row.slot === 0 && !isMain)
    throw new Error(
      `the slot table gives slot 0 to ${row.worktree}, which is a linked worktree. ` +
        "Slot 0 is the running set of main only. Remove the row from the table",
    );
}

/**
 * Takes or reuses the slot of a worktree, and adds the services to its row.
 * A new row takes the lowest free slot from 1, also in a main worktree: slot 0
 * comes only from registerMain. A new set above MAX_ACTIVE_SETS is refused.
 * @param {SlotTable} table
 * @param {{ worktree: string, isMain: boolean, services: readonly string[], now: number }} claim
 * @returns {SlotRow}
 */
export function claimSlot(table, { worktree, isMain, services, now }) {
  let row = rowOf(table, worktree);
  if (row === undefined) {
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
    let slot = 1;
    while (taken.has(slot)) slot++;
    if (slot > MAX_SLOT) throw new Error(`no free slot from 1 to ${MAX_SLOT}`);
    row = { worktree, slot, lastUse: now, services: [], runs: [] };
    table.rows.push(row);
  }
  checkSlot0(row, isMain);
  row.services = [...new Set([...row.services, ...services])].sort();
  row.lastUse = now;
  return row;
}

/**
 * Gives slot 0, the running set of docker-compose.yml, to one main worktree
 * of the machine. A person runs it once in that worktree. Slot 0 goes to no
 * other path: a linked worktree, a second clone, and a git-init copy each
 * take slot 1 or higher.
 * @param {SlotTable} table
 * @param {{ worktree: string, isMain: boolean, now: number }} claim
 * @returns {SlotRow}
 */
export function registerMain(table, { worktree, isMain, now }) {
  if (!isMain) throw new Error(`${worktree} is a linked worktree: slot 0 is for a main worktree`);
  const holder = table.rows.find((r) => r.slot === 0);
  if (holder !== undefined && holder.worktree !== worktree)
    throw new Error(`slot 0 belongs to ${holder.worktree}. Only one path holds slot 0`);
  const row = rowOf(table, worktree);
  if (row !== undefined && row.slot !== 0)
    throw new Error(
      `${worktree} holds slot ${row.slot}. Run node scripts/test-servers.mjs down first`,
    );
  if (row !== undefined) return row;
  const slot0 = {
    worktree,
    slot: 0,
    lastUse: now,
    services: SLOT_0_SERVICES.slice(),
    runs: [],
  };
  table.rows.push(slot0);
  return slot0;
}

/**
 * The rows of slots 1 and up whose worktree is not in `worktrees`, the live
 * worktrees of the rows. The table holds the rows of every clone on the
 * machine, so the caller checks each row path, not one `git worktree list`.
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
