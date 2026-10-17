import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STACKS } from "@authtempo/cli/program";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { localTools } from "../src/local-tools.js";
import { createServer } from "../src/server.js";
import { SCAFFOLD_STACKS, TOOLS } from "../src/tools.js";
import { REPO } from "./support/bin.js";
import { connect } from "./support/client.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

// The scaffold tool (plan 11e Task 7): authtempo init through the CLI's main
// in process, with the confined Io and the root rule.

const CLI_BIN = join(REPO, "packages/cli/dist/bin/authtempo.js");
/** The keys of the init document, written out here: the CLI's INIT_JSON_KEYS with exit and stopped. */
const INIT_KEYS = ["dir", "exit", "files", "next", "stack", "stopped"];

type Session = Awaited<ReturnType<typeof connect>>;
let fx: FixtureRoot;
let session: Session;
const made: string[] = [];

beforeAll(() => {
  assertFreshIndex();
});
afterEach(async () => {
  await session?.close();
  fx?.remove();
});
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<Session> {
  fx = fixtureRoot();
  session = await connect(
    createServer({
      surface: "local",
      index: siteIndex(),
      skills: [],
      root: fx.root,
      env: { PATH: process.env.PATH ?? "" },
      local: localTools,
    }),
  );
  return session;
}

/** Each file under a folder, by its relative path, with its text. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) {
      const path = join(e.parentPath, e.name);
      files[path.slice(dir.length + 1)] = readFileSync(path, "utf8");
    }
  return files;
}

describe("scaffold", () => {
  it("writes the node stack into a new folder", async () => {
    const s = await start();
    const writes = vi.spyOn(process.stdout, "write");
    const r = await s.call("scaffold", { dir: "apps/web", stack: "node" });
    // Nothing of the CLI's run reaches the process's stdout, which carries MCP messages only.
    const lines = writes.mock.calls.map((c) => String(c[0]));
    writes.mockRestore();
    expect(lines.filter((l) => l.includes("wrote ") || l.includes(fx.root))).toEqual([]);
    expect(r.isError, r.texts.join("\n")).toBe(false);
    const doc = r.structured ?? {};
    expect(Object.keys(doc).sort()).toEqual(INIT_KEYS);
    expect(doc.exit).toBe(0);
    expect(doc.stopped).toBeNull();
    expect(doc.dir).toBe(join(fx.root, "apps/web"));

    // The same command in a shell, into another temp folder.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-mcp-shell-")));
    made.push(other);
    const shell = spawnSync(
      process.execPath,
      [CLI_BIN, "init", join(other, "web"), "--stack", "node", "--json"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    expect(shell.status, shell.stderr).toBe(0);
    const shellDoc = JSON.parse(shell.stdout) as Record<string, unknown>;
    expect(Object.keys(shellDoc).sort()).toEqual(INIT_KEYS);
    expect(doc.files).toEqual(shellDoc.files);
    const written = snapshot(join(fx.root, "apps/web"));
    expect(Object.keys(written).sort()).toEqual([...(doc.files as string[])].sort());
    expect(written).toEqual(snapshot(join(other, "web")));
    expect(fx.around()).toEqual({ base: ["outside", "root"], outside: [] });
  });

  it("refuses a folder that holds a file of the stack", async () => {
    const s = await start();
    mkdirSync(join(fx.root, "app"));
    writeFileSync(join(fx.root, "app/package.json"), "{}\n");
    const before = snapshot(fx.root);
    const r = await s.call("scaffold", { dir: "app", stack: "node" });
    expect(r.isError).toBe(true);
    const text = r.texts.join("\n");
    expect(text).toContain(`exists: ${join(fx.root, "app/package.json")}`);
    expect(text).toContain(
      `stopped: init writes no file over a file; the folder ${join(fx.root, "app")} holds 1 of its files`,
    );
    expect(r.structured).toMatchObject({ exit: 2, files: [] });
    expect(snapshot(fx.root)).toEqual(before);
  });

  it("answers an input error for a stack that does not exist", async () => {
    const s = await start();
    const r = await s.call("scaffold", { dir: "app", stack: "nowhere" });
    expect(r.isError).toBe(true);
    expect(r.texts.join("\n")).toContain("stack");
    expect(readdirSync(fx.root)).toEqual(["link"]);
  });

  it("answers an input error for a dir that starts with a dash", async () => {
    const s = await start();
    const r = await s.call("scaffold", { dir: "--help", stack: "node" });
    expect(r.isError).toBe(true);
    expect(readdirSync(fx.root)).toEqual(["link"]);
  });

  it("offers the stacks of the CLI, and only on the local surface", async () => {
    expect([...SCAFFOLD_STACKS]).toEqual([...STACKS]);
    const row = TOOLS.find((t) => t.name === "scaffold");
    expect(row?.surfaces).toEqual(["local"]);
    expect([...(row?.outputKeys ?? [])].sort()).toEqual(INIT_KEYS);
    const remote = createServer({ surface: "remote", index: siteIndex(), skills: [] });
    expect(remote.tools.map((t) => t.row.name)).not.toContain("scaffold");
    const s = await start();
    const listed = await s.client.listTools();
    const tool = listed.tools.find((t) => t.name === "scaffold");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool?.description?.split(". ")[0]).toBe(
      "Writes the files of a new app into dir, inside the server root, and overwrites no file",
    );
  });
});
