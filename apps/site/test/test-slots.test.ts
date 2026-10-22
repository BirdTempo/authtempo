import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addRun,
  claimSlot,
  dropRow,
  goneRows,
  MAX_ACTIVE_SETS,
  projectOf,
  reapRows,
  removeRun,
  type SlotTable,
  withTable,
} from "../../../scripts/test-slots.mjs";
import { SITE } from "../scripts/lib/paths.ts";

// The slot table of the test servers (plan test-servers-per-worktree, Task 2).
// Every worktree of the repo shares one table in the git common directory.

const temp = mkdtempSync(join(tmpdir(), "authtempo-slots-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
/** A path for a new table file that no other test uses. */
const tablePath = () => join(temp, `slots-${++n}.json`);

const MAIN = "/repo/main";
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const empty = (): SlotTable => ({ version: 1, rows: [] });
const claim = (t: SlotTable, worktree: string, now = NOW, services = ["postgres"]) =>
  claimSlot(t, { worktree, main: MAIN, services, now });
const alive = (pid: number) => pid === process.pid;

/** Runs the claim fixture in its own process and answers the slot it prints. */
function claimInProcess(table: string, worktree: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [`${SITE}test/fixtures/test-slots-claim.mjs`, table, worktree],
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

  it("gives slot 0 to the main worktree and slot 1 to the first other worktree", () => {
    const t = empty();
    expect(claim(t, MAIN).slot).toBe(0);
    expect(claim(t, "/repo/lane-a").slot).toBe(1);
    expect(claim(t, "/repo/lane-b").slot).toBe(2);
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
    claim(t, MAIN);
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
    claim(t, MAIN, NOW - 5 * HOUR);
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
    claim(t, MAIN, NOW - 5 * HOUR);
    for (let i = 1; i <= 8; i++) claim(t, `/repo/lane-${i}`, i <= 2 ? NOW - 2 * HOUR : NOW);
    expect(() => claim(t, "/repo/lane-9")).toThrow(
      "8 test server sets are up, the cap. Run node scripts/test-servers.mjs reap to remove " +
        "the idle sets: slot 1 (/repo/lane-1, idle 120 min), slot 2 (/repo/lane-2, idle 120 min)",
    );
    // A worktree that holds a set already is not a new set.
    expect(claim(t, "/repo/lane-3").slot).toBe(3);
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
});
