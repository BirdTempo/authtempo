// The operator commands of plan 12f Task 12: users, sessions, and audit.
// Each request goes to a real core handle, so each answer is an answer that
// core can give. Each state comes through the API, never by a row write.
import { createHash } from "node:crypto";
import {
  type Auth,
  type AuthConfig,
  createAuth,
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  hookRefusal,
  type MailMessage,
} from "@authtempo/core";
import { ROUTE_CONTRACT } from "@authtempo/core/openapi";
import { ROUTES, type RouteEntry, USER_ACTOR_CODES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { REFUSALS } from "../src/operator-client.js";
import { PROOF_METHODS, reasonProblem } from "../src/operator-tools.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const OPERATOR = `${BASE}/auth/operator`;
const SUPPORT = "operator-support-0123456789abcdef-0123";
/** A secret with the audit scope only. */
const AUDITOR = "operator-auditor-0123456789abcdef-0123";
/** A wrong secret of the right form, so that only the hash refuses it. */
const WRONG = "operator-wrong-wrong-wrong-wrong-wrong-0";
const IP = "203.0.113.7";
const PW = "correct horse battery";
const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * One core handle with the user tools on: a platform organization, a
 * platform role, and two named secrets. `operator` replaces the operator
 * block, so a test can turn the tools off. `fetch` sends each request to the
 * handle from one IP and counts the requests of each path. `storage` is
 * for a read, or for a test that runs a parallel request inside a transaction.
 */
function fixture(operator?: AuthConfig["operator"], extra: Partial<AuthConfig> = {}) {
  let current = new Date("2026-03-01T00:00:00.000Z");
  const clock = { now: () => current };
  const advance = (ms: number) => {
    current = new Date(current.getTime() + ms);
  };
  const mails: MailMessage[] = [];
  const storage = createMemoryAdapter();
  const auth: Auth = createAuth({
    baseURL: BASE,
    trustedOrigins: ["https://app.example.com"],
    storage,
    limiter: createMemoryLimiter(clock),
    clock,
    mail: {
      send: async (m) => {
        mails.push(m);
      },
    },
    secret: "0123456789abcdef0123456789abcdef",
    password: { hash: FAST, uniformSignUp: false },
    organizations: {
      platformOrganization: "platform",
      platformRole: "operator",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: operator ?? {
      secrets: [
        { name: "support", secretHash: hash(SUPPORT), scopes: ["users", "sessions", "audit"] },
        { name: "auditor", secretHash: hash(AUDITOR), scopes: ["audit"] },
      ],
      users: true,
    },
    ...extra,
  });
  const paths: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", IP);
    paths.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    return auth.handle(new Request(url, { ...init, headers }));
  };
  return { auth, fetch, paths, mails, advance, storage };
}
type Fixture = ReturnType<typeof fixture>;

/** A new client IP for each sign-up and sign-in, so the limits per IP of those flows never refuse. */
let clients = 0;
const nextIp = () => {
  clients++;
  return `10.1.${clients >> 8}.${clients & 255}`;
};

/** A user through the password sign-up, which opens a session. Answers the user id. */
async function signUp(f: Fixture, email: string, name?: string): Promise<string> {
  const password = f.auth.api.password;
  if (!password) throw new Error("no password api");
  const up = await password.signUp({
    email,
    password: PW,
    ...(name === undefined ? {} : { name }),
    ip: nextIp(),
    userAgent: null,
  });
  if (!up.ok || !("user" in up.value)) throw new Error("the sign-up gave no user");
  return up.value.user.id;
}

/** One more session of a user through the password sign-in. */
async function signIn(f: Fixture, email: string): Promise<void> {
  const password = f.auth.api.password;
  if (!password) throw new Error("no password api");
  const s = await password.signIn({ email, password: PW, ip: nextIp(), userAgent: null });
  if (!s.ok) throw new Error(`the sign-in answered ${s.code}`);
}

async function run(
  args: string[],
  f: Fixture,
  o: Parameters<typeof fakeIo>[0] = {},
  secret = SUPPORT,
) {
  const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: secret }, fetch: f.fetch, ...o });
  const code = await main(args, io);
  return { code, io };
}

/** The one JSON document of a `--json` run. */
function docOf(stdout: readonly string[]): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "") as Record<string, unknown>;
}

/** The checkedAt of a proof: one hour before the clock of the handle. */
const CHECKED = "2026-02-28T23:00:00.000Z";

/** Each write of the operator commands, with every flag but --yes, for the user `id`. */
const writes = (id: string): string[][] => [
  ["users", "ban", BASE, id, "--reason", "spam"],
  ["users", "unban", BASE, id, "--reason", "appeal"],
  ["users", "platform-role", BASE, id, "--grant", "--reason", "support lead"],
  [
    "users",
    "second-factor-off",
    BASE,
    id,
    "--reason",
    "lost phone",
    "--proof-method",
    "document",
    "--proof-reference",
    "case-1",
    "--proof-checked-at",
    CHECKED,
  ],
  ["sessions", "end", BASE, id, "--reason", "stolen laptop"],
  ["sessions", "end-all", BASE, "--reason", "breach"],
  ["create-admin", BASE, "--email", "root@example.com", "--reason", "first operator"],
];

describe("the operator commands (plan 12f Task 12)", () => {
  it("needs --yes for each write with no terminal, and makes no request with --no-input", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    for (const args of writes(id)) {
      const label = args.slice(0, 2).join(" ");
      // No terminal and no --yes: a usage error before any request.
      const pipe = await run([...args], f, { stdinIsTTY: false });
      expect(pipe.code, label).toBe(2);
      expect(pipe.io.stderr[0], label).toMatch(
        /asks for a confirmation: give --yes when no person can answer$/,
      );
      // A terminal, but --no-input: the same usage error.
      const quiet = await run([...args, "--no-input"], f, { stdinIsTTY: true });
      expect(quiet.code, label).toBe(2);
      expect(quiet.io.stderr[0], label).toMatch(/asks for a confirmation/);
      // --token-file - reads stdin, so no question can follow.
      const stdin = await run([...args, "--token-file", "-"], f, {
        stdinIsTTY: true,
        stdin: SUPPORT,
      });
      expect(stdin.code, label).toBe(2);
      expect(stdin.io.stderr[0], label).toBe(
        "--token-file - reads the secret from stdin, so the command cannot ask: give --yes",
      );
      // A terminal and the answer no: the question names the act and the user id, and no write goes out.
      const io = fakeIo({
        env: { AUTHTEMPO_OPERATOR_SECRET: SUPPORT },
        fetch: f.fetch,
        stdinIsTTY: true,
      });
      const questions: string[] = [];
      io.confirm = async (q: string) => {
        questions.push(q);
        return false;
      };
      expect(await main([...args], io), label).toBe(2);
      expect(questions, label).toHaveLength(1);
      if (args[0] !== "create-admin" && args[1] !== "end-all")
        expect(questions[0], label).toContain(id);
      expect(io.stderr.at(-1), label).toMatch(/^stopped: no .*: the answer was not yes$/);
      expect(io.requests, label).toEqual([]);
    }
    expect(f.paths).toEqual([]);
  });

  it("refuses a reason that core refuses, before any request", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    // The bidi control, the C1 control, and the separator are the class of the user name (ruling 62 m5).
    for (const reason of [
      "",
      "a".repeat(501),
      "a\nb",
      "a\u0000b",
      "a\u007fb",
      "a\ud800b",
      "a\u202eb",
      "a\u200fb",
      "a\u0085b",
      "a\u2028b",
    ]) {
      const r = await run(["users", "ban", BASE, id, "--reason", reason, "--yes"], f);
      expect(r.code, JSON.stringify(reason)).toBe(2);
      expect(r.io.stderr[0]).toBe(
        "--reason is 1 to 500 characters with no control, format, or separator character and no lone surrogate",
      );
    }
    expect(f.paths).toEqual([]);
    // The rule of the CLI against the answer of core, for each sample: one rule, two copies.
    const ban = ROUTE_CONTRACT["POST /operator/users/ban"].body.schema;
    for (const reason of [
      "",
      "a",
      "a".repeat(500),
      "a".repeat(501),
      "a\tb",
      "a\u0085b",
      "\ud800",
      "a\u202eb",
      "a\u2028b",
      "a\u200cb",
    ]) {
      const core = await f.auth.api.operator.users.ban({
        actor: { kind: "app", name: "test" },
        userId: id,
        reason,
        ip: null,
        userAgent: null,
      });
      const refused = !core.ok && core.code === "invalid_body";
      const parsed = ban.safeParse({ userId: id, reason }).success;
      expect(reasonProblem(reason) !== null, JSON.stringify(reason)).toBe(refused || !parsed);
      if (core.ok)
        await f.auth.api.operator.users.unban({
          actor: { kind: "app", name: "test" },
          userId: id,
          reason: "undo",
          ip: null,
          userAgent: null,
        });
    }
    // The proof methods of the CLI are the methods of the contract.
    const disable = ROUTE_CONTRACT["POST /operator/users/second-factor/disable"].body.schema;
    expect([...PROOF_METHODS]).toEqual([...disable.shape.proof.shape.method.options]);
  });

  it("scrubs the secret from every line", async () => {
    const f = fixture();
    // The user's name is the secret, so a read prints it unless the scrub holds it.
    const id = await signUp(f, "ada@example.com", SUPPORT);
    const runs = [
      ["users", "list", BASE],
      ["users", "list", BASE, "--json"],
      ["users", "search", BASE, "--id", id],
      ["users", "get", BASE, id],
      ["users", "get", BASE, id, "--json"],
      ["users", "ban", BASE, id, "--reason", "spam", "--yes"],
      ["users", "unban", BASE, id, "--reason", "appeal", "--yes"],
      ["sessions", "end", BASE, id, "--reason", "reset", "--yes"],
      ["sessions", "end-all", BASE, "--reason", "reset", "--yes", "--json"],
      ["audit", "list", BASE],
      ["audit", "list", BASE, "--json"],
    ];
    for (const args of runs) {
      const { code, io } = await run(args, f);
      expect(code, args.join(" ")).toBe(0);
      for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(SUPPORT);
    }
    const get = await run(["users", "get", BASE, id, "--json"], f);
    expect((docOf(get.io.stdout).user as { name: string }).name).toBe("***");
    // A 401: the wrong secret is in no line either.
    for (const args of runs) {
      const { code, io } = await run(args, f, {}, WRONG);
      expect(code, args.join(" ")).toBe(2);
      expect(io.stderr.at(-1)).toBe("stopped: the deployment refused the operator secret");
      for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(WRONG);
    }
  });

  it("follows next with --all", async () => {
    const f = fixture();
    for (let i = 0; i < 120; i++) await signUp(f, `user${String(i).padStart(3, "0")}@example.com`);
    const { code, io } = await run(["users", "list", BASE, "--all"], f);
    expect(code).toBe(0);
    // With --all and no --limit, each page holds 100 users, so 120 users take two calls.
    expect(f.paths.filter((p) => p === "GET /auth/operator/users")).toHaveLength(2);
    // One table: the header and 120 rows.
    expect(io.stdout).toHaveLength(121);
    expect(io.stdout[0]).toMatch(
      /^ID +EMAIL +VERIFIED +BAN +OPERATOR +FACTORS +SESSIONS +CREATED$/,
    );
    expect(new Set(io.stdout.slice(1).map((l) => l.split(/ +/)[1])).size).toBe(120);

    const json = await run(["users", "list", BASE, "--all", "--json"], f);
    const doc = docOf(json.io.stdout);
    expect((doc.users as unknown[]).length).toBe(120);
    expect(doc).toMatchObject({ next: null, exit: 0, stopped: null });

    // One page with no --all: the next cursor goes to stderr.
    const page = await run(["users", "list", BASE, "--limit", "100"], f);
    expect(page.code).toBe(0);
    expect(page.io.stdout).toHaveLength(101);
    expect(page.io.stderr.at(-1)).toMatch(
      /^more users after \S+: give --after \S+, or give --all$/,
    );
  });

  it("stops --all at --max-calls with exit 1, and on a 429 after the first page with its rows", async () => {
    const f = fixture();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await signUp(f, `p${i}@example.com`));
    // The read goes by id, and ids of one millisecond do not sort by the order of the sign-ups.
    ids.sort();
    // --max-calls 2 with one user a page: two pages, a warning, and exit 1.
    const cut = await run(["users", "list", BASE, "--all", "--limit", "1", "--max-calls", "2"], f);
    expect(cut.code).toBe(1);
    expect(cut.io.stdout).toHaveLength(3);
    expect(cut.io.stderr.at(-1)).toBe(
      `warning: the read reached --max-calls 2 with more users; give --after ${ids[1]} to read on`,
    );
    const cutJson = await run(
      ["users", "list", BASE, "--all", "--limit", "1", "--max-calls", "2", "--json"],
      f,
    );
    expect(cutJson.code).toBe(1);
    const cutDoc = docOf(cutJson.io.stdout);
    expect(cutDoc).toMatchObject({ next: ids[1], exit: 1, stopped: null });
    expect((cutDoc.users as { id: string }[]).map((u) => u.id)).toEqual(ids.slice(0, 2));
    const audit = await run(
      ["audit", "list", BASE, "--all", "--limit", "1", "--max-calls", "1"],
      f,
    );
    expect(audit.code).toBe(0);
    // --max-calls needs --all.
    const alone = await run(["users", "list", BASE, "--max-calls", "2"], f);
    expect(alone.code).toBe(2);
    expect(alone.io.stderr[0]).toBe("--max-calls goes with --all");
    expect(f.paths.filter((p) => p === "GET /auth/operator/users")).toHaveLength(4);

    // A 429 at the second call: 599 calls of this IP before the run.
    for (const json of [false, true]) {
      const g = fixture();
      const gIds: string[] = [];
      for (let i = 0; i < 5; i++) gIds.push(await signUp(g, `q${i}@example.com`));
      gIds.sort();
      for (let i = 0; i < 599; i++)
        await g.fetch(`${OPERATOR}/users?limit=1`, {
          headers: { authorization: `Operator ${WRONG}` },
        });
      const args = ["users", "list", BASE, "--all", "--limit", "2"];
      const r = await run(json ? [...args, "--json"] : args, g);
      const stop = "the operator routes allow 600 calls per IP per hour; wait, then run it again";
      expect(r.code).toBe(2);
      expect(r.io.stderr.at(-1)).toBe(`stopped: ${stop}`);
      if (json) {
        const doc = docOf(r.io.stdout);
        expect(doc).toMatchObject({ next: gIds[1], exit: 2, stopped: stop });
        expect((doc.users as { id: string }[]).map((u) => u.id)).toEqual(gIds.slice(0, 2));
      } else {
        // The header and the two users of the first page.
        expect(r.io.stdout).toHaveLength(3);
        expect(r.io.stdout.slice(1).map((l) => l.split(/ +/)[0])).toEqual(gIds.slice(0, 2));
      }
    }
  });

  it("stops --all when next does not move, and prints the rows before the stop", async () => {
    const createdAt = "2026-03-01T00:00:00.000Z";
    const user = {
      ...{ id: "u1", email: "u1@example.com", emailVerified: true, name: null, createdAt },
      ...{ ban: null, platformOperator: false, secondFactor: [], sessions: 0, identities: [] },
    };
    const row = {
      ...{ id: "a1", createdAt, updatedAt: createdAt, actorKind: "secret", actorId: "support" },
      ...{ action: "ban", targetUserId: null, reason: "spam", data: null, ip: null },
      userAgent: null,
    };
    // A server that answers the same page with next "u1" (or "a1") to every call.
    for (const [command, body, stop] of [
      ["users", { users: [user], next: "u1" }, "users"],
      ["audit", { rows: [row], next: "a1" }, "audit"],
    ] as const) {
      for (const json of [false, true]) {
        let calls = 0;
        const fetch = async () => {
          calls++;
          return Response.json(body);
        };
        const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SUPPORT }, fetch });
        const args = [command, "list", BASE, "--all"];
        const code = await main(json ? [...args, "--json"] : args, io);
        expect(code, command).toBe(2);
        expect(calls, command).toBe(2);
        const text = `GET ${OPERATOR}${stop === "users" ? "/users" : "/audit"} answered the cursor of its own call as next: the read stops`;
        expect(io.stderr.at(-1), command).toBe(`stopped: ${text}`);
        if (json) {
          const doc = docOf(io.stdout);
          expect(doc, command).toMatchObject({ next: body.next, exit: 2, stopped: text });
          expect(doc[command === "users" ? "users" : "rows"], command).toHaveLength(1);
        } else expect(io.stdout, command).toHaveLength(2);
      }
    }
  });

  it("ends all sessions until more is false, or stops at --max-calls with exit 1", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) await signUp(f, `s${i}@example.com`);
    const done = await run(
      ["sessions", "end-all", BASE, "--reason", "breach", "--limit", "2", "--yes"],
      f,
    );
    expect(done.code).toBe(0);
    expect(done.io.stdout).toEqual(["calls 3, ended 5, more false"]);
    expect(done.io.stderr).toContain("call 1: ended 2, more true");
    expect(done.io.stderr).toContain("call 3: ended 1, more false");

    for (let i = 0; i < 5; i++) await signIn(f, `s${i}@example.com`);
    const cut = await run(
      [
        ...["sessions", "end-all", BASE, "--reason", "breach"],
        ...["--limit", "2", "--max-calls", "2", "--yes", "--json"],
      ],
      f,
    );
    expect(cut.code).toBe(1);
    expect(docOf(cut.io.stdout)).toEqual({
      ended: 4,
      calls: 2,
      more: true,
      exit: 1,
      stopped: null,
    });
    expect(cut.io.stderr.at(-1)).toBe(
      "warning: the run reached --max-calls 2 with sessions left; run it again",
    );
  });

  it("prints the sums of the calls before a 429 in the middle of an end, with exit 2", async () => {
    const stop = "the operator routes allow 600 calls per IP per hour; wait, then run it again";
    /** `left` calls of this IP stay in the hour: the wrong secret spends the rest. */
    const spend = async (f: Fixture, left: number) => {
      for (let i = 0; i < 600 - left; i++)
        await f.fetch(`${OPERATOR}/users?limit=1`, {
          headers: { authorization: `Operator ${WRONG}` },
        });
    };
    // end-all: two calls of two sessions each, then the 429.
    for (const json of [false, true]) {
      const f = fixture();
      for (let i = 0; i < 5; i++) await signUp(f, `m${i}@example.com`);
      await spend(f, 2);
      const args = ["sessions", "end-all", BASE, "--reason", "breach", "--limit", "2", "--yes"];
      const r = await run(json ? [...args, "--json"] : args, f);
      expect(r.code).toBe(2);
      expect(r.io.stderr.at(-1)).toBe(`stopped: ${stop}`);
      expect(r.io.stderr).toContain("call 2: ended 2, more true");
      if (json)
        expect(docOf(r.io.stdout)).toEqual({
          ended: 4,
          calls: 2,
          more: true,
          exit: 2,
          stopped: stop,
        });
      else expect(r.io.stdout).toEqual(["calls 2, ended 4, more true"]);
    }
    // end of one user: a session.afterEnd hook makes each call end one page only.
    for (const json of [false, true]) {
      const f = fixture(undefined, { hooks: { session: { afterEnd: () => {} } } });
      const id = await signUp(f, "bea@example.com");
      for (let i = 0; i < 79; i++) {
        if (i % 9 === 8) f.advance(15 * 60_000);
        await signIn(f, "bea@example.com");
      }
      await spend(f, 1);
      const args = ["sessions", "end", BASE, id, "--reason", "reset", "--yes"];
      const r = await run(json ? [...args, "--json"] : args, f);
      expect(r.code).toBe(2);
      expect(r.io.stderr.at(-1)).toBe(`stopped: ${stop}`);
      const first = r.io.stderr.find((l) => l.startsWith("call 1: "));
      const ended = Number(/^call 1: ended (\d+), more true$/.exec(first ?? "")?.[1]);
      expect(ended).toBeGreaterThan(0);
      if (json) {
        const doc = docOf(r.io.stdout);
        expect(doc).toMatchObject({ ended, calls: 1, more: true, exit: 2, stopped: stop });
        expect(doc.auditIds).toHaveLength(1);
      } else expect(r.io.stdout).toEqual([`calls 1, ended ${ended}, more true`]);
    }
  });

  it("ends the sessions of one user and prints the total", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    for (let i = 0; i < 3; i++) await signIn(f, "ada@example.com");
    const { code, io } = await run(["sessions", "end", BASE, id, "--reason", "reset", "--yes"], f);
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["calls 1, ended 4, more false"]);
    const again = await run(
      ["sessions", "end", BASE, id, "--reason", "reset", "--yes", "--json"],
      f,
    );
    const doc = docOf(again.io.stdout);
    expect(doc).toMatchObject({ ended: 0, calls: 1, more: false, exit: 0, stopped: null });
    expect(doc.auditIds).toHaveLength(1);
  });

  it("calls again while the answer of one user has more, and counts each call", async () => {
    // With a session.afterEnd hook, each session costs its own delete, so one call ends a page only.
    const endedIds: string[] = [];
    const f = fixture(undefined, {
      hooks: {
        session: {
          afterEnd: ({ session }) => {
            endedIds.push(session.id);
          },
        },
      },
    });
    const id = await signUp(f, "bea@example.com");
    // The sign-in allows 10 tries per address in 15 minutes, so the clock moves on after each 9.
    for (let i = 0; i < 79; i++) {
      if (i % 9 === 8) f.advance(15 * 60_000);
      await signIn(f, "bea@example.com");
    }
    const { code, io } = await run(
      ["sessions", "end", BASE, id, "--reason", "reset", "--yes", "--json"],
      f,
    );
    expect(code).toBe(0);
    const doc = docOf(io.stdout);
    expect(doc).toMatchObject({ ended: 80, more: false, exit: 0, stopped: null });
    // A call stops at the statement budget of the deployment, so 80 sessions take more than one call.
    expect(doc.calls).toBeGreaterThan(1);
    expect(doc.auditIds).toHaveLength(doc.calls as number);
    const calls = doc.calls as number;
    expect(io.stderr.filter((l) => /^call \d+: ended \d+, more true$/.test(l))).toHaveLength(
      calls - 1,
    );
    expect(io.stderr).toContain(
      `call ${calls}: ended ${io.stderr.at(-1)?.split(" ")[3]?.replace(",", "")}, more false`,
    );
    expect(new Set(endedIds).size).toBe(80);
    expect(f.paths.filter((p) => p === "POST /auth/operator/sessions/end-user")).toHaveLength(
      doc.calls as number,
    );
  });

  it("stops with exit 2 on a 404, a 401, a 403, and a 429, with the text of each", async () => {
    // 404: the tools are off.
    const off = fixture({ secretHash: hash(SUPPORT) });
    const r404 = await run(["users", "list", BASE], off);
    expect(r404.code).toBe(2);
    expect(r404.io.stderr.at(-1)).toBe(
      "stopped: the operator user tools are off: set operator.users and a secret with the users scope in the config of the deployment",
    );
    const s404 = await run(["sessions", "end-all", BASE, "--reason", "r", "--yes"], off);
    expect(s404.io.stderr.at(-1)).toBe(
      "stopped: the operator user tools are off: set operator.users and a secret with the sessions scope in the config of the deployment",
    );
    // 404 of a user id that no user has: the tools are on.
    const f = fixture();
    const missing = await run(["users", "get", BASE, "01NOSUCHUSER"], f);
    expect(missing.code).toBe(2);
    expect(missing.io.stderr.at(-1)).toBe("stopped: no user has the id 01NOSUCHUSER");
    // 401: a wrong secret.
    const r401 = await run(["users", "list", BASE], f, {}, WRONG);
    expect(r401.code).toBe(2);
    expect(r401.io.stderr.at(-1)).toBe("stopped: the deployment refused the operator secret");
    // 403: a secret with no users scope.
    const r403 = await run(["users", "list", BASE], f, {}, AUDITOR);
    expect(r403.code).toBe(2);
    expect(r403.io.stderr.at(-1)).toBe("stopped: the operator secret has no users scope");
    const ban403 = await run(["users", "ban", BASE, "x", "--reason", "r", "--yes"], f, {}, AUDITOR);
    expect(ban403.io.stderr.at(-1)).toBe("stopped: the operator secret has no users scope");
    // 429: 600 calls of this IP in the hour, right or wrong secret.
    for (let i = 0; i < 600; i++)
      await f.fetch(`${OPERATOR}/users?limit=1`, {
        headers: { authorization: `Operator ${WRONG}` },
      });
    const r429 = await run(["users", "list", BASE, "--json"], f);
    expect(r429.code).toBe(2);
    expect(r429.io.stderr.at(-1)).toBe(
      "stopped: the operator routes allow 600 calls per IP per hour; wait, then run it again",
    );
    expect(docOf(r429.io.stdout)).toEqual({
      users: [],
      next: null,
      exit: 2,
      stopped: "the operator routes allow 600 calls per IP per hour; wait, then run it again",
    });
  });

  it("names the cause of each refusal of a write", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    // The address is not verified, so the platform role is refused.
    const grant = await run(
      ["users", "platform-role", BASE, id, "--grant", "--reason", "lead", "--yes"],
      f,
    );
    expect(grant.code).toBe(2);
    expect(grant.io.stderr.at(-1)).toBe(
      "stopped: the user has not verified the address; the platform role needs a verified address",
    );
    // A proof from a clock ahead of the deployment.
    const ahead = await run(
      [
        ...["users", "second-factor-off", BASE, id, "--reason", "lost phone"],
        ...["--proof-method", "document", "--proof-reference", "case-1"],
        ...["--proof-checked-at", "2026-03-01T00:05:00.000Z", "--yes"],
      ],
      f,
    );
    expect(ahead.code).toBe(2);
    expect(ahead.io.stderr.at(-1)).toBe(
      "stopped: the deployment refused a value (invalid_body): --proof-checked-at must be a date and time with a zone, at most 7 days old, and not later than the clock of the deployment",
    );
    // A cursor that core refuses: each read names only its own flags.
    const long = "x".repeat(65);
    const list = await run(["users", "list", BASE, "--after", long], f);
    expect(list.io.stderr.at(-1)).toBe(
      "stopped: the deployment refused a value (invalid_body): --after is an id of at most 64 characters, from the page before",
    );
    const search = await run(["users", "search", BASE, "--id", "x", "--after", long], f);
    expect(search.io.stderr.at(-1)).toBe(
      "stopped: the deployment refused a value (invalid_body): --email-prefix is 3 to 254 characters after the address rule, and --after is an id of the page before",
    );
    // A ban that ends in the past.
    const past = await run(
      ["users", "ban", BASE, id, "--reason", "spam", "--until", "2020-01-01T00:00:00Z", "--yes"],
      f,
    );
    expect(past.io.stderr.at(-1)).toBe(
      "stopped: the deployment refused a value (invalid_body): --until must be a date and time with a zone, from 1 minute to 3650 days after now",
    );
  });

  it("tells the tools off from a missing user on a 404 of a command with a user id", async () => {
    const off = fixture({ secretHash: hash(SUPPORT) });
    for (const [args, scope] of [
      [["users", "ban", BASE, "01NOSUCHUSER", "--reason", "spam", "--yes"], "users"],
      [["sessions", "end", BASE, "01NOSUCHUSER", "--reason", "reset", "--yes"], "sessions"],
    ] as const) {
      off.paths.length = 0;
      const r = await run([...args], off);
      expect(r.code, args[1]).toBe(2);
      expect(r.io.stderr.at(-1), args[1]).toBe(
        `stopped: the operator user tools are off: set operator.users and a secret with the ${scope} scope in the config of the deployment`,
      );
      // The act, then one read of the user list that tells the two causes apart.
      expect(off.paths, args[1]).toHaveLength(2);
      expect(off.paths[1], args[1]).toBe("GET /auth/operator/users");
    }
  });

  it("names the cause of each refusal code that a secret caller can get", async () => {
    const APP = { kind: "app", name: "test" } as const;
    const stopped = (r: { io: { stderr: string[] } }) => r.io.stderr.at(-1);
    const admin = (email: string) => [
      ...["create-admin", BASE, "--email", email, "--reason", "first operator", "--yes"],
    ];

    // account_banned: the address of a banned user.
    const f = fixture();
    const ada = await signUp(f, "ada@example.com");
    expect((await run(["users", "ban", BASE, ada, "--reason", "spam", "--yes"], f)).code).toBe(0);
    expect(stopped(await run(admin("ada@example.com"), f))).toBe(
      "stopped: the user is banned; unban the user first",
    );

    // totp_not_enabled: a user with no second factor.
    const bea = await signUp(f, "bea@example.com");
    const off = await run(
      [
        ...["users", "second-factor-off", BASE, bea, "--reason", "lost phone"],
        ...["--proof-method", "document", "--proof-reference", "case-1"],
        ...["--proof-checked-at", CHECKED, "--yes"],
      ],
      f,
    );
    expect(stopped(off)).toBe("stopped: the user has no second factor on");

    // last_owner: the one owner holds the platform role alone, and a revoke takes the owner rank.
    expect((await run(admin("bea@example.com"), f)).code).toBe(0);
    const org = await f.storage.findOne("organization", [
      { field: "slug", op: "eq", value: "platform" },
    ]);
    // A change of a member role needs a verified address: the link of the sign-up mail proves it.
    const mail = f.mails.find((m) => m.to === "bea@example.com")?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail)?.[1] ?? "");
    const verified = await f.auth.api.password?.verifyEmail({ token, ip: null, userAgent: null });
    if (!org || !verified?.ok) throw new Error("no platform organization or no verified address");
    const moved = await f.auth.api.updateMemberRole({
      user: verified.value.user,
      organizationId: org.id,
      userId: bea,
      role: "operator",
    });
    if (!moved.ok) throw new Error(moved.code);
    const revoke = await run(
      ["users", "platform-role", BASE, bea, "--revoke", "--reason", "left", "--yes"],
      f,
    );
    expect(stopped(revoke)).toBe(
      "stopped: the user is the last owner of the platform organization; add another owner first",
    );

    // member_limit: a platform organization with room for one member.
    const full = fixture(undefined, {
      organizations: {
        platformOrganization: "platform",
        platformRole: "operator",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
        limits: { membersPerOrganization: 1 },
      },
    });
    expect((await run(admin("root@example.com"), full)).code).toBe(0);
    expect(stopped(await run(admin("cy@example.com"), full))).toBe(
      "stopped: the platform organization has its largest count of members",
    );

    // conflict: a parallel create-admin makes the platform organization between the read and the act.
    const race = fixture();
    const transaction = race.storage.transaction.bind(race.storage);
    let between: (() => Promise<unknown>) | null = () =>
      race.auth.api.operator.createAdmin({
        actor: APP,
        email: "root@example.com",
        reason: "parallel",
        ip: null,
        userAgent: null,
      });
    race.storage.transaction = async (fn) => {
      const step = between;
      between = null;
      if (step) await step();
      return transaction(fn);
    };
    expect(stopped(await run(admin("dee@example.com"), race))).toBe(
      "stopped: another change of this user ran at the same time; read the user, then run it again",
    );

    // hook_refused and hook_failed: hooks.operator.beforeAction refuses, or throws.
    let mode: "refuse" | "fail" = "refuse";
    const hooked = fixture(undefined, {
      hooks: {
        operator: {
          beforeAction: () => {
            if (mode === "refuse") throw hookRefusal("not now");
            throw new Error("the hook broke");
          },
        },
      },
    });
    const eve = await signUp(hooked, "eve@example.com");
    const ban = ["users", "ban", BASE, eve, "--reason", "spam", "--yes"];
    expect(stopped(await run(ban, hooked))).toBe(
      "stopped: a hook of the deployment refused the act (hooks.operator.beforeAction)",
    );
    mode = "fail";
    expect(stopped(await run(ban, hooked))).toBe(
      "stopped: a hook of the deployment failed; read the log of the deployment",
    );
  });

  it("warns and exits 1 when a ban or a revoke answers familyEndFailed (ruling 37)", async () => {
    const f = fixture();
    const ada = await signUp(f, "ada@example.com");
    expect(
      (
        await run(
          ["create-admin", BASE, "--email", "root@example.com", "--reason", "first", "--yes"],
          f,
        )
      ).code,
    ).toBe(0);
    const second = await run(
      ["create-admin", BASE, "--email", "bea@example.com", "--reason", "second", "--yes"],
      f,
    );
    // create-admin prints the user id alone on stdout.
    const beaId = second.io.stdout.at(-1) ?? "";
    // The read of endFamilies after the commit is the one outer read of
    // oauthToken. A storage limit there, such as query 51 on D1 Free, throws.
    const findMany = f.storage.findMany.bind(f.storage);
    let refused = 0;
    f.storage.findMany = ((model, ...rest) => {
      if (model === "oauthToken") {
        refused++;
        throw new Error("Too many API requests by single worker invocation.");
      }
      return findMany(model, ...rest);
    }) as typeof f.storage.findMany;
    const warning = (id: string) =>
      `warning: the act ran, but the end of the OAuth refresh families failed (familyEndFailed); run authtempo sessions end <base url> ${id} with a secret of the sessions scope`;

    const ban = await run(["users", "ban", BASE, ada, "--reason", "spam", "--yes"], f);
    expect(refused).toBe(1);
    expect(ban.code).toBe(1);
    expect(ban.io.stdout.at(-1)).toMatch(new RegExp(`^banned ${ada}; audit row \\S+$`));
    expect(ban.io.stderr.at(-1)).toBe(warning(ada));

    const json = await run(["users", "ban", BASE, ada, "--reason", "again", "--yes", "--json"], f);
    expect(json.code).toBe(1);
    expect(docOf(json.io.stdout)).toMatchObject({ exit: 1, stopped: null });
    expect(json.io.stderr.at(-1)).toBe(warning(ada));

    const revoke = await run(
      ["users", "platform-role", BASE, beaId, "--revoke", "--reason", "left", "--yes"],
      f,
    );
    expect(revoke.code).toBe(1);
    expect(revoke.io.stderr.at(-1)).toBe(warning(beaId));
    expect(refused).toBe(3);

    // With the storage well again, the same ban exits 0 with no warning.
    f.storage.findMany = findMany;
    const again = await run(["users", "ban", BASE, ada, "--reason", "third", "--yes"], f);
    expect(again.code).toBe(0);
    expect(again.io.stderr.some((l) => l.startsWith("warning:"))).toBe(false);
  });

  it("holds the refusal texts to the codes that a secret can get from the routes", () => {
    // These codes have their own texts in operatorCall, or a text by status (401 and 429).
    const own = ["operator_required", "invalid_body", "unauthorized", "rate_limited"];
    const session: readonly string[] = USER_ACTOR_CODES;
    const listed: readonly RouteEntry[] = ROUTES;
    const codes = new Set<string>();
    for (const r of listed)
      if (
        (r.feature === "operator" || r.feature === "operatorUsers") &&
        r.auth.includes("operator")
      )
        for (const c of r.codes) if (!own.includes(c) && !session.includes(c)) codes.add(c);
    expect([...codes].sort()).toEqual(Object.keys(REFUSALS).sort());
  });

  it("prints no address on stderr", async () => {
    const f = fixture();
    await signUp(f, "ada.lovelace@example.com");
    for (const args of [
      ["users", "search", BASE, "--email", "ada.lovelace@example.com"],
      ["users", "search", BASE, "--email-prefix", "ada.lo"],
      ["users", "search", BASE, "--email", "ada.lovelace@example.com", "--json"],
      ["users", "search", BASE, "--email", "nobody@example.com"],
    ]) {
      const { code, io } = await run(args, f);
      expect(code, args.join(" ")).toBe(0);
      for (const line of io.stderr) expect(line).not.toMatch(/@|ada\.lo|nobody/);
      if (!args.includes("nobody@example.com"))
        expect(io.stdout.join("\n")).toContain("ada.lovelace@example.com");
    }
    // A stop names no address either: the query is not in the text.
    const stop = await run(
      ["users", "search", BASE, "--email", "ada.lovelace@example.com"],
      f,
      {},
      AUDITOR,
    );
    for (const line of stop.io.stderr) expect(line).not.toMatch(/@/);
    // Exactly one key.
    const two = await run(["users", "search", BASE, "--email", "a@example.com", "--id", "x"], f);
    expect(two.code).toBe(2);
    expect(two.io.stderr[0]).toBe("give exactly one of --email, --email-prefix, and --id");
  });

  it("names no query in a stop of the host: no answer, a redirect, and a time-out", async () => {
    const search = `${OPERATOR}/users/search`;
    // A host with no answer, a host that answers 302, and a host that waits until the time limit.
    const hosts: [string, (url: string, init: RequestInit) => Promise<Response>, string][] = [
      [
        "no answer",
        async () => {
          throw new TypeError("fetch failed");
        },
        `GET ${search}: no answer`,
      ],
      [
        "a redirect",
        async () => new Response(null, { status: 302, headers: { location: `${BASE}/elsewhere` } }),
        `GET ${search} answered 302, a redirect: the CLI follows no redirect`,
      ],
      [
        "a time-out",
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
        `GET ${search}: no answer in 1 s`,
      ],
    ];
    for (const [label, fetch, stopped] of hosts) {
      for (const json of [false, true]) {
        const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SUPPORT }, fetch });
        const args = ["users", "search", BASE, "--email", "alice@example.com", "--timeout", "1"];
        const code = await main(json ? [...args, "--json"] : args, io);
        expect(code, label).toBe(2);
        expect(io.stderr.at(-1), label).toBe(`stopped: ${stopped}`);
        for (const line of io.stderr) expect(line, label).not.toMatch(/@|%40|alice/);
        if (json) {
          const doc = docOf(io.stdout);
          expect(doc.stopped, label).toBe(stopped);
          expect(JSON.stringify(doc), label).not.toMatch(/@|%40|alice/);
        } else expect(io.stdout, label).toEqual([]);
      }
    }
  });
});
