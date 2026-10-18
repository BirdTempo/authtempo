// The three Io members of plan 11c2 on the real io: the random source, the
// new private file, and the runtime. Each test runs in its own temporary folder.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeIo } from "../src/io.js";

const dir = mkdtempSync(join(tmpdir(), "authtempo-io-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("nodeIo (plan 11c2)", () => {
  const io = nodeIo();

  it("draws the asked count of random bytes, and two draws differ", () => {
    const a = io.randomBytes(32);
    const b = io.randomBytes(32);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(io.randomBytes(7).length).toBe(7);
  });

  it("writes a new private file with mode 0600, and refuses a path that exists and a link to a missing file", () => {
    const p = join(dir, "new.txt");
    io.writeNewPrivate(p, "first\n");
    expect(readFileSync(p, "utf8")).toBe("first\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // A path that exists keeps its text.
    expect(() => io.writeNewPrivate(p, "second\n")).toThrow();
    expect(readFileSync(p, "utf8")).toBe("first\n");
    // A link to a missing file makes no file at the link's target.
    const link = join(dir, "link");
    symlinkSync(join(dir, "missing"), link);
    expect(() => io.writeNewPrivate(link, "x")).toThrow();
    expect(existsSync(join(dir, "missing"))).toBe(false);
    // No folder is made on the way: a path under a missing folder throws.
    expect(() => io.writeNewPrivate(join(dir, "no-such", "file.txt"), "x")).toThrow();
    expect(existsSync(join(dir, "no-such"))).toBe(false);
  });

  it("reports the runtime of the process", () => {
    expect(io.runtime).toEqual({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
  });
});
