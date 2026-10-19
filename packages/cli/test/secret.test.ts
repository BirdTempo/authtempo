// `authtempo secret` (plan 11c2 Task 2): a new app secret or operator secret
// from 32 random bytes. The memory io tests inject the random source; the
// real io tests prove the file mode and the refusal of a path that exists.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth, createMemoryAdapter } from "@authtempo/core";
import { isOperatorSecret } from "@authtempo/core/operator-secret";
import { afterAll, describe, expect, it } from "vitest";
import { secretCommand } from "../src/commands/secret.js";
import { type Io, nodeIo } from "../src/io.js";
import { SECRET_JSON_KEYS } from "../src/json.js";
import { main } from "../src/main.js";
import { guarded } from "../src/output.js";
import { fakeIo } from "./support/fake-io.js";

/** 43 characters of the base64url alphabet with no padding: 32 bytes. */
const VALUE = /^[A-Za-z0-9_-]{43}$/;
/** The base64url text of the counter bytes 0 to 31 of the fake io: 28 distinct characters, so 206 bits. */
const COUNTER_VALUE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

const zeros = (n: number) => new Uint8Array(n);
const counter = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
/** A new empty folder for a run of the real io. */
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-secret-"));
  made.push(dir);
  return dir;
};

/** The real io with its files and its random source, with the lines kept in memory and `cwd` in a new folder. */
function realIo(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    ...nodeIo(),
    cwd: fresh(),
    stdout,
    stderr,
    out: (line) => {
      stdout.push(line);
    },
    err: (line) => {
      stderr.push(line);
    },
  };
}

/** The one JSON document of a `--json` run. */
function docOf(stdout: readonly string[]): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "") as Record<string, unknown>;
}

describe("authtempo secret (plan 11c2)", () => {
  it("prints 43 base64url characters that decode to 32 bytes, as the one stdout line", async () => {
    const io = fakeIo({ random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) });
    expect(await main(["secret"], io)).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const line = io.stdout[0] ?? "";
    expect(line).toMatch(VALUE);
    expect(Buffer.from(line, "base64url").length).toBe(32);
    for (const l of io.stderr) expect(l).not.toContain(line);
    expect(io.stderr).toContain("Store this value now. authtempo keeps no copy of it.");
  });

  it("scrubs the value from each line after its one print", async () => {
    const io = fakeIo();
    const ctx = guarded(io);
    expect(await secretCommand.run([], ctx)).toBe(0);
    const value = io.stdout[0] ?? "";
    expect(value).toMatch(VALUE);
    ctx.out(value);
    ctx.err(value);
    expect(io.stdout[1]).toBe("***");
    expect(io.stderr.at(-1)).toBe("***");
  });

  it("draws again under 120 bits, and stops after three weak draws", async () => {
    let draws = 0;
    const weak = fakeIo({
      random: (n) => {
        draws++;
        return zeros(n);
      },
    });
    expect(await main(["secret"], weak)).toBe(2);
    expect(draws).toBe(3);
    expect(weak.stdout).toEqual([]);
    expect(weak.stderr).toContain(
      "stopped: the random source gave 3 values under 120 bits; nothing was printed",
    );

    let n = 0;
    const once = fakeIo({ random: (size) => (n++ === 0 ? zeros(size) : counter(size)) });
    expect(await main(["secret"], once)).toBe(0);
    expect(once.stdout).toEqual([COUNTER_VALUE]);
    expect(n).toBe(2);
  });

  it("writes a new 0600 file with the value and one newline, and prints no value", async () => {
    const io = fakeIo();
    expect(await main(["secret", "--version", "2", "--out", "s.txt"], io)).toBe(0);
    const text = io.files.get("/work/s.txt") ?? "";
    expect(text).toHaveLength(44);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, 43)).toMatch(VALUE);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toContain("writing /work/s.txt");
    for (const l of [...io.stdout, ...io.stderr]) expect(l).not.toContain(text.slice(0, 43));

    const json = fakeIo();
    expect(await main(["secret", "--version", "2", "--out", "s.txt", "--json"], json)).toBe(0);
    const doc = docOf(json.stdout);
    expect(doc).toMatchObject({
      kind: "app",
      value: null,
      version: 2,
      bytes: 32,
      out: "/work/s.txt",
      secretHash: null,
      exit: 0,
      stopped: null,
    });
    expect(doc.estimateBits).toBe(206);
    const written = json.files.get("/work/s.txt")?.slice(0, 43) ?? "";
    expect(written).toMatch(VALUE);
    for (const l of [...json.stdout, ...json.stderr]) expect(l).not.toContain(written);
  });

  it("writes mode 0600 with the real io", async () => {
    const io = realIo();
    expect(await main(["secret", "--version", "3", "--out", "s.txt"], io)).toBe(0);
    const path = join(io.cwd, "s.txt");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).toHaveLength(44);
    expect(text.slice(0, 43)).toMatch(VALUE);
    expect(io.stdout).toEqual([]);
  });

  it("refuses a path that exists, and a link to a missing file, and changes no byte", async () => {
    const io = realIo();
    const taken = join(io.cwd, "taken.txt");
    const link = join(io.cwd, "link.txt");
    const missing = join(io.cwd, "missing.txt");
    io.writeNew(taken, "old");
    symlinkSync(missing, link);

    expect(await main(["secret", "--version", "2", "--out", "taken.txt"], io)).toBe(2);
    expect(readFileSync(taken, "utf8")).toBe("old");
    expect(io.stderr.at(-1)).toBe(
      `stopped: ${taken} exists: the command refuses a path that exists, because a replaced secret locks out each second-factor user`,
    );
    expect(io.stdout).toEqual([]);

    expect(await main(["secret", "--operator", "--out", "link.txt"], io)).toBe(2);
    expect(existsSync(missing)).toBe(false);
    expect(io.stderr.at(-1)).toContain(`stopped: ${link} exists`);
    expect(io.stdout).toEqual([]);
  });

  it("needs --version or --operator for --out, and refuses --operator with --version", async () => {
    const cases: [string[], string][] = [
      [
        ["--out", "s.txt"],
        "--out needs --version or --operator, so the result names what the file holds",
      ],
      [
        ["--operator", "--version", "2"],
        "--operator makes an operator secret: do not give --version",
      ],
      [["nonsense"], "secret has the subcommands status and rewrap, or no positional"],
    ];
    for (const [args, line] of cases) {
      let draws = 0;
      const io = fakeIo({
        random: (n) => {
          draws++;
          return counter(n);
        },
      });
      expect(await main(["secret", ...args], io), args.join(" ")).toBe(2);
      expect(io.stderr[0], args.join(" ")).toBe(line);
      expect(io.stdout).toEqual([]);
      expect(draws, args.join(" ")).toBe(0);
    }
  });

  it("refuses a version outside 1 to 999999", async () => {
    for (const bad of ["0", "1000000", "1.5", "x"]) {
      const io = fakeIo();
      expect(await main(["secret", "--version", bad], io), bad).toBe(2);
      expect(io.stderr[0], bad).toBe("--version is a whole number from 1 to 999999");
      expect(io.stdout).toEqual([]);
    }
    const ok = fakeIo();
    expect(await main(["secret", "--version", "999999"], ok)).toBe(0);
    expect(ok.stdout).toEqual([COUNTER_VALUE]);
    expect(ok.stderr).toContain(
      "Next: add { version: 999999, value } to secrets after the current version, and deploy. Make it the current version in a second deploy.",
    );
  });

  it("makes an operator secret that the operator route of core accepts", async () => {
    const io = fakeIo({ random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) });
    expect(await main(["secret", "--operator", "--json"], io)).toBe(0);
    const doc = docOf(io.stdout);
    const value = doc.value;
    const secretHash = doc.secretHash;
    if (typeof value !== "string" || typeof secretHash !== "string")
      throw new Error("the document has no value or no secretHash");
    expect(isOperatorSecret(value)).toBe(true);
    expect(doc).toMatchObject({ kind: "operator", version: null, bytes: 32, out: null });
    expect(io.stderr).toContain(
      "Next: set operator.secretHash to this hash, and give the secret to authtempo in AUTHTEMPO_OPERATOR_SECRET.",
    );
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      operator: { secretHash },
    });
    const res = await auth.handle(
      new Request("https://api.example.com/auth/operator/keys/rotate", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.7", authorization: `Operator ${value}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { kid?: unknown }).kid).toBe("string");

    const plain = fakeIo();
    expect(await main(["secret", "--operator"], plain)).toBe(0);
    expect(plain.stdout).toHaveLength(2);
    expect(plain.stdout[0]).toBe(COUNTER_VALUE);
    expect(plain.stdout[1]).toMatch(/^secretHash: [0-9a-f]{64}$/);
  });

  it("holds SecretJson to its key list", async () => {
    const io = fakeIo();
    expect(await main(["secret", "--version", "1", "--json"], io)).toBe(0);
    const doc = docOf(io.stdout);
    expect(Object.keys(doc).sort()).toEqual(Object.keys(SECRET_JSON_KEYS).sort());
    expect(doc).toEqual({
      kind: "app",
      value: COUNTER_VALUE,
      version: 1,
      bytes: 32,
      estimateBits: 206,
      out: null,
      secretHash: null,
      exit: 0,
      stopped: null,
    });
  });
});
