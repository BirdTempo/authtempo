import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import { OPERATOR_SECRET, startExampleWorker } from "./support/example-worker.js";

// The binary against `wrangler dev` of examples/worker (plan 11c): the real
// network path that the Workers-pool test of the example cannot run.
let worker: Awaited<ReturnType<typeof startExampleWorker>> | null = null;
beforeAll(async () => {
  assertFreshBuild();
  worker = await startExampleWorker(8797);
}, 180_000);
afterAll(async () => {
  await worker?.stop();
});
const base = () => worker?.base ?? "";

async function keyIds(): Promise<string[]> {
  const res = await fetch(`${base()}/auth/jwks`);
  return ((await res.json()) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
}

describe("the live runs (spec 19)", () => {
  it("passes each check against wrangler dev of the example Worker, and skips the schema check", () => {
    const r = runBin(["check", base()]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(linesOf(r.stdout).at(-1)).toBe("checks: 7 run, 6 pass, 0 fail, 1 skip");
  });

  it("exits 1 with --strict, because the schema check skips", () => {
    expect(runBin(["check", base(), "--strict"]).status).toBe(1);
  });

  it("rotates the signing key through the operator route, and prints the new kid only", async () => {
    const before = await keyIds();
    const r = runBin(["keys", "rotate", base(), "--yes"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: OPERATOR_SECRET },
    });
    expect(r.status, r.stderr).toBe(0);
    const kid = /^kid: (\S+)\n$/.exec(r.stdout)?.[1];
    expect(kid).toBeDefined();
    const after = await keyIds();
    expect(after[0]).toBe(kid);
    expect(after).toContain(before[0]);
    expect(r.stdout + r.stderr).not.toContain(OPERATOR_SECRET);
  });

  it("stops with exit 2 for a wrong operator secret", () => {
    const r = runBin(["keys", "rotate", base(), "--yes"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: "wrong-secret-wrong-secret-wrong-secret-00" },
    });
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr).at(-1)).toBe("stopped: the deployment refused the operator secret");
  });

  it("stops with exit 2 when no server answers", () => {
    const r = runBin(["check", "http://127.0.0.1:1"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr).at(-1)).toBe(
      "stopped: GET http://127.0.0.1:1/auth/session: no answer",
    );
  });
});
