import { applyD1Migrations, createScheduledController, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_EXPORTS } from "../../src/testing.js";
import { runImport } from "../../worker/src/run.js";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The verify bundle on D1 (plan 11f Task 4; spec 23 item 7). The pool gives
// this file its own database, so the first verify runs on an empty one. The
// Supabase fixture of `src/testing.ts` is clean: both hashes are in its
// formats, so a real run gives exit 0, and the verify after it holds.

const SUPABASE = FIXTURE_EXPORTS.supabase;
const VERIFY = { dryRun: true, formats: [...SUPABASE.formats] };
const REAL = { formats: [...SUPABASE.formats] };

async function userRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM ta_user").first<{ n: number }>();
  return row?.n ?? -1;
}

/** Runs the Worker on an input in place of the sample module, and answers its one log line. */
async function logLine(input: unknown): Promise<Record<string, unknown>> {
  vi.resetModules();
  vi.doMock("authtempo-import-input", () => ({ default: input }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const fresh = (await import("../../worker/src/index.js")).default;
    await fresh.scheduled(createScheduledController(), { ...env, LOCAL_IMPORT: "1" });
    expect(log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
  } finally {
    log.mockRestore();
    vi.doUnmock("authtempo-import-input");
    vi.resetModules();
  }
}

describe("the verify bundle on core's D1 adapter", () => {
  it("logs the verify of a verify bundle", async () => {
    expect(await userRows()).toBe(0);
    const before = await logLine({ bundle: SUPABASE.bundle, options: VERIFY, verify: true });
    expect(before.verify).toMatchObject({ held: false, partial: 0, needPerson: 0, code: 1 });
    expect((before.verify as { wouldWrite: number }).wouldWrite).toBeGreaterThan(0);
    expect(before.status).toBe(1);
    expect(await userRows()).toBe(0);

    // The real run of the same bundle, with no verify field: the log holds verify null.
    const real = await logLine({ bundle: SUPABASE.bundle, options: REAL });
    expect(real.verify).toBeNull();
    expect(real.status).toBe(0);
    expect(await userRows()).toBe(2);

    const after = await logLine({ bundle: SUPABASE.bundle, options: VERIFY, verify: true });
    expect(after.verify).toEqual({
      held: true,
      wouldWrite: 0,
      partial: 0,
      needPerson: 0,
      code: 0,
    });
    expect(after.status).toBe(0);
    expect(await userRows()).toBe(2);
  });

  it("refuses a verify field that is not true or false", async () => {
    const rows = await userRows();
    await expect(
      runImport(env.DB, { bundle: SUPABASE.bundle, options: VERIFY, verify: "yes" }),
    ).rejects.toThrow(
      "authtempo import: the D1 input field verify is not true or false; nothing was written",
    );
    // A verify bundle reads only, so one without the dry run is refused before any read.
    await expect(
      runImport(env.DB, { bundle: SUPABASE.bundle, options: REAL, verify: true }),
    ).rejects.toThrow(
      "authtempo import: the D1 input field verify needs options.dryRun true; nothing was written",
    );
    expect(await userRows()).toBe(rows);
  });
});
