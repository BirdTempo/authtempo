// The operator commands users create, users update, and users delete of
// plan 12f2 Task 6 (update and delete in Wave A, create in Wave B). Each
// request goes to a real core handle, so each answer is an answer that core
// can give. Each state comes through the API, never by a row write.
import { createHash } from "node:crypto";
import {
  type Auth,
  createAuth,
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { STOP_JSON } from "../src/json.js";
import { main } from "../src/main.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const OPERATOR = `${BASE}/auth/operator`;
/** A secret with the users, sessions, and audit scopes: no delete scope. */
const SUPPORT = "operator-support-0123456789abcdef-0123";
/** A secret with the users and delete scopes. */
const DELETER = "operator-deleter-0123456789abcdef-0123";
/** A secret with the audit scope only. */
const AUDITOR = "operator-auditor-0123456789abcdef-0123";
/** A wrong secret of the right form, so that only the hash refuses it. */
const WRONG = "operator-wrong-wrong-wrong-wrong-wrong-0";
const IP = "203.0.113.7";
const PW = "correct horse battery";
const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const APP = { kind: "app", name: "test" } as const;
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * One core handle with the user tools on, and three named secrets. `fetch`
 * sends each request to the handle from one IP and counts the requests of
 * each path.
 */
function fixture(extra: Partial<Parameters<typeof createAuth>[0]> = {}) {
  const current = new Date("2026-03-01T00:00:00.000Z");
  const clock = { now: () => current };
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
    operator: {
      secrets: [
        { name: "support", secretHash: hash(SUPPORT), scopes: ["users", "sessions", "audit"] },
        { name: "deleter", secretHash: hash(DELETER), scopes: ["users", "delete"] },
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
  return { auth, fetch, paths, mails, storage };
}
type Fixture = ReturnType<typeof fixture>;

/** A new client IP for each sign-up, so the limits per IP of the sign-up never refuse. */
let clients = 0;
const nextIp = () => {
  clients++;
  return `10.2.${clients >> 8}.${clients & 255}`;
};

/** A user through the password sign-up. Answers the user id. */
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

/** The verified user row of an address, through the link of the sign-up mail. */
async function verify(f: Fixture, email: string) {
  const mail = f.mails.find((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail)?.[1] ?? "");
  const verified = await f.auth.api.password?.verifyEmail({ token, ip: null, userAgent: null });
  if (!verified?.ok) throw new Error("no verified address");
  return verified.value.user;
}

/** A verified user who owns one organization of the slug. Answers the user and the organization ids. */
async function owner(f: Fixture, email: string, slug: string) {
  const id = await signUp(f, email);
  const user = await verify(f, email);
  const made = await f.auth.api.createOrganization({ user, slug, name: slug });
  if (!made.ok) throw new Error(`the create answered ${made.code}`);
  return { id, user, organizationId: made.value.organization.id };
}

async function run(
  args: string[],
  f: Fixture,
  o: Parameters<typeof fakeIo>[0] = {},
  secret = DELETER,
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

const userRow = (f: Fixture, id: string) =>
  f.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);

/** The audit rows of a user, through the API of the app. */
async function auditOf(f: Fixture, id: string) {
  const rows = await f.auth.api.operator.audit.list({ actor: APP, targetUserId: id });
  if (!rows.ok) throw new Error(rows.code);
  return rows.value.rows;
}

describe("users update and users delete (plan 12f2 Task 6)", () => {
  it("changes the name and the image of a user, and prints the audit row id", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com", "Ada");
    const image = "https://img.example.com/ada.png";
    const set = await run(
      ["users", "update", BASE, id, "--name", "Ada L", "--image", image, "--reason", "ticket 1"],
      f,
      { stdinIsTTY: true, answer: true },
    );
    expect(set.code).toBe(0);
    const [row] = await auditOf(f, id);
    expect(set.io.stdout).toEqual([
      `changed the name and the image of ${id}; audit row ${row?.id}`,
    ]);
    expect(row).toMatchObject({ action: "user_update", data: { fields: ["name", "image"] } });
    expect(await userRow(f, id)).toMatchObject({ name: "Ada L", image });

    // --no-name and --no-image clear the two fields.
    const clear = await run(
      ["users", "update", BASE, id, "--no-name", "--no-image", "--reason", "ticket 2", "--yes"],
      f,
    );
    expect(clear.code).toBe(0);
    expect(clear.io.stdout[0]).toMatch(
      new RegExp(`^changed the name and the image of ${id}; audit row \\S+$`),
    );
    expect(await userRow(f, id)).toMatchObject({ name: null, image: null });

    // One field: the line and the audit row name that field only.
    const one = await run(
      ["users", "update", BASE, id, "--name", "Bea", "--reason", "ticket 3", "--yes", "--json"],
      f,
    );
    expect(one.code).toBe(0);
    const doc = docOf(one.io.stdout);
    expect(Object.keys(doc).sort()).toEqual(["auditId", "exit", "stopped", "user"]);
    expect(doc).toMatchObject({ exit: 0, stopped: null, user: { id, name: "Bea" } });
    const rows = await auditOf(f, id);
    expect(rows.at(-1)).toMatchObject({ id: doc.auditId, data: { fields: ["name"] } });
    expect(await userRow(f, id)).toMatchObject({ name: "Bea", image: null });
  });

  it("updates, shows, and deletes a user with no address: a phone sign-up (plan 12i Task 1)", async () => {
    const sent: { to: string; text: string }[] = [];
    const sms = {
      send: async (m: { to: string; text: string }) => {
        sent.push({ to: m.to, text: m.text });
        return "sent" as const;
      },
    };
    const f = fixture({ phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true } });
    const phone = "+14155550123";
    const asked = await f.auth.api.phone?.request({ phone, ip: nextIp() });
    expect(asked).toEqual({ ok: true, value: { sent: true } });
    const code = /^(\d+) is your /.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    const signedUp = await f.auth.api.phone?.verify({ phone, code, ip: nextIp(), userAgent: null });
    if (!signedUp?.ok || !("user" in signedUp.value)) throw new Error("no phone user");
    const id = signedUp.value.user.id;
    expect(await userRow(f, id)).toMatchObject({ email: null });

    const named = await run(
      ["users", "update", BASE, id, "--name", "Pat", "--reason", "ticket 1", "--yes", "--json"],
      f,
    );
    expect(named.code).toBe(0);
    expect(docOf(named.io.stdout)).toMatchObject({ user: { id, email: null, name: "Pat" } });
    const text = await run(
      ["users", "update", BASE, id, "--no-name", "--reason", "ticket 2", "--yes"],
      f,
    );
    expect(text.code).toBe(0);
    expect(text.io.stdout[0]).toMatch(new RegExp(`^changed the name of ${id}; audit row \\S+$`));

    // The table shows no address as "-".
    const shown = await run(["users", "get", BASE, id], f, {}, SUPPORT);
    expect(shown.code).toBe(0);
    expect(shown.io.stdout.join("\n")).toMatch(new RegExp(`${id}\\s+-\\s+no\\s`));

    // The confirmation question names the user id, not an address.
    const questions: string[] = [];
    const io = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: DELETER },
      fetch: f.fetch,
      stdinIsTTY: true,
      typed: id,
    });
    const prompt = io.prompt.bind(io);
    io.prompt = async (q: string) => {
      questions.push(q);
      return prompt(q);
    };
    expect(await main(["users", "delete", BASE, id, "--reason", "request 7"], io)).toBe(0);
    expect(questions).toEqual([
      `Delete the account ${id}? This cannot be undone. Type the user id to confirm:`,
    ]);
    expect(await userRow(f, id)).toBeNull();
  });

  it("asks one question that names the fields and the user id, and writes nothing on a no", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com", "Ada");
    const io = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: DELETER },
      fetch: f.fetch,
      stdinIsTTY: true,
    });
    const questions: string[] = [];
    io.confirm = async (q: string) => {
      questions.push(q);
      return false;
    };
    const args = ["users", "update", BASE, id, "--no-image", "--reason", "ticket"];
    expect(await main(args, io)).toBe(2);
    expect(questions).toEqual([`Change the image of the user ${id}?`]);
    expect(io.stderr.at(-1)).toBe("stopped: no change: the answer was not yes");
    expect(f.paths).toEqual([]);
    // The confirmation rule of the other writes: no terminal, --no-input, and --token-file -.
    const pipe = await run([...args], f, { stdinIsTTY: false });
    expect(pipe.code).toBe(2);
    expect(pipe.io.stderr[0]).toBe(
      "users update asks for a confirmation: give --yes when no person can answer",
    );
    const quiet = await run([...args, "--no-input"], f, { stdinIsTTY: true });
    expect(quiet.io.stderr[0]).toBe(
      "users update asks for a confirmation: give --yes when no person can answer",
    );
    const stdin = await run([...args, "--token-file", "-"], f, {
      stdinIsTTY: true,
      stdin: DELETER,
    });
    expect(stdin.io.stderr[0]).toBe(
      "--token-file - reads the secret from stdin, so the command cannot ask: give --yes",
    );
    expect(f.paths).toEqual([]);
  });

  it("takes at least one change, and one form of each field, before any request", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    for (const [flags, error] of [
      [[], "give at least one of --name, --no-name, --image, and --no-image"],
      [["--name", "A", "--no-name"], "give one of --name and --no-name"],
      [["--image", "https://a.example/x.png", "--no-image"], "give one of --image and --no-image"],
    ] as const) {
      const r = await run(["users", "update", BASE, id, ...flags, "--reason", "r", "--yes"], f);
      expect(r.code, flags.join(" ")).toBe(2);
      expect(r.io.stderr[0], flags.join(" ")).toBe(error);
    }
    expect(f.paths).toEqual([]);
    // A value that core refuses names the two flags.
    const bad = await run(
      ["users", "update", BASE, id, "--image", "http://a.example/x.png", "--reason", "r", "--yes"],
      f,
    );
    expect(bad.code).toBe(2);
    expect(bad.io.stderr.at(-1)).toBe(
      "stopped: the deployment refused a value (invalid_body): --name is 1 to 200 UTF-16 code units with no control or format character, and --image is an https URL with a host, of at most 2048 characters, with no space",
    );
  });

  it("needs --yes or the typed user id for the delete, and makes no request without them", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    const args = ["users", "delete", BASE, id, "--reason", "request 7"];
    const usage = "users delete asks for a confirmation: give --yes when no person can answer";
    const pipe = await run([...args], f, { stdinIsTTY: false });
    expect(pipe.code).toBe(2);
    expect(pipe.io.stderr[0]).toBe(usage);
    const quiet = await run([...args, "--no-input"], f, { stdinIsTTY: true });
    expect(quiet.code).toBe(2);
    expect(quiet.io.stderr[0]).toBe(usage);
    const stdin = await run([...args, "--token-file", "-"], f, {
      stdinIsTTY: true,
      stdin: DELETER,
    });
    expect(stdin.code).toBe(2);
    expect(stdin.io.stderr[0]).toBe(
      "--token-file - reads the secret from stdin, so the command cannot ask: give --yes",
    );
    for (const r of [pipe, quiet, stdin]) expect(r.io.requests).toEqual([]);

    // A terminal: the question, and an answer that is not the user id. A yes is not the id.
    for (const answer of ["yes", "y", "", `${id} `.repeat(2), id.slice(1)]) {
      const io = fakeIo({
        env: { AUTHTEMPO_OPERATOR_SECRET: DELETER },
        fetch: f.fetch,
        stdinIsTTY: true,
        answer: true,
        typed: answer,
      });
      const questions: string[] = [];
      const prompt = io.prompt.bind(io);
      io.prompt = async (q: string) => {
        questions.push(q);
        return prompt(q);
      };
      expect(await main([...args], io), JSON.stringify(answer)).toBe(2);
      expect(questions).toEqual([
        `Delete the account ${id}? This cannot be undone. Type the user id to confirm:`,
      ]);
      expect(io.stderr.at(-1)).toBe("stopped: no delete: the answer was not the user id");
      expect(io.requests).toEqual([]);
    }
    expect(f.paths).toEqual([]);
    expect(await userRow(f, id)).not.toBeNull();

    // The typed user id deletes the account.
    const typed = await run([...args], f, { stdinIsTTY: true, typed: id });
    expect(typed.code).toBe(0);
    const [row] = await auditOf(f, id);
    expect(typed.io.stdout).toEqual([`deleted ${id}; audit row ${row?.id}`]);
    expect(row).toMatchObject({ action: "user_delete", reason: "request 7" });
    expect(await userRow(f, id)).toBeNull();
    expect(f.paths).toEqual(["POST /auth/operator/users/delete"]);
  });

  it("deletes the solo organizations with the account, and prints their ids", async () => {
    const f = fixture();
    const ada = await owner(f, "ada@example.com", "ada-team");
    const text = await run(["users", "delete", BASE, ada.id, "--reason", "request", "--yes"], f);
    expect(text.code).toBe(0);
    const [row] = await auditOf(f, ada.id);
    expect(text.io.stdout).toEqual([
      `deleted ${ada.id}; audit row ${row?.id}`,
      `deleted the organization ${ada.organizationId}`,
    ]);
    expect(row).toMatchObject({ data: { organizations: [ada.organizationId] } });

    const bea = await owner(f, "bea@example.com", "bea-team");
    const json = await run(
      ["users", "delete", BASE, bea.id, "--reason", "request", "--yes", "--json"],
      f,
    );
    expect(json.code).toBe(0);
    const doc = docOf(json.io.stdout);
    expect(Object.keys(doc).sort()).toEqual(["auditId", "exit", "organizations", "stopped"]);
    expect(doc).toMatchObject({ organizations: [bea.organizationId], exit: 0, stopped: null });
    expect(await userRow(f, bea.id)).toBeNull();
    const org = await f.storage.findOne("organization", [
      { field: "id", op: "eq", value: bea.organizationId },
    ]);
    expect(org).toBeNull();
  });

  it("names the scope on a 403", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    const del = await run(["users", "delete", BASE, id, "--reason", "r", "--yes"], f, {}, SUPPORT);
    expect(del.code).toBe(2);
    expect(del.io.stderr.at(-1)).toBe("stopped: the operator secret has no delete scope");
    const upd = await run(
      ["users", "update", BASE, id, "--name", "A", "--reason", "r", "--yes"],
      f,
      {},
      AUDITOR,
    );
    expect(upd.code).toBe(2);
    expect(upd.io.stderr.at(-1)).toBe("stopped: the operator secret has no users scope");
    expect(await userRow(f, id)).not.toBeNull();
    expect(await auditOf(f, id)).toEqual([]);
  });

  it("stops on sole_owner with the next step", async () => {
    const f = fixture();
    const ada = await owner(f, "ada@example.com", "shared-team");
    const beaId = await signUp(f, "bea@example.com");
    // A member needs a verified address.
    await verify(f, "bea@example.com");
    const added = await f.auth.api.addMember({
      user: ada.user,
      organizationId: ada.organizationId,
      userId: beaId,
      role: "member",
    });
    if (!added.ok) throw new Error(`the add answered ${added.code}`);
    for (const json of [false, true]) {
      const args = ["users", "delete", BASE, ada.id, "--reason", "request", "--yes"];
      const r = await run(json ? [...args, "--json"] : args, f);
      const stop =
        "the user is the last owner of an organization with other members, or of the platform organization; make another member an owner first";
      expect(r.code).toBe(2);
      expect(r.io.stderr.at(-1)).toBe(`stopped: ${stop}`);
      if (json)
        expect(docOf(r.io.stdout)).toEqual({
          organizations: [],
          auditId: "",
          exit: 2,
          stopped: stop,
        });
      else expect(r.io.stdout).toEqual([]);
    }
    expect(await userRow(f, ada.id)).not.toBeNull();
    expect(await auditOf(f, ada.id)).toEqual([]);
  });

  it("stops on a missing user, and names both limits on a 429 of the delete", async () => {
    const f = fixture();
    for (const args of [
      ["users", "update", BASE, "01NOSUCHUSER", "--name", "A", "--reason", "r", "--yes"],
      ["users", "delete", BASE, "01NOSUCHUSER", "--reason", "r", "--yes"],
    ]) {
      const r = await run(args, f);
      expect(r.code, args[1]).toBe(2);
      expect(r.io.stderr.at(-1), args[1]).toBe("stopped: no user has the id 01NOSUCHUSER");
    }
    // The deleter secret spends its 100 deletes of the hour: a delete with no user still counts.
    for (let i = 0; i < 99; i++)
      await f.fetch(`${OPERATOR}/users/delete`, {
        method: "POST",
        headers: { authorization: `Operator ${DELETER}`, "content-type": "application/json" },
        body: JSON.stringify({ userId: "01NOSUCHUSER", reason: "r" }),
      });
    const id = await signUp(f, "ada@example.com");
    const r429 = await run(["users", "delete", BASE, id, "--reason", "r", "--yes", "--json"], f);
    const stop =
      "the operator routes allow 600 calls per IP per hour, and 100 deletes per actor per hour; wait, then run it again";
    expect(r429.code).toBe(2);
    expect(r429.io.stderr.at(-1)).toBe(`stopped: ${stop}`);
    expect(docOf(r429.io.stdout)).toEqual({ ...STOP_JSON["users delete"], stopped: stop });
    expect(await userRow(f, id)).not.toBeNull();
    // Another secret is not counted: its update passes.
    const other = await run(
      ["users", "update", BASE, id, "--name", "A", "--reason", "r", "--yes"],
      f,
      {},
      SUPPORT,
    );
    expect(other.code).toBe(0);
  });

  it("prints the stop document of each write with --json", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    const update = await run(
      ["users", "update", BASE, id, "--name", "A", "--reason", "r", "--yes", "--json"],
      f,
      {},
      AUDITOR,
    );
    expect(update.code).toBe(2);
    expect(docOf(update.io.stdout)).toEqual({
      user: null,
      auditId: "",
      exit: 2,
      stopped: "the operator secret has no users scope",
    });
    const del = await run(
      ["users", "delete", BASE, id, "--reason", "r", "--yes", "--json"],
      f,
      {},
      SUPPORT,
    );
    expect(docOf(del.io.stdout)).toEqual({
      organizations: [],
      auditId: "",
      exit: 2,
      stopped: "the operator secret has no delete scope",
    });
    // A usage error prints the same shape.
    const usage = await run(["users", "update", BASE, id, "--reason", "r", "--json"], f);
    expect(docOf(usage.io.stdout)).toEqual({
      user: null,
      auditId: "",
      exit: 2,
      stopped: "give at least one of --name, --no-name, --image, and --no-image",
    });
  });

  it("scrubs the secret from every line", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    // The new name is the secret, so the answer of the update holds it unless the scrub holds it.
    const upd = await run(
      ["users", "update", BASE, id, "--name", DELETER, "--reason", "r", "--yes", "--json"],
      f,
    );
    expect(upd.code).toBe(0);
    expect((docOf(upd.io.stdout).user as { name: string }).name).toBe("***");
    for (const line of [...upd.io.stdout, ...upd.io.stderr]) expect(line).not.toContain(DELETER);
    const runs = [
      ["users", "update", BASE, id, "--name", "B", "--reason", "r", "--yes"],
      ["users", "delete", BASE, id, "--reason", "r", "--yes"],
    ];
    // A 401: the wrong secret is in no line.
    for (const args of runs) {
      const { code, io } = await run(args, f, {}, WRONG);
      expect(code, args[1]).toBe(2);
      expect(io.stderr.at(-1)).toBe("stopped: the deployment refused the operator secret");
      for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(WRONG);
    }
    for (const args of runs) {
      const { code, io } = await run(args, f);
      expect(code, args[1]).toBe(0);
      for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(DELETER);
    }
  });
});

describe("the argv values of the user tools (plan 12f2 final fix wave)", () => {
  const ADDRESS = "misplaced.person@example.com";

  it("names the place of a misplaced argument, never its value, and sends no request", async () => {
    const f = fixture();
    const id = await signUp(f, "ada@example.com");
    const write = ["--reason", "r", "--yes"];
    for (const [args, place] of [
      [["users", "create", BASE, ADDRESS, "--email", ADDRESS, ...write], "the base URL"],
      [["users", "list", BASE, ADDRESS], "the base URL"],
      [["users", "search", BASE, ADDRESS, "--email", ADDRESS], "the base URL"],
      [["users", "get", BASE, id, ADDRESS], "the user id"],
      [["users", "update", BASE, id, ADDRESS, "--name", "B", ...write], "the user id"],
      [["users", "delete", BASE, id, ADDRESS, ...write], "the user id"],
      [["sessions", "end", BASE, id, ADDRESS, ...write], "the user id"],
      [["sessions", "end-all", BASE, ADDRESS, ...write], "the base URL"],
      [["audit", "list", BASE, ADDRESS], "the base URL"],
    ] as const) {
      const r = await run([...args], f, {}, SUPPORT);
      const label = args.slice(0, 2).join(" ");
      expect(r.code, label).toBe(2);
      expect(r.io.stderr[0], label).toBe(
        `unexpected argument after ${place}: give each value with its flag`,
      );
      for (const line of [...r.io.stdout, ...r.io.stderr])
        expect(line, label).not.toContain("misplaced");
      expect(r.io.requests, label).toEqual([]);
    }
    expect(f.paths).toEqual([]);
  });

  it("stops on an empty user id before the question, so an empty typed line cannot act", async () => {
    const f = fixture();
    for (const [args, id] of [
      [["users", "delete", BASE, "", "--reason", "r"], ""],
      [["users", "delete", BASE, " ", "--reason", "r"], " "],
      [["users", "update", BASE, "", "--name", "B", "--reason", "r"], ""],
    ] as const) {
      const io = fakeIo({
        env: { AUTHTEMPO_OPERATOR_SECRET: DELETER },
        fetch: f.fetch,
        stdinIsTTY: true,
        answer: true,
        typed: id,
      });
      const questions: string[] = [];
      for (const kind of ["confirm", "prompt"] as const) {
        const asked = io[kind].bind(io) as (q: string) => Promise<never>;
        io[kind] = async (q: string) => {
          questions.push(q);
          return asked(q);
        };
      }
      expect(await main([...args], io), args[1]).toBe(2);
      expect(io.stderr[0], args[1]).toBe("name the user id after the base URL");
      expect(questions, args[1]).toEqual([]);
      expect(io.requests, args[1]).toEqual([]);
    }
    expect(f.paths).toEqual([]);
  });

  it("puts each question through the scrub and the control character rule", async () => {
    const f = fixture();
    // A user id with an escape, and a user id that is the secret: the question shows neither.
    for (const [id, shown] of [
      ["01J8\u001b]0;x\u0007Z", "01J8?]0;x?Z"],
      [DELETER, "***"],
    ] as const) {
      const io = fakeIo({
        env: { AUTHTEMPO_OPERATOR_SECRET: DELETER },
        fetch: f.fetch,
        stdinIsTTY: true,
        answer: false,
      });
      const questions: string[] = [];
      for (const kind of ["confirm", "prompt"] as const) {
        const asked = io[kind].bind(io) as (q: string) => Promise<never>;
        io[kind] = async (q: string) => {
          questions.push(q);
          return asked(q);
        };
      }
      expect(await main(["users", "delete", BASE, id, "--reason", "r"], io)).toBe(2);
      expect(await main(["users", "update", BASE, id, "--name", "B", "--reason", "r"], io)).toBe(2);
      expect(questions).toEqual([
        `Delete the account ${shown}? This cannot be undone. Type the user id to confirm:`,
        expect.stringContaining(`user ${shown}`),
      ]);
      for (const q of questions) {
        expect(q).not.toContain(DELETER);
        for (const c of ["\u001b", "\u0007"]) expect(q).not.toContain(c);
      }
      expect(io.requests).toEqual([]);
    }
    expect(f.paths).toEqual([]);
  });
});

describe("users create (plan 12f2 Task 6, Wave B)", () => {
  const ADDRESS = "new.person@example.com";
  const PHONE = "+14155550199";
  /** The phone config of plan 12i, with an SMS sender that sends nothing. */
  const phoneOn = () =>
    fixture({
      phone: {
        sms: { send: async () => "sent" as const },
        regions: ["+1"],
        isolateLimiter: "allow",
        signUp: true,
      },
    });
  const create = (flags: readonly string[]) => [
    "users",
    "create",
    BASE,
    ...flags,
    "--reason",
    "ticket 9",
  ];
  /** Every line of a run, for the checks that no line holds a value. */
  const lines = (io: { stdout: readonly string[]; stderr: readonly string[] }) => [
    ...io.stdout,
    ...io.stderr,
  ];
  /** The users of an address, through the API of the app. */
  async function usersOf(f: Fixture, email: string) {
    const found = await f.auth.api.operator.users.search({ actor: APP, email });
    if (!found.ok) throw new Error(found.code);
    return found.value.users;
  }

  it("creates a user and prints the id and the next step, with no address on any line", async () => {
    const f = phoneOn();
    const cases = [
      {
        flags: ["--email", ADDRESS],
        mails: 1,
        next: "Next: the person signs in with the mailed link.",
        row: { email: ADDRESS, emailVerified: false, phone: null },
      },
      {
        flags: ["--email", "reset.person@example.com", "--first-sign-in", "reset"],
        mails: 1,
        next: "Next: the person sets a password with the mailed reset link.",
        row: { email: "reset.person@example.com", emailVerified: false },
      },
      {
        flags: ["--email", "none.person@example.com", "--verified", "--first-sign-in", "none"],
        mails: 0,
        next: "Next: the person signs in by any proof of the address.",
        row: { email: "none.person@example.com", emailVerified: true },
      },
      {
        flags: ["--phone", PHONE, "--name", "Pat"],
        mails: 0,
        next: "Next: the person signs in with a phone code.",
        row: { email: null, phone: PHONE, name: "Pat" },
      },
    ];
    for (const c of cases) {
      const before = f.mails.length;
      const r = await run([...create(c.flags), "--yes"], f, {}, SUPPORT);
      expect(r.code, c.next).toBe(0);
      expect(r.io.stdout, c.next).toHaveLength(1);
      const id = r.io.stdout[0] ?? "";
      const [row] = await auditOf(f, id);
      expect(row).toMatchObject({ action: "user_create", reason: "ticket 9" });
      expect(r.io.stderr).toEqual([
        `posting ${OPERATOR}/users/create`,
        `created the user ${id}; audit row ${row?.id}`,
        c.next,
      ]);
      expect(await userRow(f, id)).toMatchObject(c.row);
      expect(f.mails.length - before, c.next).toBe(c.mails);
      const value = c.flags[1] ?? "";
      for (const line of lines(r.io)) expect(line, c.next).not.toContain(value);
    }
    // The body sends the address null with --phone, and core wrote no address.
    expect(f.mails.map((m) => m.to)).toEqual([ADDRESS, "reset.person@example.com"]);
  });

  it("takes exactly one of --email and --phone, and checks the flags before any request", async () => {
    const f = phoneOn();
    const one = "give exactly one of --email and --phone";
    const phoneOnly =
      "--verified and --first-sign-in invite or reset need --email: a user with no address signs in with a phone code";
    for (const [flags, error] of [
      [[], one],
      [["--email", ADDRESS, "--phone", PHONE], one],
      [["--phone", PHONE, "--verified"], phoneOnly],
      [["--phone", PHONE, "--first-sign-in", "invite"], phoneOnly],
      [["--phone", PHONE, "--first-sign-in", "reset"], phoneOnly],
      [
        ["--email", ADDRESS, "--first-sign-in", "magic"],
        "--first-sign-in is one of invite, reset, none",
      ],
    ] as const) {
      const r = await run([...create(flags), "--yes"], f, {}, SUPPORT);
      expect(r.code, flags.join(" ")).toBe(2);
      expect(r.io.stderr[0], flags.join(" ")).toBe(error);
      expect(r.io.requests, flags.join(" ")).toEqual([]);
    }
    const extra = await run(
      ["users", "create", BASE, "more", "--email", ADDRESS, "--reason", "r", "--yes"],
      f,
    );
    expect(extra.io.stderr[0]).toBe(
      "unexpected argument after the base URL: give each value with its flag",
    );
    const noReason = await run(["users", "create", BASE, "--email", ADDRESS, "--yes"], f);
    expect(noReason.io.stderr[0]).toBe(
      "give --reason <text>: each write needs a reason for its audit row",
    );
    expect(f.paths).toEqual([]);
    expect(await usersOf(f, ADDRESS)).toEqual([]);

    // A value that core refuses names the rules of the flags.
    const stop =
      "stopped: the deployment refused a value (invalid_body): --email is an address with 1 to 64 characters before the @ and a dot in the domain, --name is 1 to 200 UTF-16 code units with no control or format character, --image is an https URL with a host, of at most 2048 characters, with no space, --phone needs the phone config of the deployment, and --first-sign-in reset needs the password config";
    const image = await run(
      [...create(["--email", ADDRESS, "--image", "http://a.example/x.png"]), "--yes"],
      f,
      {},
      SUPPORT,
    );
    expect(image.code).toBe(2);
    expect(image.io.stderr.at(-1)).toBe(stop);
    const noPhone = await run([...create(["--phone", PHONE]), "--yes"], fixture(), {}, SUPPORT);
    expect(noPhone.io.stderr.at(-1)).toBe(stop);
    expect(await usersOf(f, ADDRESS)).toEqual([]);
  });

  it("never prints the invitation token or the reset token", async () => {
    const f = fixture();
    for (const [json, mode] of [
      [false, "invite"],
      [true, "invite"],
      [false, "reset"],
      [true, "reset"],
    ] as const) {
      const email = `${mode}.${json ? "json" : "text"}@example.com`;
      const args = [...create(["--email", email, "--first-sign-in", mode]), "--yes"];
      const r = await run(json ? [...args, "--json"] : args, f, {}, SUPPORT);
      expect(r.code, email).toBe(0);
      const mail = f.mails.find((m) => m.to === email);
      const token = decodeURIComponent(
        /token=([A-Za-z0-9_%.-]+)/.exec(mail?.text ?? "")?.[1] ?? "",
      );
      if (mode === "invite") expect(token).toMatch(/^ui_./);
      expect(token.length, email).toBeGreaterThan(20);
      for (const line of lines(r.io)) {
        expect(line, email).not.toContain(token);
        expect(line, email).not.toContain(token.slice(3));
        expect(line, email).not.toContain(email);
      }
      if (!json) continue;
      const doc = docOf(r.io.stdout);
      expect(Object.keys(doc).sort()).toEqual(["auditId", "exit", "mailed", "stopped", "userId"]);
      const [row] = await auditOf(f, String(doc.userId));
      expect(doc).toEqual({
        userId: row?.targetUserId,
        mailed: mode,
        auditId: row?.id,
        exit: 0,
        stopped: null,
      });
    }
  });

  it("asks one question with no address, and follows the confirmation rule of the other writes", async () => {
    const f = phoneOn();
    const questions: string[] = [];
    for (const [flags, question] of [
      [["--email", ADDRESS], "Create a user, and mail the invitation link to the address?"],
      [
        ["--email", ADDRESS, "--first-sign-in", "reset"],
        "Create a user, and mail a reset link to the address?",
      ],
      [
        ["--email", ADDRESS, "--first-sign-in", "none"],
        "Create a user with the address, and mail nothing?",
      ],
      [["--phone", PHONE], "Create a user with the phone number? No SMS goes out now."],
    ] as const) {
      const io = fakeIo({
        env: { AUTHTEMPO_OPERATOR_SECRET: SUPPORT },
        fetch: f.fetch,
        stdinIsTTY: true,
      });
      io.confirm = async (q: string) => {
        questions.push(q);
        return false;
      };
      expect(await main(create(flags), io)).toBe(2);
      expect(questions.at(-1)).toBe(question);
      expect(io.stderr.at(-1)).toBe("stopped: no create: the answer was not yes");
      expect(io.requests).toEqual([]);
    }
    expect(questions).toHaveLength(4);
    const usage = "users create asks for a confirmation: give --yes when no person can answer";
    const args = create(["--email", ADDRESS]);
    const pipe = await run([...args], f, { stdinIsTTY: false, answer: true }, SUPPORT);
    expect(pipe.code).toBe(2);
    expect(pipe.io.stderr[0]).toBe(usage);
    const quiet = await run(
      [...args, "--no-input"],
      f,
      { stdinIsTTY: true, answer: true },
      SUPPORT,
    );
    expect(quiet.io.stderr[0]).toBe(usage);
    const stdin = await run([...args, "--token-file", "-"], f, {
      stdinIsTTY: true,
      answer: true,
      stdin: SUPPORT,
    });
    expect(stdin.io.stderr[0]).toBe(
      "--token-file - reads the secret from stdin, so the command cannot ask: give --yes",
    );
    for (const r of [pipe, quiet, stdin]) expect(r.io.requests).toEqual([]);
    expect(f.paths).toEqual([]);
    expect(await usersOf(f, ADDRESS)).toEqual([]);
    // A yes on a terminal creates the user.
    const yes = await run(args, f, { stdinIsTTY: true, answer: true }, SUPPORT);
    expect(yes.code).toBe(0);
    expect((await usersOf(f, ADDRESS)).map((u) => u.id)).toEqual(yes.io.stdout);
  });

  it("names the scope on a 403, and stops on a taken address or phone number", async () => {
    const f = phoneOn();
    const denied = await run([...create(["--email", ADDRESS]), "--yes"], f, {}, AUDITOR);
    expect(denied.code).toBe(2);
    expect(denied.io.stderr.at(-1)).toBe("stopped: the operator secret has no users scope");
    expect(await usersOf(f, ADDRESS)).toEqual([]);

    await signUp(f, ADDRESS);
    const mails = f.mails.length;
    const taken = "an account holds this address; find it with users search";
    for (const json of [false, true]) {
      const args = [...create(["--email", ADDRESS]), "--yes"];
      const r = await run(json ? [...args, "--json"] : args, f, {}, SUPPORT);
      expect(r.code).toBe(2);
      expect(r.io.stderr.at(-1)).toBe(`stopped: ${taken}`);
      if (json)
        expect(docOf(r.io.stdout)).toEqual({ ...STOP_JSON["users create"], stopped: taken });
      else expect(r.io.stdout).toEqual([]);
      for (const line of lines(r.io)) expect(line).not.toContain(ADDRESS);
    }
    expect(f.mails.length).toBe(mails);
    expect(await usersOf(f, ADDRESS)).toHaveLength(1);

    const first = await run([...create(["--phone", PHONE]), "--yes"], f, {}, SUPPORT);
    expect(first.code).toBe(0);
    const again = await run([...create(["--phone", PHONE]), "--yes"], f, {}, SUPPORT);
    expect(again.code).toBe(2);
    expect(again.io.stderr.at(-1)).toBe("stopped: an account holds this phone number");
    for (const line of lines(again.io)) expect(line).not.toContain(PHONE);
  });

  it("names both limits on a 429 of the create", async () => {
    const f = fixture();
    // The support secret spends its 200 creates of the hour: a refused body still counts.
    for (let i = 0; i < 200; i++)
      await f.fetch(`${OPERATOR}/users/create`, {
        method: "POST",
        headers: { authorization: `Operator ${SUPPORT}`, "content-type": "application/json" },
        body: JSON.stringify({ email: null, reason: "r" }),
      });
    const r = await run([...create(["--email", ADDRESS]), "--yes", "--json"], f, {}, SUPPORT);
    const stop =
      "the operator routes allow 600 calls per IP per hour, and 200 creates per actor per hour; wait, then run it again";
    expect(r.code).toBe(2);
    expect(r.io.stderr.at(-1)).toBe(`stopped: ${stop}`);
    expect(docOf(r.io.stdout)).toEqual({ ...STOP_JSON["users create"], stopped: stop });
    expect(await usersOf(f, ADDRESS)).toEqual([]);
    // Another secret is not counted: its create passes.
    const other = await run([...create(["--email", ADDRESS]), "--yes"], f, {}, DELETER);
    expect(other.code).toBe(0);
  });

  it("warns and exits 1 when the deployment created the user but mailed no link", async () => {
    const f = fixture({
      mail: {
        send: async () => {
          throw new Error("the mail supplier is down");
        },
      },
    });
    const warning =
      "warning: the user was created, but no link went out: the mail failed (read operator.create_mail_failed in the log of the deployment), or the domain of the address enforces SSO. The person can sign in by any other proof of the address.";
    const text = await run([...create(["--email", ADDRESS]), "--yes"], f, {}, SUPPORT);
    expect(text.code).toBe(1);
    const id = text.io.stdout[0] ?? "";
    expect(text.io.stdout).toEqual([id]);
    expect(text.io.stderr.slice(1)).toEqual([expect.stringMatching(/^created the user /), warning]);
    expect(await userRow(f, id)).toMatchObject({ email: ADDRESS });
    const json = await run(
      [...create(["--email", "two@example.com", "--first-sign-in", "reset"]), "--yes", "--json"],
      f,
      {},
      SUPPORT,
    );
    expect(json.code).toBe(1);
    expect(docOf(json.io.stdout)).toMatchObject({ mailed: null, exit: 1, stopped: null });
    expect(json.io.stderr.at(-1)).toBe(warning);
  });

  it("scrubs the secret from every line", async () => {
    const f = fixture();
    // A 401: the wrong secret is in no line.
    const wrong = await run([...create(["--email", ADDRESS]), "--yes"], f, {}, WRONG);
    expect(wrong.code).toBe(2);
    expect(wrong.io.stderr.at(-1)).toBe("stopped: the deployment refused the operator secret");
    for (const line of lines(wrong.io)) expect(line).not.toContain(WRONG);
    // The name is the secret: no line holds it.
    const named = await run(
      [...create(["--email", ADDRESS, "--name", SUPPORT]), "--yes", "--json"],
      f,
      {},
      SUPPORT,
    );
    expect(named.code).toBe(0);
    for (const line of lines(named.io)) expect(line).not.toContain(SUPPORT);
    const [user] = await usersOf(f, ADDRESS);
    expect(user?.name).toBe(SUPPORT);
  });
});
