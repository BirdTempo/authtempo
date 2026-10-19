import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import {
  OPERATOR_HASH,
  OPERATOR_SECRET,
  START_LIMIT_MS,
  startExampleWorker,
} from "./support/example-worker.js";

// The binary against `wrangler dev` of examples/worker (plan 11c): the real
// network path that the Workers-pool test of the example cannot run.
let worker: Awaited<ReturnType<typeof startExampleWorker>> | null = null;
beforeAll(async () => {
  assertFreshBuild();
  worker = await startExampleWorker(8797);
}, START_LIMIT_MS + 30_000);
afterAll(async () => {
  await worker?.stop();
});
const base = () => worker?.base ?? "";

async function keyIds(): Promise<string[]> {
  const res = await fetch(`${base()}/auth/jwks`);
  return ((await res.json()) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
}

describe("the live runs (spec 19)", () => {
  it("passes each check against wrangler dev of the example Worker, and skips the schema checks", () => {
    const r = runBin(["check", base()]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(linesOf(r.stdout).at(-1)).toBe("checks: 8 run, 6 pass, 0 fail, 2 skip");
  });

  it("exits 1 with --strict, because the schema checks skip", () => {
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

  it("reads the secret status of the example Worker, and exits 0", () => {
    const r = runBin(["secret", "status", base(), "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: OPERATOR_SECRET },
    });
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      versions: { version: number; configured: boolean; current: boolean; signingKeys: number }[];
      exit: number;
      stopped: string | null;
    };
    // The example holds one secret, `secret: env.AUTH_SECRET`, which is version 1.
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]).toMatchObject({ version: 1, configured: true, current: true });
    expect(doc.versions[0]?.signingKeys).toBeGreaterThanOrEqual(1);
    expect(doc).toMatchObject({ exit: 0, stopped: null });
    expect(r.stdout + r.stderr).not.toContain(OPERATOR_SECRET);
  });

  it("reseals on the example Worker until more is false, and exits 0", () => {
    const r = runBin(["secret", "rewrap", base(), "--yes", "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: OPERATOR_SECRET },
    });
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(doc).toMatchObject({
      calls: 1,
      failed: 0,
      skipped: 0,
      more: false,
      exit: 0,
      stopped: null,
    });
    expect(r.stdout + r.stderr).not.toContain(OPERATOR_SECRET);
  });

  it("reports the example Worker with no secret value", () => {
    const r = runBin(["info", base(), "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: OPERATOR_SECRET },
    });
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      deployment: {
        core: string;
        schemaVersion: number;
        configKeys: string[];
        dropped: number;
      } | null;
      unread: unknown[];
      exit: number;
      stopped: string | null;
    };
    expect(doc.deployment?.configKeys).toContain("operator.secretHash");
    expect(doc.deployment?.configKeys).toContain("secret");
    expect(doc.deployment?.dropped).toBe(0);
    expect(doc.deployment?.core).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc).toMatchObject({ unread: [], exit: 0, stopped: null });
    // No secret, no hash, and no host of the person's own base URL.
    for (const s of [OPERATOR_SECRET, OPERATOR_HASH, "localhost", "8797"])
      expect(r.stdout + r.stderr, s).not.toContain(s);
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
