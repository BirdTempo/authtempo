import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_BIN_URL } from "../src/commands/mcp.js";
import { type EditorId, mcpEntry, renderEntry } from "../src/editors.js";
import { MCP_JSON_KEYS } from "../src/json.js";
import { UNPUBLISHED } from "../src/templates.js";
import { assertFreshBuild, linesOf, PKG, REPO, runBin } from "./support/bin.js";

const FIXTURES = join(PKG, "test/fixtures/mcp");
const VERSION = (JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version: string })
  .version;
/** The URL as the plan states it, typed here: the test does not read the constant it pins. */
const REMOTE = "https://mcp.authtempo.com/mcp";

/** The project file of each editor, and the key of its server map, as the plan's table states them. */
const FILES: Record<EditorId, { file: string; key: string }> = {
  "claude-code": { file: ".mcp.json", key: "mcpServers" },
  cursor: { file: ".cursor/mcp.json", key: "mcpServers" },
  codex: { file: ".codex/config.toml", key: "mcp_servers" },
  opencode: { file: "opencode.json", key: "mcp" },
  vscode: { file: ".vscode/mcp.json", key: "servers" },
};
/** The VS Code variable, as the plan's table gives it. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code expands this text, not JavaScript.
const VS_FOLDER = "${workspaceFolder}";
const IDS = Object.keys(FILES) as EditorId[];
const JSON_IDS = IDS.filter((id) => id !== "codex");

const made: string[] = [];
/** A new empty folder, with each link of its path resolved, as the command resolves the root. */
const fresh = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-mcp-")));
  made.push(dir);
  return dir;
};
/** A copy of one fixture folder in a new folder. */
const project = (fixture: string) => {
  const dir = fresh();
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
};

/**
 * The server binary comes from plan 11e Task 5. Until then the test hook
 * AUTHTEMPO_MCP_BIN names a stand-in file in its own folder, so no project
 * folder holds it.
 */
let BIN: string;
beforeAll(() => {
  assertFreshBuild();
  BIN = join(fresh(), "authtempo-mcp.js");
  writeFileSync(BIN, "// a stand-in for the server binary of plan 11e Task 5\n");
});
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const mcp = (dir: string, args: string[], env: Record<string, string> = {}) =>
  runBin(["mcp", ...args], { cwd: dir, env: { AUTHTEMPO_MCP_BIN: BIN, ...env } });

/** Every file under a folder, by its relative path, with its bytes. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) {
      const path = join(e.parentPath, e.name);
      out.set(path.slice(dir.length + 1), readFileSync(path, "latin1"));
    }
  return out;
}

const read = (dir: string, id: EditorId) => readFileSync(join(dir, FILES[id].file), "utf8");
const parsed = (dir: string, id: EditorId) =>
  JSON.parse(read(dir, id)) as Record<string, Record<string, unknown>>;

/** The stdio entry that the plan's table gives, for the binary BIN and the folder `root`. */
function expected(id: EditorId, root: string, name = "DATABASE_URL"): unknown {
  // Before publication the workspace binary runs (deviation 6); the package is private now.
  const [command, ...head] = UNPUBLISHED
    ? ["node", BIN]
    : ["npx", "-y", `@authtempo/mcp@${VERSION}`];
  const args = [...head, "--root", root];
  switch (id) {
    case "claude-code":
      return { type: "stdio", command, args, env: { [name]: `\${${name}:-}` } };
    case "cursor":
      return { type: "stdio", command, args, env: { [name]: `\${env:${name}}` } };
    case "codex":
      return `[mcp_servers.authtempo]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(", ")}]\nenv_vars = [${JSON.stringify(name)}]\n`;
    case "opencode":
      return {
        type: "local",
        command: [command, ...args],
        environment: { [name]: `{env:${name}}` },
        enabled: true,
      };
    case "vscode":
      return { type: "stdio", command, args: [...head, "--root", VS_FOLDER], cwd: VS_FOLDER };
  }
}

/** A Codex file that defines the authtempo server in another form: exit 2, and no byte changes. */
function codexStops(text: string): void {
  const dir = fresh();
  mkdirSync(join(dir, ".codex"));
  writeFileSync(join(dir, FILES.codex.file), text);
  const before = snapshot(dir);
  const r = mcp(dir, ["--codex"]);
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toContain("already defines the authtempo server");
  expect(snapshot(dir)).toEqual(before);
}

describe("authtempo mcp (plan 11e Task 2)", () => {
  it("writes the stdio entry into an empty project, for each editor", () => {
    for (const id of IDS) {
      const dir = fresh();
      const r = mcp(dir, [`--${id}`]);
      expect(r.status, `${id}: ${r.stderr}`).toBe(0);
      expect(existsSync(join(dir, FILES[id].file)), id).toBe(true);
      expect(r.stderr, id).toContain(`wrote ${join(dir, FILES[id].file)}`);
      if (id === "codex") expect(read(dir, id)).toBe(expected(id, dir));
      else
        expect(parsed(dir, id), id).toEqual({ [FILES[id].key]: { authtempo: expected(id, dir) } });
    }
  });

  it("keeps every other key and its order", () => {
    for (const id of JSON_IDS) {
      const dir = project(`${id}-others`);
      const before = parsed(dir, id);
      const key = FILES[id].key;
      const r = mcp(dir, [`--${id}`]);
      expect(r.status, `${id}: ${r.stderr}`).toBe(0);
      const after = parsed(dir, id);
      expect(Object.keys(after), id).toEqual(Object.keys(before));
      expect(Object.keys(after[key] ?? {}), id).toEqual([
        ...Object.keys(before[key] ?? {}),
        "authtempo",
      ]);
      expect(after[key]?.alpha, id).toEqual(before[key]?.alpha);
      expect(after[key]?.zeta, id).toEqual(before[key]?.zeta);
      expect(after[key]?.authtempo, id).toEqual(expected(id, dir));
    }
  });

  it("leaves the same entry as it is", () => {
    for (const id of JSON_IDS) {
      const dir = project(`${id}-others`);
      // The entry that the command writes, from renderEntry, so the fixture holds no second copy.
      const doc = parsed(dir, id);
      const entry = mcpEntry({ unpublished: UNPUBLISHED, version: VERSION, bin: BIN, root: dir });
      const map = doc[FILES[id].key] ?? {};
      map.authtempo = renderEntry(id, entry, { remote: false, urlEnv: null });
      writeFileSync(join(dir, FILES[id].file), `${JSON.stringify(doc, null, 2)}\n`);
      const before = snapshot(dir);
      const r = mcp(dir, [`--${id}`, "--json"]);
      expect(r.status, `${id}: ${r.stderr}`).toBe(0);
      expect(r.stderr, id).toContain("already set");
      expect((JSON.parse(r.stdout) as { action: string }).action, id).toBe("unchanged");
      expect(snapshot(dir), id).toEqual(before);
    }
  });

  it("stops on another authtempo entry and writes nothing", () => {
    for (const id of JSON_IDS) {
      const dir = project(`${id}-other-authtempo`);
      const old = parsed(dir, id)[FILES[id].key]?.authtempo;
      const before = snapshot(dir);
      const r = mcp(dir, [`--${id}`]);
      expect(r.status, id).toBe(2);
      expect(r.stderr, id).toContain(JSON.stringify(old));
      expect(r.stderr, id).toContain(JSON.stringify(expected(id, dir)));
      expect(
        linesOf(r.stderr).some((l) => l.startsWith("stopped: ")),
        id,
      ).toBe(true);
      expect(snapshot(dir), id).toEqual(before);
    }
  });

  it("stops on a file that does not parse, and on a file with a comment", () => {
    for (const id of JSON_IDS) {
      // A file cut short, as an editor can leave it: the repo's lint refuses a broken JSON fixture.
      const broken = project(`${id}-others`);
      const text = read(broken, id);
      writeFileSync(join(broken, FILES[id].file), text.slice(0, text.lastIndexOf("}")));
      const b0 = snapshot(broken);
      const b = mcp(broken, [`--${id}`]);
      expect(b.status, id).toBe(2);
      expect(b.stderr, id).toContain("does not parse");
      expect(snapshot(broken), id).toEqual(b0);

      // A valid JSONC file with one comment. The repo's lint refuses a comment in some of these files.
      const comment = project(`${id}-others`);
      const lines = read(comment, id).split("\n");
      lines.splice(1, 0, "  // The servers of this project.");
      writeFileSync(join(comment, FILES[id].file), lines.join("\n"));
      const c0 = snapshot(comment);
      const c = mcp(comment, [`--${id}`]);
      expect(c.status, id).toBe(2);
      expect(c.stderr, id).toContain("holds comments");
      expect(c.stdout, id).toContain(
        `"authtempo": ${JSON.stringify(expected(id, comment), null, 2)}`,
      );
      expect(snapshot(comment), id).toEqual(c0);
    }
  });

  it("appends a table to the Codex file and stops on a taken one", () => {
    const dir = project("codex-others");
    const old = read(dir, "codex");
    const r = mcp(dir, ["--codex"]);
    expect(r.status, r.stderr).toBe(0);
    const now = read(dir, "codex");
    expect(now.startsWith(old)).toBe(true);
    expect(now.slice(old.length)).toBe(`\n${expected("codex", dir)}`);
    expect(r.stderr).toContain("applies only in a trusted project");

    const taken = project("codex-taken");
    const before = snapshot(taken);
    const t = mcp(taken, ["--codex"]);
    expect(t.status).toBe(2);
    expect(t.stderr).toContain("applies only in a trusted project");
    expect(snapshot(taken)).toEqual(before);
  });

  it("refuses an opencode.jsonc", () => {
    const dir = project("opencode-jsonc");
    const before = snapshot(dir);
    const r = mcp(dir, ["--opencode"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(
      `"authtempo": ${JSON.stringify(expected("opencode", dir), null, 2)}`,
    );
    expect(existsSync(join(dir, "opencode.json"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  it("writes nothing with --dry-run", () => {
    for (const id of IDS) {
      const dir = fresh();
      const d = mcp(dir, [`--${id}`, "--dry-run"]);
      expect(d.status, `${id}: ${d.stderr}`).toBe(0);
      expect(snapshot(dir).size, id).toBe(0);
      // The real run in the same folder writes the text that the dry run printed.
      expect(mcp(dir, [`--${id}`]).status, id).toBe(0);
      expect(d.stdout, id).toContain(join(dir, FILES[id].file));
      expect(d.stdout, id).toContain(read(dir, id).replace(/\n$/, ""));
    }
  });

  it("writes nothing with --manual", () => {
    const dir = fresh();
    const r = mcp(dir, ["--manual"]);
    expect(r.status, r.stderr).toBe(0);
    for (const id of JSON_IDS)
      expect(r.stdout, id).toContain(`"authtempo": ${JSON.stringify(expected(id, dir), null, 2)}`);
    expect(r.stdout).toContain(String(expected("codex", dir)));
    const line = ["node", BIN, "--root", dir].join(" ");
    expect(linesOf(r.stdout)).toContain(`claude mcp add authtempo -- ${line}`);
    expect(linesOf(r.stdout)).toContain(`codex mcp add authtempo -- ${line}`);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes the remote entry with --remote", () => {
    for (const id of IDS) {
      const dir = fresh();
      // The remote entry needs no local binary.
      const r = mcp(dir, [`--${id}`, "--remote"], { AUTHTEMPO_MCP_BIN: join(dir, "missing.js") });
      expect(r.status, `${id}: ${r.stderr}`).toBe(0);
      if (id === "codex") {
        expect(read(dir, id)).toBe(`[mcp_servers.authtempo]\nurl = "${REMOTE}"\n`);
        continue;
      }
      const entry = parsed(dir, id)[FILES[id].key]?.authtempo as Record<string, unknown>;
      expect(entry.url, id).toBe(REMOTE);
      expect(entry, id).not.toHaveProperty("command");
    }
    expect(runBin(["mcp", "--help"]).stdout).toContain("It serves the docs tools only");
  });

  it("writes no value of the environment", () => {
    const env = {
      DATABASE_URL: "postgres://u:secret-value-7@h/db",
      AUTHTEMPO_PROBE: "probe-value-9",
    };
    const runs = [...IDS.map((id) => [`--${id}`]), ["--manual"], ["--cursor", "--json", "-n"]];
    for (const args of runs) {
      const dir = fresh();
      const r = mcp(dir, args, env);
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      const bytes = [...snapshot(dir).values(), r.stdout, r.stderr].join("\n");
      expect(bytes, args.join(" ")).not.toContain("secret-value-7");
      expect(bytes, args.join(" ")).not.toContain("probe-value-9");
    }
  });

  it("names the variable of --url-env", () => {
    for (const id of IDS) {
      const dir = fresh();
      const r = mcp(dir, [`--${id}`, "--url-env", "APP_DB"]);
      expect(r.status, `${id}: ${r.stderr}`).toBe(0);
      const text = read(dir, id);
      expect(text, id).toContain("APP_DB");
      expect(text, id).not.toContain("DATABASE_URL");
      expect(text.replace(/\s+/g, ""), id).toContain('"--url-env","APP_DB"');
    }
    const bad = mcp(fresh(), ["--cursor", "--url-env", "postgres://x"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("takes the name of a variable, not a value");
  });

  it("takes exactly one target", () => {
    const dir = fresh();
    const none = mcp(dir, []);
    expect(none.status).toBe(2);
    expect(linesOf(none.stderr)[0]).toBe(
      "name one target: --claude-code, --cursor, --codex, --opencode, --vscode, or --manual",
    );
    const two = mcp(dir, ["--cursor", "--codex"]);
    expect(two.status).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops when the server is not built", () => {
    // The default binary is the workspace build of @authtempo/mcp.
    expect(fileURLToPath(MCP_BIN_URL)).toBe(join(REPO, "packages/mcp/dist/bin/authtempo-mcp.js"));
    const dir = fresh();
    const r = mcp(dir, ["--cursor"], { AUTHTEMPO_MCP_BIN: join(dir, "missing.js") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("build @authtempo/mcp first: pnpm --filter @authtempo/mcp build");
    expect(readdirSync(dir)).toEqual([]);
    // The help names the hook in its Notes block, not as a setting (plan 11e ruling 14).
    const help = runBin(["mcp", "--help"]).stdout;
    expect(help).toContain(
      "Notes:\n  AUTHTEMPO_MCP_BIN names another server file. It is for the tests of this repo.\n",
    );
  });

  it("prints one JSON document with --json", () => {
    const dir = fresh();
    const r = mcp(dir, ["--cursor", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(MCP_JSON_KEYS).sort());
    expect(doc).toEqual({
      editor: "cursor",
      file: join(dir, ".cursor/mcp.json"),
      action: "written",
      entry: expected("cursor", dir),
    });
  });

  it("stops on a key authtempo under [mcp_servers]", () => {
    codexStops('[mcp_servers]\nauthtempo = { command = "x" }\n');
  });

  it("stops on a quoted table header", () => {
    codexStops('[mcp_servers."authtempo"]\ncommand = "x"\n');
  });

  it("stops on a table header with spaces", () => {
    codexStops('[ mcp_servers.authtempo ]\ncommand = "x"\n');
  });

  it("answers unchanged on a second --codex run", () => {
    for (const dir of [fresh(), project("codex-others")]) {
      expect(mcp(dir, ["--codex"]).status).toBe(0);
      const before = snapshot(dir);
      const r = mcp(dir, ["--codex", "--json"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("already set");
      expect((JSON.parse(r.stdout) as { action: string }).action).toBe("unchanged");
      expect(snapshot(dir)).toEqual(before);
    }
  });

  it("keeps the mode of a file that its owner made narrower", () => {
    const dir = project("claude-code-others");
    const path = join(dir, ".mcp.json");
    chmodSync(path, 0o600);
    const r = mcp(dir, ["--claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(parsed(dir, "claude-code").mcpServers?.authtempo).toEqual(expected("claude-code", dir));
    // A file with a wider mode becomes 0644.
    const wide = project("cursor-others");
    const widePath = join(wide, ".cursor/mcp.json");
    chmodSync(widePath, 0o666);
    expect(mcp(wide, ["--cursor"]).status).toBe(0);
    expect(statSync(widePath).mode & 0o777).toBe(0o644);
  });

  it("stops on a folder that resolves outside the project", () => {
    const dir = fresh();
    const outside = fresh();
    symlinkSync(outside, join(dir, ".cursor"));
    const r = mcp(dir, ["--cursor"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("resolves outside the project folder");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("writes no value of the variable that --url-env names", () => {
    const env = { APP_DB: "postgres://u:app-secret-5@h/db" };
    const runs = [...IDS.map((id) => [`--${id}`]), ["--manual"], ["--cursor", "--json", "-n"]];
    for (const args of runs) {
      const dir = fresh();
      const r = mcp(dir, [...args, "--url-env", "APP_DB"], env);
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      const bytes = [...snapshot(dir).values(), r.stdout, r.stderr].join("\n");
      expect(bytes, args.join(" ")).toContain("APP_DB");
      expect(bytes, args.join(" ")).not.toContain("app-secret-5");
    }
  });

  it("refuses --url-env with --remote", () => {
    const dir = fresh();
    const r = mcp(dir, ["--cursor", "--remote", "--url-env", "APP_DB"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)[0]).toBe(
      "--url-env has no use with --remote: the remote server reads no database",
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes the whole remote entry of each editor", () => {
    const want: Record<string, unknown> = {
      "claude-code": { type: "http", url: REMOTE },
      cursor: { url: REMOTE },
      opencode: { type: "remote", url: REMOTE, enabled: true },
      vscode: { type: "http", url: REMOTE },
    };
    for (const id of JSON_IDS) {
      const dir = fresh();
      expect(mcp(dir, [`--${id}`, "--remote"]).status, id).toBe(0);
      expect(parsed(dir, id), id).toEqual({ [FILES[id].key]: { authtempo: want[id] } });
    }
  });

  it("prints the two remote mcp add lines with --manual --remote", () => {
    const r = mcp(fresh(), ["--manual", "--remote"]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toContain(`claude mcp add --transport http authtempo ${REMOTE}`);
    expect(linesOf(r.stdout)).toContain(`codex mcp add authtempo --url ${REMOTE}`);
  });

  it("prints one document and one stopped line on a stop with --json", () => {
    for (const id of JSON_IDS) {
      const dir = project(`${id}-other-authtempo`);
      const r = mcp(dir, [`--${id}`, "--json"]);
      expect(r.status, id).toBe(2);
      expect(linesOf(r.stdout), id).toHaveLength(1);
      expect(JSON.parse(r.stdout), id).toEqual({
        editor: id,
        file: join(dir, FILES[id].file),
        action: "stopped",
        entry: expected(id, dir),
      });
      expect(
        linesOf(r.stderr).filter((l) => l.startsWith("stopped: ")),
        id,
      ).toHaveLength(1);
    }
  });

  it("gives the published entry after a release", () => {
    const bin = "/repo/packages/mcp/dist/bin/authtempo-mcp.js";
    const root = "/work/app";
    expect(mcpEntry({ unpublished: false, version: "1.2.3", bin, root })).toEqual({
      command: "npx",
      args: ["-y", "@authtempo/mcp@1.2.3", "--root", root],
    });
    expect(mcpEntry({ unpublished: true, version: "1.2.3", bin, root })).toEqual({
      command: "node",
      args: [bin, "--root", root],
    });
  });
});
