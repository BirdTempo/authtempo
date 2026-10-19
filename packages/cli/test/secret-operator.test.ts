// `authtempo secret status` and `secret rewrap` (plan 11c2 Task 4). Each
// request goes to a real core handle over a real two-phase keyring, so each
// answer is an answer that core can give. Each state comes through the API,
// never by a row write.
import { createHash } from "node:crypto";
import {
  type Auth,
  createAuth,
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { REWRAP_LIMIT } from "@authtempo/core/secrets";
import { describe, expect, it } from "vitest";
import { SECRET_REWRAP_HELP, SECRET_STATUS_HELP } from "../src/help/secret.js";
import { SECRET_REWRAP_JSON_KEYS, SECRET_STATUS_JSON_KEYS } from "../src/json.js";
import { main } from "../src/main.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const STATUS = `${BASE}/auth/operator/secrets/status`;
const REWRAP = `${BASE}/auth/operator/secrets/rewrap`;
const SECRET = "operator-secret-0123456789abcdef-0123456789";
/** A wrong secret of the right form, so that only the hash refuses it. */
const WRONG = "operator-secret-wrong-wrong-wrong-wrong-wrong";
const S1 = "0123456789abcdef0123456789abcdef";
const S2 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
const ONE = [{ version: 1, value: S1 }];
const TWO = [
  { version: 2, value: S2 },
  { version: 1, value: S1 },
];
/** Phase 3: version 2 only, so the rows of version 1 are rows of a version that the config does not hold. */
const ONLY_TWO = [{ version: 2, value: S2 }];
const IP = "203.0.113.7";
const PW = "correct horse battery";
const MINUTE = 60_000;
/** A low cost, so that a test runs fast. */
const FAST = createPbkdf2PasswordHash({ iterations: 1000 });

type Secrets = Array<{ version: number; value: string }>;

/**
 * One storage, clock, limiter, and mail list. `on(secrets)` makes the handle
 * of one phase over them. `fetch(auth)` is the fetch of a fake io that sends
 * each request to the handle, with the IP that the limiter keys on.
 */
async function fixture() {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const clock = { now: () => current };
  const advance = (ms: number) => {
    current = new Date(current.getTime() + ms);
  };
  const storage = createMemoryAdapter();
  const limiter = createMemoryLimiter(clock);
  const mails: MailMessage[] = [];
  const secretHash = createHash("sha256").update(SECRET, "utf8").digest("hex");
  const on = (secrets: Secrets, operator = true): Auth =>
    createAuth({
      baseURL: BASE,
      trustedOrigins: ["https://app.example.com"],
      storage,
      mail: {
        send: async (m) => {
          mails.push(m);
        },
      },
      clock,
      limiter,
      secrets,
      // The detailed sign-up answer, so that the confirm mail carries the link.
      password: { hash: FAST, uniformSignUp: false },
      ...(operator ? { operator: { secretHash } } : {}),
    });
  const bodies: unknown[] = [];
  const fetch = (auth: Auth) => async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", IP);
    bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : null);
    return auth.handle(new Request(url, { ...init, headers }));
  };
  return { advance, mails, on, fetch, bodies };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Phase 1 through the API: a verified user with a password and a TOTP setup,
 * so one TOTP row sits under version 1. The setup's backup codes sit in that
 * row, and `status` counts the codes of an enabled factor only, so the count
 * stays 0. The first read of the key set writes the first signing key under
 * version 1 too.
 */
async function enroll(f: Fixture, auth: Auth, email: string): Promise<void> {
  const password = auth.api.password;
  if (!password) throw new Error("no password api");
  const up = await password.signUp({ email, password: PW, ip: null, userAgent: null });
  if (!up.ok || !("user" in up.value)) throw new Error("the sign-up gave no user");
  const confirm = f.mails.findLast((m) => m.to === email);
  const token = /token=([A-Za-z0-9_%-]+)/.exec(confirm?.text ?? "")?.[1];
  if (!token) throw new Error("no confirm mail");
  const verified = await password.verifyEmail({
    token: decodeURIComponent(token),
    ip: null,
    userAgent: null,
  });
  if (!verified.ok) throw new Error(`the verify answered ${verified.code}`);
  const totp = auth.api.totp;
  if (!totp) throw new Error("no totp api");
  const setup = await totp.setup({ userId: up.value.user.id, password: PW });
  if (!setup.ok) throw new Error(`the setup answered ${setup.code}`);
  const jwt = auth.api.jwt;
  if (!jwt) throw new Error("no jwt api");
  await jwt.jwks();
}

/**
 * A two-phase fixture: phase 1 enrolled under version 1, then 16 minutes, so
 * the setup is expired and a rewrap reseals it. The handle of phase 2 holds
 * versions 2 and 1.
 */
async function twoPhase(emails = ["ada@example.com"]) {
  const f = await fixture();
  const v1 = f.on(ONE);
  for (const email of emails) await enroll(f, v1, email);
  f.advance(16 * MINUTE);
  return { f, auth: f.on(TWO) };
}

async function run(args: string[], f: Fixture, auth: Auth, o: Parameters<typeof fakeIo>[0] = {}) {
  const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET }, fetch: f.fetch(auth), ...o });
  const code = await main(["secret", ...args], io);
  return { code, io };
}

/** The one JSON document of a `--json` run. */
function docOf(stdout: readonly string[]): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "") as Record<string, unknown>;
}

/** One direct call of the status route with a secret, from the IP of the tests. */
const guess = (auth: Auth, secret: string) =>
  auth.handle(
    new Request(STATUS, {
      headers: { "cf-connecting-ip": IP, authorization: `Operator ${secret}` },
    }),
  );

describe("authtempo secret status (plan 11c2)", () => {
  it("prints one line per version, and exits 0 when each version with rows is in the config", async () => {
    const { f, auth } = await twoPhase();
    const { code, io } = await run(["status", BASE], f, auth);
    expect(code).toBe(0);
    expect(io.stdout).toEqual([
      "version 2: current, configured, totpSecrets 0, backupCodes 0, signingKeys 0, emailCodes 0",
      "version 1: old, configured, totpSecrets 1, backupCodes 0, signingKeys 1, emailCodes 0",
    ]);
    expect(io.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${STATUS}`]);
    expect(io.requests[0]?.headers.get("authorization")).toBe(`Operator ${SECRET}`);
    expect(io.stderr).toContain(`reading ${STATUS}`);
    for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(SECRET);

    const json = await run(["status", BASE, "--json"], f, auth);
    expect(json.code).toBe(0);
    expect(docOf(json.io.stdout)).toEqual({
      versions: [
        {
          version: 2,
          configured: true,
          current: true,
          totpSecrets: 0,
          backupCodes: 0,
          signingKeys: 0,
          emailCodes: 0,
        },
        {
          version: 1,
          configured: true,
          current: false,
          totpSecrets: 1,
          backupCodes: 0,
          signingKeys: 1,
          emailCodes: 0,
        },
      ],
      exit: 0,
      stopped: null,
    });
  });

  it("exits 1 and warns when a version that the config does not hold has rows", async () => {
    const { f } = await twoPhase();
    const auth = f.on(ONLY_TWO);
    const { code, io } = await run(["status", BASE], f, auth);
    expect(code).toBe(1);
    expect(io.stdout).toEqual([
      "version 2: current, configured, totpSecrets 0, backupCodes 0, signingKeys 0, emailCodes 0",
      "version 1: old, not configured, totpSecrets 1, backupCodes 0, signingKeys 1, emailCodes 0",
    ]);
    expect(io.stderr.at(-1)).toBe(
      "warning: version 1 is not in the config but has rows; add it back before you remove it (spec 22 item 9)",
    );
    const json = await run(["status", BASE, "--json"], f, auth);
    expect(json.code).toBe(1);
    expect(docOf(json.io.stdout)).toMatchObject({ exit: 1, stopped: null });
  });

  it("stops when the answer is not a list of version counts", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    for (const body of [
      { versions: [{ version: "1" }] },
      { versions: [{ version: 1, configured: true, current: true }] },
      { versions: null },
      [],
    ]) {
      const { code, io } = await run(["status", BASE], f, auth, {
        fetch: async () => Response.json(body),
      });
      expect(code, JSON.stringify(body)).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.at(-1)).toBe(
        `stopped: GET ${STATUS} answered 200 with no list of version counts`,
      );
    }
  });
});

describe("authtempo secret rewrap (plan 11c2)", () => {
  it("reseals until more is false, prints the sums, and exits 0", async () => {
    const { f, auth } = await twoPhase();
    const { code, io } = await run(["rewrap", BASE, "--limit", "1", "--yes"], f, auth);
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["calls 2, resealed 2, failed 0, skipped 0, more false"]);
    expect(io.stderr).toContain("call 1: resealed 1, failed 0, skipped 0, more true");
    expect(io.stderr).toContain("call 2: resealed 1, failed 0, skipped 0, more false");
    expect(io.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${REWRAP}`,
      `POST ${REWRAP}`,
    ]);
    expect(io.requests[0]?.headers.get("authorization")).toBe(`Operator ${SECRET}`);
    expect(io.requests[0]?.headers.get("content-type")).toBe("application/json");
    // The second call sends the cursor of the first answer back (spec 22 item 6).
    expect(f.bodies[0]).toEqual({ limit: 1 });
    expect(f.bodies[1]).toMatchObject({ limit: 1 });
    expect((f.bodies[1] as { after: string }).after).toMatch(/^totp:/);
    for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(SECRET);

    const after = await run(["status", BASE, "--json"], f, auth);
    expect(after.code).toBe(0);
    expect((docOf(after.io.stdout).versions as unknown[])[1]).toEqual({
      version: 1,
      configured: true,
      current: false,
      totpSecrets: 0,
      backupCodes: 0,
      signingKeys: 0,
      emailCodes: 0,
    });
  });

  it("stops at --max-calls with more true, and exits 1", async () => {
    const { f, auth } = await twoPhase(["ada@example.com", "bo@example.com"]);
    const { code, io } = await run(
      ["rewrap", BASE, "--limit", "1", "--max-calls", "1", "--yes", "--json"],
      f,
      auth,
    );
    expect(code).toBe(1);
    expect(docOf(io.stdout)).toEqual({
      calls: 1,
      resealed: 1,
      failed: 0,
      skipped: 0,
      more: true,
      exit: 1,
      stopped: null,
    });
    expect(io.requests).toHaveLength(1);
    expect(io.stderr.at(-1)).toBe(
      "warning: the run reached --max-calls 1 with rows left; run it again",
    );
  });

  it("exits 1 when the pass ends with rows left, and names the skipped setups", async () => {
    // A live setup with codes is skipped until its 15 minutes pass (spec 22 item 6).
    const f = await fixture();
    await enroll(f, f.on(ONE), "ada@example.com");
    const auth = f.on(TWO);
    const { code, io } = await run(["rewrap", BASE, "--yes"], f, auth);
    expect(code).toBe(1);
    expect(io.stdout).toEqual(["calls 1, resealed 1, failed 0, skipped 1, more true"]);
    expect(io.stderr).toContain("call 1: resealed 1, failed 0, skipped 1, more true");
    expect(io.stderr.at(-1)).toBe(
      "warning: rows remain after the pass: 1 live setup was skipped; wait 15 minutes, then run it again",
    );
  });

  it("goes on past a page of skipped setups, and ends the pass at next null", async () => {
    // Two live setups with codes at the head of the totp table, and one
    // signing key behind them. A call that reseals 0 rows is not the end
    // (review of Task 4, Minor 1): the cursor moves the pass past the page.
    const f = await fixture();
    const v1 = f.on(ONE);
    await enroll(f, v1, "ada@example.com");
    f.advance(MINUTE);
    await enroll(f, v1, "bo@example.com");
    const auth = f.on(TWO);
    const { code, io } = await run(["rewrap", BASE, "--limit", "1", "--yes", "--json"], f, auth);
    expect(code).toBe(1);
    expect(docOf(io.stdout)).toEqual({
      calls: 4,
      resealed: 1,
      failed: 0,
      skipped: 2,
      more: true,
      exit: 1,
      stopped: null,
    });
    expect(io.stderr).toContain("call 1: resealed 0, failed 0, skipped 1, more true");
    expect(io.stderr).toContain("call 2: resealed 0, failed 0, skipped 1, more true");
    expect(io.stderr).toContain("call 3: resealed 1, failed 0, skipped 0, more true");
    expect(io.stderr).toContain("call 4: resealed 0, failed 0, skipped 0, more true");
    expect(io.stderr.at(-1)).toBe(
      "warning: rows remain after the pass: 2 live setups were skipped; wait 15 minutes, then run it again",
    );
    const afters = f.bodies.map((b) => (b as { after?: string }).after?.split(":")[0]);
    expect(afters).toEqual([undefined, "totp", "totp", "jwk"]);
    const after = await run(["status", BASE, "--json"], f, auth);
    expect((docOf(after.io.stdout).versions as unknown[])[1]).toMatchObject({
      version: 1,
      totpSecrets: 2,
      signingKeys: 0,
    });
  });

  it("makes no request with --no-input and no --yes", async () => {
    const { f, auth } = await twoPhase();
    const usage = "secret rewrap asks for a confirmation: give --yes when no person can answer";
    const plain = await run(["rewrap", BASE], f, auth);
    expect(plain.code).toBe(2);
    expect(plain.io.requests).toEqual([]);
    expect(plain.io.stderr[0]).toBe(usage);
    const noInput = await run(["rewrap", BASE, "--no-input"], f, auth, {
      stdinIsTTY: true,
      answer: true,
    });
    expect(noInput.code).toBe(2);
    expect(noInput.io.requests).toEqual([]);
    expect(noInput.io.stderr[0]).toBe(usage);
    const stdin = await run(["rewrap", BASE, "--token-file", "-"], f, auth, {
      env: {},
      stdin: SECRET,
      stdinIsTTY: true,
      answer: true,
    });
    expect(stdin.code).toBe(2);
    expect(stdin.io.requests).toEqual([]);
    expect(stdin.io.stderr[0]).toBe(
      "--token-file - reads the secret from stdin, so the command cannot ask: give --yes",
    );
    const no = await run(["rewrap", BASE], f, auth, { stdinIsTTY: true, answer: false });
    expect(no.code).toBe(2);
    expect(no.io.requests).toEqual([]);
    expect(no.io.stderr.at(-1)).toBe("stopped: no reseal: the answer was not yes");
    const yes = await run(["rewrap", BASE], f, auth, { stdinIsTTY: true, answer: true });
    expect(yes.code).toBe(0);
    expect(yes.io.requests).toHaveLength(1);
  });

  it("keeps the sums of the calls before a stop in the stop document", async () => {
    const { f, auth } = await twoPhase();
    const real = f.fetch(auth);
    let calls = 0;
    const { code, io } = await run(["rewrap", BASE, "--limit", "1", "--yes", "--json"], f, auth, {
      fetch: async (url, init) => {
        if (++calls === 2) return new Response("<html>", { status: 502 });
        return real(url, init);
      },
    });
    expect(code).toBe(2);
    expect(docOf(io.stdout)).toEqual({
      calls: 1,
      resealed: 1,
      failed: 0,
      skipped: 0,
      more: true,
      exit: 2,
      stopped: `POST ${REWRAP} answered 502 with no operator answer`,
    });
    expect(io.stderr.at(-1)).toBe(`stopped: POST ${REWRAP} answered 502 with no operator answer`);
  });
});

describe("the operator client of secret status and secret rewrap (plan 11c2)", () => {
  it("stops with exit 2 on a 404, a 401, and a 429, with the text of each", async () => {
    const f = await fixture();
    const off = f.on(ONE, false);
    const on = f.on(ONE);
    const cases: [string[], Auth, Record<string, string> | undefined, string][] = [
      [
        ["status", BASE],
        off,
        undefined,
        "the operator route is off, or core is older than 11c2: set operator.secretHash in the config of the deployment",
      ],
      [
        ["rewrap", BASE, "--yes"],
        off,
        undefined,
        "the operator route is off, or core is older than 11c2: set operator.secretHash in the config of the deployment",
      ],
      [
        ["status", BASE],
        on,
        { AUTHTEMPO_OPERATOR_SECRET: WRONG },
        "the deployment refused the operator secret",
      ],
      [
        ["rewrap", BASE, "--yes"],
        on,
        { AUTHTEMPO_OPERATOR_SECRET: WRONG },
        "the deployment refused the operator secret",
      ],
    ];
    for (const [args, auth, env, reason] of cases) {
      const { code, io } = await run(args, f, auth, env ? { env } : {});
      expect(code, args.join(" ")).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.at(-1), args.join(" ")).toBe(`stopped: ${reason}`);
    }
    // 120 guesses of the hour spend the count: the 121st call answers 429 with the right secret.
    const g = await fixture();
    const fresh = g.on(ONE);
    for (let n = 1; n <= 120; n++)
      expect((await guess(fresh, WRONG)).status, `guess ${n}`).toBe(401);
    for (const args of [
      ["status", BASE],
      ["rewrap", BASE, "--yes"],
    ]) {
      const { code, io } = await run(args, g, fresh);
      expect(code, args.join(" ")).toBe(2);
      expect(io.stderr.at(-1), args.join(" ")).toBe(
        "stopped: the operator routes allow 120 calls per IP per hour; wait, then run it again",
      );
    }
  });

  it("names the limit of core in the rewrap help", () => {
    // The help reads OPERATOR_SECRETS_PER_IP of core (ruling 16 of plan 11c2).
    expect(SECRET_REWRAP_HELP.exits.find((x) => x.code === 2)?.says).toContain(
      "the limit of 120 calls an hour",
    );
  });

  it("stops the read of an answer over 64 KiB at the cap, for status and for rewrap", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    for (const args of [
      ["status", BASE],
      ["rewrap", BASE, "--yes"],
    ]) {
      let sent = 0;
      // One MiB in all: the whole body is a proof that the reader read past the cap.
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 1024 * 1024) controller.close();
          else {
            controller.enqueue(chunk);
            sent += chunk.byteLength;
          }
        },
      });
      const { code, io } = await run(args, f, auth, {
        fetch: async () =>
          new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      });
      expect(code, args.join(" ")).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.at(-1), args.join(" ")).toBe("stopped: the answer is larger than 64 KiB");
      // The reader cancels the stream on the chunk that passes 64 KiB. The
      // stream queues one chunk ahead of the reader, so two chunks at most.
      expect(sent, args.join(" ")).toBeGreaterThan(64 * 1024);
      expect(sent, args.join(" ")).toBeLessThanOrEqual(64 * 1024 + 2 * chunk.byteLength);
    }
  });

  it("stops on another status or a body that is not JSON, and follows no redirect", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    const other = await run(["status", BASE], f, auth, {
      fetch: async () => new Response("<html>", { status: 500 }),
    });
    expect(other.code).toBe(2);
    expect(other.io.stderr.at(-1)).toBe(
      `stopped: GET ${STATUS} answered 500 with no operator answer`,
    );
    const text = await run(["status", BASE], f, auth, {
      fetch: async () => new Response("not json", { status: 200 }),
    });
    expect(text.code).toBe(2);
    expect(text.io.stderr.at(-1)).toBe(
      `stopped: GET ${STATUS} answered 200 with no operator answer`,
    );
    const inits: RequestInit[] = [];
    const redirect = await run(["rewrap", BASE, "--yes"], f, auth, {
      fetch: async (_url, init) => {
        inits.push(init);
        return new Response(null, {
          status: 307,
          headers: { location: "https://evil.example.net/rewrap" },
        });
      },
    });
    expect(redirect.code).toBe(2);
    expect(redirect.io.stdout).toEqual([]);
    expect(redirect.io.stderr.at(-1)).toBe(
      `stopped: POST ${REWRAP} answered 307, a redirect: the CLI follows no redirect`,
    );
    expect(inits.map((i) => i.redirect)).toEqual(["manual"]);
  });

  it("refuses an http base off this machine before any request", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    const bad = "http://203.0.113.9";
    for (const args of [
      ["status", bad],
      ["rewrap", bad, "--yes"],
    ]) {
      const { code, io } = await run(args, f, auth);
      expect(code, args.join(" ")).toBe(2);
      expect(io.requests).toEqual([]);
      expect(io.stderr[0]).toBe(
        `${bad} must use https: http is for localhost, 127.0.0.1, or [::1] only`,
      );
    }
    const local = await run(["status", "http://127.0.0.1:8787"], f, auth);
    expect(local.io.requests[0]?.url).toBe("http://127.0.0.1:8787/auth/operator/secrets/status");
  });

  it("refuses a secret that is not 32 to 512 visible ASCII characters, before any request", async () => {
    const f = await fixture();
    const auth = f.on(ONE);
    for (const args of [
      ["status", BASE],
      ["rewrap", BASE, "--yes"],
    ]) {
      const { code, io } = await run(args, f, auth, {
        env: { AUTHTEMPO_OPERATOR_SECRET: "x".repeat(31) },
      });
      expect(code, args.join(" ")).toBe(2);
      expect(io.requests).toEqual([]);
      expect(io.stderr[0]).toBe(
        "the operator secret is 32 to 512 visible ASCII characters; the deployment refuses any other value",
      );
    }
  });

  it("holds each document to its key list, and --limit to REWRAP_LIMIT.max", async () => {
    const { f, auth } = await twoPhase();
    const status = await run(["status", BASE, "--json"], f, auth);
    expect(Object.keys(docOf(status.io.stdout)).sort()).toEqual(
      Object.keys(SECRET_STATUS_JSON_KEYS).sort(),
    );
    const rewrap = await run(["rewrap", BASE, "--yes", "--json"], f, auth);
    expect(Object.keys(docOf(rewrap.io.stdout)).sort()).toEqual(
      Object.keys(SECRET_REWRAP_JSON_KEYS).sort(),
    );
    // The help names the limit of core (spec 22 item 6): 1000 rows in one call.
    expect(REWRAP_LIMIT.max).toBe(1000);
    const limit = SECRET_REWRAP_HELP.flags.find((x) => x.flag === "--limit <n>");
    expect(limit?.says).toContain("from 1 to 1000");
    for (const [flag, bad, line] of [
      ["--limit", "0", "--limit is a whole number from 1 to 1000"],
      ["--limit", "1001", "--limit is a whole number from 1 to 1000"],
      ["--limit", "1.5", "--limit is a whole number from 1 to 1000"],
      ["--max-calls", "0", "--max-calls is a whole number from 1 to 10000"],
      ["--max-calls", "10001", "--max-calls is a whole number from 1 to 10000"],
    ]) {
      const { code, io } = await run(["rewrap", BASE, "--yes", flag ?? "", bad ?? ""], f, auth);
      expect(code, `${flag} ${bad}`).toBe(2);
      expect(io.requests).toEqual([]);
      expect(io.stderr[0]).toBe(line);
    }
    expect(SECRET_STATUS_HELP.command).toBe("secret status");
    expect(SECRET_REWRAP_HELP.command).toBe("secret rewrap");
  });

  it("names the subcommands for another positional, and keeps the generator for none", async () => {
    const f = await fixture();
    const { code, io } = await run(["nonsense"], f, f.on(ONE));
    expect(code).toBe(2);
    expect(io.stderr[0]).toBe("secret has the subcommands status and rewrap, or no positional");
    expect(io.requests).toEqual([]);
    const bare = await run([], f, f.on(ONE));
    expect(bare.code).toBe(0);
    expect(bare.io.stdout).toHaveLength(1);
  });
});
