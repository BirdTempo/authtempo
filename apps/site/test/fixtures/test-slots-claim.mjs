// One claim of a slot in its own process, for the lock tests of
// test/test-slots.test.ts. The hold keeps the lock while the other process
// tries to claim, so a missing lock gives both processes one slot.
//
//   node test-slots-claim.mjs <table> <worktree> [holdMs] [gate folder]
//
// With a gate folder, the claim writes <gate>/held while it holds the lock.
// When it reads the pid of a dead holder, it writes <gate>/stale and waits
// for <gate>/go before its takeover. So the test can order two waiters.
import { existsSync, writeFileSync } from "node:fs";
import { claimSlot, withTable } from "../../../../scripts/test-slots.mjs";

const [table, worktree, holdMs = "400", gate] = process.argv.slice(2);
if (table === undefined || worktree === undefined)
  throw new Error("usage: <table> <worktree> [holdMs] [gate folder]");
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
const row = withTable(
  table,
  (t) => {
    if (gate !== undefined) writeFileSync(`${gate}/held`, worktree);
    // No set runs: these tests hold the lock, not the docker read.
    return claimSlot(t, {
      worktree,
      isMain: false,
      services: ["postgres"],
      now: Date.now(),
      setsUp: () => [],
    });
  },
  {
    holdMs: Number(holdMs),
    onStale: () => {
      if (gate === undefined) return;
      writeFileSync(`${gate}/stale`, worktree);
      while (!existsSync(`${gate}/go`)) wait();
    },
  },
);
process.stdout.write(String(row.slot));
