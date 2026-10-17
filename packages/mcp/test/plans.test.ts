import { describe, expect, it } from "vitest";
import { isPlanError, PlanStore } from "../src/plans.js";

// The plan life from both sides (final review m1). Spec 21 item 6, the tool
// description, and reference/mcp.md promise 10 minutes. The times are typed
// here, never read from PLAN_TTL_MS.

const INPUT = { provider: "supabase", users: "users.csv" };
const FILES = { users: "a".repeat(64) };
const DATABASE = "b".repeat(64);

describe("PlanStore (plan 11e, the plan life)", () => {
  it("gives a plan at 600 000 ms, and refuses a plan at 600 001 ms with the unknown text", () => {
    let now = 0;
    const store = new PlanStore(() => now);
    const first = store.hold("import", INPUT, FILES, { created: 1 }, DATABASE);
    const second = store.hold("import", INPUT, FILES, { created: 2 }, DATABASE);

    now = 600_000;
    const held = store.take("import", first, INPUT, FILES, DATABASE);
    expect(isPlanError(held)).toBe(false);
    expect(held).toMatchObject({ kind: "import", report: { created: 1 }, at: 0 });

    now = 600_001;
    expect(store.take("import", second, INPUT, FILES, DATABASE)).toEqual({
      refused: "no held plan has this id; run migrate.plan again",
    });
  });
});
