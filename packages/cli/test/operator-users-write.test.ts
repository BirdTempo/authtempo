// The operator commands users update and users delete of plan 12f2 Task 6
// (Wave A; users create comes with Wave B). Each request goes to a real core
// handle, so each answer is an answer that core can give. Each state comes
// through the API, never by a row write.
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
function fixture() {
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
