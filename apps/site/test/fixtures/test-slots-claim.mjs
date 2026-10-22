// One claim of a slot in its own process, for the lock test of
// test/test-slots.test.ts. The hold keeps the lock while the other process
// tries to claim, so a missing lock gives both processes one slot.
import { claimSlot, withTable } from "../../../../scripts/test-slots.mjs";

const [table, worktree] = process.argv.slice(2);
if (table === undefined || worktree === undefined) throw new Error("usage: <table> <worktree>");
const row = withTable(
  table,
  (t) => claimSlot(t, { worktree, main: "/repo/main", services: ["postgres"], now: Date.now() }),
  { holdMs: 400 },
);
process.stdout.write(String(row.slot));
