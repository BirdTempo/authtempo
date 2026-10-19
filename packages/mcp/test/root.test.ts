import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { confinedIo, insideRoot, RootError } from "../src/cli-io.js";
import { CLI_TEMPLATES, localTools } from "../src/local-tools.js";
import { createServer } from "../src/server.js";
import { REPO } from "./support/bin.js";
import { connect } from "./support/client.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

// The root rule (plan 11e): every path of a tool resolves, with each link
// resolved by realpath, inside the server root. A path outside it is a tool
// fault, and nothing is written.

/**
 * A swap that another process could make: when mkdirSync makes the folder
 * `made`, the mock puts a link to `to` at that name. Off while `made` is null.
 */
const swap = vi.hoisted(() => ({ made: null as string | null, to: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const mkdirSync = (...args: Parameters<typeof fs.mkdirSync>) => {
    const r = fs.mkdirSync(...args);
    const made = swap.made;
    if (made !== null && String(args[0]).startsWith(made)) {
      swap.made = null;
      fs.rmSync(made, { recursive: true, force: true });
      fs.symlinkSync(swap.to, made);
    }
    return r;
  };
  return { ...fs, default: { ...fs, mkdirSync }, mkdirSync };
});

let fx: FixtureRoot | undefined;
beforeAll(() => {
  assertFreshIndex();
});
afterEach(() => {
  fx?.remove();
  fx = undefined;
});

const env = { PATH: process.env.PATH ?? "" };

describe("the root rule", () => {
  it("refuses a folder outside the root, by .. and by a symbolic link", async () => {
    const f = fixtureRoot();
    fx = f;
    const s = await connect(
      createServer({
        surface: "local",
        index: siteIndex(),
        skills: [],
        root: f.root,
        env,
        local: localTools,
      }),
    );
    try {
      for (const dir of ["../x", "link/app", join(f.outside, "app"), "../root2/app"]) {
        const r = await s.call("scaffold", { dir, stack: "node" });
        expect(r.isError, dir).toBe(true);
        expect(r.texts.join("\n"), dir).toContain("outside the server root");
      }
    } finally {
      await s.close();
    }
    // No new file anywhere: the base holds the root and the outside folder, and the root its link.
    expect(f.around()).toEqual({ base: ["outside", "root"], outside: [] });
    expect(readdirSync(f.root)).toEqual(["link"]);
  });

  it("answers the path inside the root, at a / boundary", () => {
    const f = fixtureRoot();
    fx = f;
    expect(insideRoot(f.root, ".")).toBe(f.root);
    expect(insideRoot(f.root, "a/b/c")).toBe(join(f.root, "a/b/c"));
    // base/root2 starts with the text of base/root, but it is not under it.
    expect(() => insideRoot(f.root, "../root2")).toThrow(RootError);
    expect(() => insideRoot(f.root, "link")).toThrow("outside the server root");
  });

  it("refuses a write through a link that a step makes during the run", () => {
    const f = fixtureRoot();
    fx = f;
    const { io } = confinedIo({ root: f.root, env, allowFetch: false });
    // The check before the run passes: the folder does not exist yet.
    expect(insideRoot(f.root, "made/app")).toBe(join(f.root, "made/app"));
    // A step of the run puts a link to the outside folder at that name.
    symlinkSync(f.outside, join(f.root, "made"));
    expect(() => io.writeNew(join(f.root, "made/app/package.json"), "{}\n")).toThrow(
      "outside the server root",
    );
    expect(() => io.writePrivate(join(f.root, "made/app/.env"), "x\n")).toThrow(
      "outside the server root",
    );
    expect(f.around().outside).toEqual([]);
  });

  it("refuses a write when another process swaps the new folder for a link during mkdir", () => {
    const f = fixtureRoot();
    fx = f;
    // The outside folder has the same names, so a write through the link would land there.
    mkdirSync(join(f.outside, "app"));
    const { io } = confinedIo({ root: f.root, env, allowFetch: false });
    swap.made = join(f.root, "made");
    swap.to = f.outside;
    expect(() => io.writeNew(join(f.root, "made/app/package.json"), "{}\n")).toThrow(
      "outside the server root",
    );
    expect(swap.made).toBeNull();
    expect(f.around().outside).toEqual(["app"]);
    rmSync(join(f.root, "made"));
  });

  it("writes a new file inside the root, and refuses a file that exists", () => {
    const f = fixtureRoot();
    fx = f;
    const { io } = confinedIo({ root: f.root, env, allowFetch: false });
    io.writeNew(join(f.root, "a/b.txt"), "one\n");
    expect(io.readFile("a/b.txt")).toBe("one\n");
    expect(() => io.writeNew(join(f.root, "a/b.txt"), "two\n")).toThrow("exists");
    expect(() => io.replaceFile(join(f.root, "a/b.txt"), "two\n")).toThrow(
      "no tool rewrites a file",
    );
    expect(io.readFile("a/b.txt")).toBe("one\n");
  });

  it("writes no secret file: writeNewPrivate throws a RootError and makes no file", () => {
    const f = fixtureRoot();
    fx = f;
    const { io } = confinedIo({ root: f.root, env, allowFetch: false });
    const path = join(f.root, ".dev.vars");
    expect(() => io.writeNewPrivate(path, "AUTH_SECRET=x\n")).toThrow(RootError);
    expect(() => io.writeNewPrivate(path, "AUTH_SECRET=x\n")).toThrow(
      "the MCP server writes no secret file",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("reads, lists, and tests no path outside the root", () => {
    const f = fixtureRoot();
    fx = f;
    mkdirSync(join(f.outside, "secret"));
    const { io } = confinedIo({ root: f.root, env, allowFetch: false });
    expect(() => io.readFile(join(f.outside, "x"))).toThrow(RootError);
    expect(() => io.exists("link/secret")).toThrow(RootError);
    expect(() => io.listDir("link")).toThrow(RootError);
    expect(() => io.realpath("link")).toThrow(RootError);
    expect(existsSync(join(f.outside, "secret"))).toBe(true);
  });

  it("answers the mode of a file inside the root, and no mode of a path outside it", () => {
    const f = fixtureRoot();
    fx = f;
    const { io } = confinedIo({ root: f.root, env, allowFetch: false });
    // The file mode warning of the CLI reads these (plan 11f): the real bits, not a fixed answer.
    for (const [name, mode] of [
      ["open.csv", 0o644],
      ["own.csv", 0o600],
    ] as const) {
      writeFileSync(join(f.root, name), "id\n");
      chmodSync(join(f.root, name), mode);
      expect(io.fileMode(name), name).toBe(mode);
    }
    writeFileSync(join(f.outside, "x.csv"), "id\n");
    expect(() => io.fileMode(join(f.outside, "x.csv"))).toThrow(RootError);
    expect(() => io.fileMode("link/x.csv")).toThrow(RootError);
  });

  it("reads the init templates of the CLI, and no other file of its dist folder", () => {
    const f = fixtureRoot();
    fx = f;
    const dist = join(REPO, "packages/cli/dist");
    expect(CLI_TEMPLATES).toBe(join(dist, "templates.json"));
    const { io } = confinedIo({ root: f.root, env, allowFetch: false, readOnly: [CLI_TEMPLATES] });
    expect(io.readFile(join(dist, "templates.json")).length).toBeGreaterThan(0);
    expect(() => io.readFile(join(dist, "program.js"))).toThrow(RootError);
    expect(() => io.listDir(dist)).toThrow(RootError);
  });

  it("runs no child process and makes no fetch", async () => {
    const f = fixtureRoot();
    fx = f;
    const { io, lines } = confinedIo({ root: f.root, env, allowFetch: false });
    await expect(io.run("node", ["--version"], { cwd: f.root })).rejects.toThrow(
      "this tool runs no child process",
    );
    await expect(io.fetch("https://example.com/", {})).rejects.toThrow(
      "this tool makes no network call",
    );
    expect(() => io.readStdin()).toThrow("no stdin in the MCP server");
    expect(await io.confirm("Go on?")).toBe(false);
    expect(io.stdinIsTTY).toBe(false);
    expect(io.cwd).toBe(f.root);
    io.out("a line");
    io.err("a note");
    expect(lines()).toEqual({ out: ["a line"], err: ["a note"] });
  });
});
