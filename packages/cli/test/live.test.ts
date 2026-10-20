import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import {
  type ExampleWorker,
  START_LIMIT_MS,
  startExampleWorker,
} from "./support/example-worker.js";

// The binary against `wrangler dev` of examples/worker (plan 11c): the real
// network path that the Workers-pool test of the example cannot run.
// Each run starts its own Worker on a free port, with an operator secret of its own (plan 12e, review I1).
let worker: ExampleWorker | null = null;
beforeAll(async () => {
  assertFreshBuild();
  worker = await startExampleWorker();
}, START_LIMIT_MS + 30_000);
afterAll(async () => {
  await worker?.stop();
});
const base = () => worker?.base ?? "";
const secret = () => worker?.operatorSecret ?? "";

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
      env: { AUTHTEMPO_OPERATOR_SECRET: secret() },
    });
    expect(r.status, r.stderr).toBe(0);
    const kid = /^kid: (\S+)\n$/.exec(r.stdout)?.[1];
    expect(kid).toBeDefined();
    const after = await keyIds();
    expect(after[0]).toBe(kid);
    expect(after).toContain(before[0]);
    expect(r.stdout + r.stderr).not.toContain(secret());
  });

  it("reads the secret status of the example Worker, and exits 0", () => {
    const r = runBin(["secret", "status", base(), "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: secret() },
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
    expect(r.stdout + r.stderr).not.toContain(secret());
  });

  it("reseals on the example Worker until more is false, and exits 0", () => {
    const r = runBin(["secret", "rewrap", base(), "--yes", "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: secret() },
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
    expect(r.stdout + r.stderr).not.toContain(secret());
  });

  it("reports the example Worker with no secret value", () => {
    const r = runBin(["info", base(), "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: secret() },
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
    for (const s of [secret(), worker?.operatorHash ?? "", "localhost", String(worker?.port)])
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

// The user tools of plan 12f on a second Worker: a named secret with the scopes
// users and sessions, and OPERATOR_USERS "1" (plan 12f Task 12).
describe("the live runs of the operator user tools (plan 12f)", () => {
  let tools: ExampleWorker | null = null;
  beforeAll(async () => {
    tools = await startExampleWorker({ operatorUsers: true });
  }, START_LIMIT_MS + 30_000);
  afterAll(async () => {
    await tools?.stop();
  });

  it("bans and unbans a user of the example Worker", async () => {
    const at = tools?.base ?? "";
    const env = { AUTHTEMPO_OPERATOR_SECRET: tools?.operatorSecret ?? "" };
    const email = "live-ban@example.com";
    const post = (path: string, body: unknown) =>
      fetch(`${at}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: at },
        body: JSON.stringify(body),
      });
    await post("/password/sign-up", { email, password: "correct horse battery" });
    const signIn = () => post("/password/sign-in", { email, password: "correct horse battery" });
    expect((await signIn()).status).toBe(200);

    const found = runBin(["users", "search", at, "--email", email, "--json"], { env });
    expect(found.status, found.stderr).toBe(0);
    const users = (JSON.parse(found.stdout) as { users: { id: string; sessions: number }[] }).users;
    expect(users).toHaveLength(1);
    const id = users[0]?.id ?? "";
    expect(users[0]?.sessions).toBeGreaterThanOrEqual(1);
    expect(found.stderr).not.toContain(email);

    const ban = runBin(["users", "ban", at, id, "--reason", "live test", "--yes"], { env });
    expect(ban.status, ban.stderr).toBe(0);
    expect(ban.stdout).toMatch(new RegExp(`^banned ${id}; audit row \\S+\\n$`));
    const banned = runBin(["users", "get", at, id, "--json"], { env });
    const user = (JSON.parse(banned.stdout) as { user: { ban: unknown; sessions: number } }).user;
    expect(user.ban).toMatchObject({ reason: "live test", until: null });
    expect(user.sessions).toBe(0);
    expect((await signIn()).status).toBe(403);

    const unban = runBin(["users", "unban", at, id, "--reason", "live test", "--yes"], { env });
    expect(unban.status, unban.stderr).toBe(0);
    const lifted = runBin(["users", "get", at, id, "--json"], { env });
    expect((JSON.parse(lifted.stdout) as { user: { ban: unknown } }).user.ban).toBeNull();
    expect((await signIn()).status).toBe(200);
    for (const r of [found, ban, banned, unban, lifted])
      expect(r.stdout + r.stderr).not.toContain(tools?.operatorSecret ?? "-");
  });
});
