import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addRun,
  checkSlot0,
  claimSlot,
  dropRow,
  goneRows,
  MAX_ACTIVE_SETS,
  tablePath as machineTablePath,
  projectOf,
  reapRows,
  registerMain,
  removeRun,
  type SetUp,
  type SlotTable,
  setsOf,
  withTable,
} from "../../../scripts/test-slots.mjs";
import { SITE } from "../scripts/lib/paths.ts";

// The slot table of the test servers (plan test-servers-per-worktree, Task 2).
// Every clone and every worktree on the machine shares one table.

const temp = mkdtempSync(join(tmpdir(), "authtempo-slots-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
/** A path for a new table file that no other test uses. */
const tablePath = () => join(temp, `slots-${++n}.json`);

const MAIN = "/repo/main";
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const empty = (): SlotTable => ({ version: 1, rows: [] });
/**
 * A claim of a linked worktree, or of a main worktree with `isMain`. `up` is
 * the double of the docker read: the sets that run, with their labels.
 */
const claim = (
  t: SlotTable,
  worktree: string,
  now = NOW,
  services = ["postgres"],
  isMain = worktree === MAIN,
  up: readonly SetUp[] = [],
) => claimSlot(t, { worktree, isMain, services, now, setsUp: () => up });
/** register-main in the main worktree MAIN. */
const register = (t: SlotTable, now = NOW) =>
  registerMain(t, { worktree: MAIN, isMain: true, now });
const alive = (pid: number) => pid === process.pid;

/** Runs the claim fixture in its own process and answers the slot it prints. */
function claimInProcess(table: string, worktree: string, ...rest: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [`${SITE}test/fixtures/test-slots-claim.mjs`, table, worktree, ...rest],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(err))));
  });
}

describe("the slot table of the test servers", () => {
  it("gives two slots to two claims at once from two worktrees", async () => {
    const table = tablePath();
    const slots = await Promise.all([
      claimInProcess(table, "/repo/lane-a"),
      claimInProcess(table, "/repo/lane-b"),
    ]);
    expect([...slots].sort()).toEqual(["1", "2"]);
    const rows = (JSON.parse(readFileSync(table, "utf8")) as SlotTable).rows;
    expect(rows.map((r) => [r.worktree, r.slot])).toEqual(
      expect.arrayContaining([
        ["/repo/lane-a", Number(slots[0])],
        ["/repo/lane-b", Number(slots[1])],
      ]),
    );
    expect(rows.length).toBe(2);
  });

  it("gives slot 0 only to the registered main worktree, and slot 1 up to any other path", () => {
    const t = empty();
    expect(register(t).slot).toBe(0);
    expect(claim(t, MAIN).slot).toBe(0);
    expect(claim(t, "/repo/lane-a").slot).toBe(1);
    // A second clone is the main worktree of its own repo.
    expect(claim(t, "/clone-2/main", NOW, ["postgres"], true).slot).toBe(2);
    expect(claim(t, "/repo/lane-b").slot).toBe(3);
  });

  it("never gives slot 0 to a git-init copy, also when no main is registered", () => {
    const t = empty();
    // A git-init copy is the main worktree of its own repo.
    expect(claim(t, "/scratch/copy", NOW, ["postgres"], true).slot).toBe(1);
    register(t);
    expect(claim(t, "/scratch/copy-2", NOW, ["postgres"], true).slot).toBe(2);
  });

  it("gives slot 0 to one path only, and never to a linked worktree", () => {
    const t = empty();
    expect(() => registerMain(t, { worktree: "/repo/lane-a", isMain: false, now: NOW })).toThrow(
      "/repo/lane-a is a linked worktree: slot 0 is for a main worktree",
    );
    register(t);
    expect(() => registerMain(t, { worktree: "/clone-2/main", isMain: true, now: NOW })).toThrow(
      "slot 0 belongs to /repo/main. Only one path holds slot 0",
    );
    claim(t, "/clone-3/main", NOW, ["postgres"], true);
    expect(t.rows.filter((r) => r.slot === 0).map((r) => r.worktree)).toEqual([MAIN]);
  });

  it("refuses a hand-written slot 0 row of a linked worktree", () => {
    // A person can edit the table by hand; this row sends a lane to the servers of main.
    const t: SlotTable = {
      version: 1,
      rows: [{ worktree: "/repo/lane-a", slot: 0, lastUse: NOW, services: ["postgres"], runs: [] }],
    };
    const refusal =
      "the slot table gives slot 0 to /repo/lane-a, which is a linked worktree. " +
      "Slot 0 is the running set of main only. Remove the row from the table";
    expect(() => claim(t, "/repo/lane-a")).toThrow(refusal);
    expect(() => checkSlot0(t.rows[0] as SlotTable["rows"][number], false)).toThrow(refusal);
  });

  it("keeps one table for the machine, in the cache folder of the user", () => {
    expect(machineTablePath("/Users/x")).toBe("/Users/x/.cache/authtempo/test-slots.json");
  });

  it("keeps the slot of a worktree and adds the services of a second claim", () => {
    const t = empty();
    claim(t, "/repo/lane-a", NOW - HOUR, ["postgres"]);
    const row = claim(t, "/repo/lane-a", NOW, ["mysql84", "postgres"]);
    expect(row).toEqual({
      worktree: "/repo/lane-a",
      slot: 1,
      lastUse: NOW,
      services: ["mysql84", "postgres"],
      runs: [],
    });
    expect(t.rows.length).toBe(1);
  });

  it("frees the slot of a removed worktree", () => {
    const t = empty();
    register(t);
    claim(t, "/repo/lane-a");
    claim(t, "/repo/lane-b");
    // git worktree remove of lane-a: the list no longer shows it.
    const gone = goneRows(t, [MAIN, "/repo/lane-b"]);
    expect(gone.map((r) => [r.worktree, r.slot])).toEqual([["/repo/lane-a", 1]]);
    for (const row of gone) dropRow(t, row.worktree);
    expect(claim(t, "/repo/lane-c").slot).toBe(1);
  });

  it("never reaps slot 0, also when it is idle for hours", () => {
    const t = empty();
    register(t, NOW - 5 * HOUR);
    claim(t, "/repo/lane-a", NOW - 5 * HOUR);
    claim(t, "/repo/lane-b", NOW - 60_000);
    const reaped = reapRows(t, {
      worktrees: [MAIN, "/repo/lane-a", "/repo/lane-b"],
      now: NOW,
      idleMs: 30 * 60_000,
      alive,
    });
    expect(reaped.map((r) => r.slot)).toEqual([1]);
    // A main path that the list does not show is still slot 0.
    expect(
      reapRows(t, { worktrees: [], now: NOW, idleMs: 30 * 60_000, alive }).map((r) => r.slot),
    ).toEqual([1, 2]);
    expect(goneRows(t, []).map((r) => r.slot)).toEqual([1, 2]);
  });

  it("never reaps a set while a test run of its worktree is alive", () => {
    const t = empty();
    claim(t, "/repo/lane-a", NOW - 5 * HOUR);
    addRun(t, "/repo/lane-a", process.pid);
    const opts = { worktrees: ["/repo/lane-a"], now: NOW, idleMs: 30 * 60_000, alive };
    expect(reapRows(t, opts)).toEqual([]);
    removeRun(t, "/repo/lane-a", process.pid);
    expect(reapRows(t, opts).map((r) => r.slot)).toEqual([1]);
  });

  it("refuses a set above the cap and names the idle sets that reap can remove", () => {
    expect(MAX_ACTIVE_SETS).toBe(8);
    const t = empty();
    register(t, NOW - 5 * HOUR);
    for (let i = 1; i <= 8; i++) claim(t, `/repo/lane-${i}`, i <= 2 ? NOW - 2 * HOUR : NOW);
    expect(() => claim(t, "/repo/lane-9")).toThrow(
      "8 test server sets are up, the cap. Run node scripts/test-servers.mjs reap to remove " +
        "the idle sets: slot 1 (/repo/lane-1, idle 120 min), slot 2 (/repo/lane-2, idle 120 min)",
    );
    // A worktree that holds a set already is not a new set.
    expect(claim(t, "/repo/lane-3").slot).toBe(3);
  });

  // Plan 12q decision 7. The table cannot see a set whose row is in no table
  // that it reads. That happens with a second HOME, a hand edit, or a row
  // dropped while its set runs. So the take of a new row also reads the sets
  // that docker runs.
  it("gives slot 2 to a second table when slot 1 is up under another worktree's label", () => {
    const up: SetUp[] = [];
    const take = (table: string, worktree: string) =>
      withTable(table, (t) =>
        claimSlot(t, {
          worktree,
          isMain: false,
          services: ["postgres"],
          now: NOW,
          setsUp: () => up,
        }),
      );
    // The first worktree takes slot 1 in its table, and its set comes up.
    expect(take(tablePath(), "/repo/lane-a").slot).toBe(1);
    up.push({ slot: 1, worktree: "/repo/lane-a" });
    // The second worktree reads another table, which has no row for slot 1.
    expect(take(tablePath(), "/repo/lane-b").slot).toBe(2);
  });

  it("takes the slot of its own set when its row is gone, and a row reads no set", () => {
    const t = empty();
    const up = [
      { slot: 1, worktree: "/repo/lane-a" },
      { slot: 2, worktree: "/elsewhere/clone" },
    ];
    // The set of lane-a runs on slot 1 under its own label: the take reuses it.
    expect(claim(t, "/repo/lane-a", NOW, ["postgres"], false, up).slot).toBe(1);
    // Slot 2 runs under another label, so the next new row skips it.
    expect(claim(t, "/repo/lane-b", NOW, ["postgres"], false, up).slot).toBe(3);
    // A worktree with a row keeps its slot, so the lock waits for no docker read.
    const read = () => {
      throw new Error("a claim with a row read the sets");
    };
    expect(
      claimSlot(t, {
        worktree: "/repo/lane-a",
        isMain: false,
        services: ["postgres"],
        now: NOW,
        setsUp: read,
      }).slot,
    ).toBe(1);
  });

  it("reads the slot and the worktree of each set from the lines of docker ps", () => {
    // One line for each container: the label of the worktree, a tab, the compose project.
    const lines = [
      "/repo/lane-a\tauthtempo-s1",
      "/repo/lane-a\tauthtempo-s1",
      "/elsewhere/clone\tauthtempo-s12",
      // A label with no value names no worktree, so its slot is not free.
      "\tauthtempo-s4",
      "/repo/lane-c\tsome-other-project",
      "",
    ].join("\n");
    expect(setsOf(lines)).toEqual([
      { slot: 1, worktree: "/repo/lane-a" },
      { slot: 12, worktree: "/elsewhere/clone" },
      { slot: 4, worktree: "" },
    ]);
  });

  it("names no compose project for slot 0", () => {
    expect(projectOf(1)).toBe("authtempo-s1");
    expect(projectOf(42)).toBe("authtempo-s42");
    expect(() => projectOf(0)).toThrow("slot 0 is the running set of main");
  });

  it("writes nothing when the change throws", () => {
    const table = tablePath();
    withTable(table, (t) => claim(t, "/repo/lane-a"));
    const before = readFileSync(table, "utf8");
    expect(() =>
      withTable(table, (t) => {
        claim(t, "/repo/lane-b");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(readFileSync(table, "utf8")).toBe(before);
  });

  it("takes over the lock of a dead process, and waits on the lock of a live one", () => {
    const table = tablePath();
    // A run that dies while it holds the lock leaves the lock folder with its pid.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout;
    mkdirSync(`${table}.lock`);
    writeFileSync(`${table}.lock/pid`, dead);
    expect(withTable(table, (t) => claim(t, "/repo/lane-a").slot, { waitMs: 2000 })).toBe(1);

    mkdirSync(`${table}.lock`);
    writeFileSync(`${table}.lock/pid`, String(process.pid));
    expect(() => withTable(table, () => 0, { waitMs: 200 })).toThrow(
      `the slot table ${table} is locked by pid ${process.pid}`,
    );
    rmSync(`${table}.lock`, { recursive: true });
  });

  it("takes over a dead lock once when two waiters read the same dead pid", async () => {
    const table = tablePath();
    const gateB = join(temp, `gate-b-${n}`);
    const gateA = join(temp, `gate-a-${n}`);
    mkdirSync(gateB);
    mkdirSync(gateA);
    // A passes its gate at once; the gate only marks when A holds the lock.
    writeFileSync(join(gateA, "go"), "");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout;
    mkdirSync(`${table}.lock`);
    writeFileSync(`${table}.lock/pid`, dead);
    const until = (file: string) =>
      expect.poll(() => existsSync(file), { timeout: 10_000, interval: 20 }).toBe(true);
    // Waiter B reads the dead pid, then stops at its gate before its takeover.
    const b = claimInProcess(table, "/repo/lane-b", "0", gateB);
    await until(join(gateB, "stale"));
    // Waiter A takes over the dead lock and holds it.
    const a = claimInProcess(table, "/repo/lane-a", "1500", gateA);
    await until(join(gateA, "held"));
    // B now meets the live lock of A where it read a dead pid.
    writeFileSync(join(gateB, "go"), "");
    const slots = await Promise.all([a, b]);
    expect(slots).toEqual(["1", "2"]);
    const rows = (JSON.parse(readFileSync(table, "utf8")) as SlotTable).rows;
    expect(rows.map((r) => [r.worktree, r.slot])).toEqual([
      ["/repo/lane-a", 1],
      ["/repo/lane-b", 2],
    ]);
  });
});
