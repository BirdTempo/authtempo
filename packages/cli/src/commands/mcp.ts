import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import {
  EDITORS,
  type EditorId,
  type McpEntry,
  mcpEntry,
  REMOTE_MCP_URL,
  renderEntry,
} from "../editors.js";
import { Stop, UsageError } from "../errors.js";
import { MCP_HELP } from "../help/mcp.js";
import type { McpJson } from "../json.js";
import { parseJsonc } from "../jsonc.js";
import { type Ctx, printJson, sayer } from "../output.js";
import { ENV_NAME } from "../secrets.js";
import { UNPUBLISHED } from "../templates.js";
import { CLI_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  "claude-code": { type: "boolean" },
  cursor: { type: "boolean" },
  codex: { type: "boolean" },
  opencode: { type: "boolean" },
  vscode: { type: "boolean" },
  manual: { type: "boolean" },
  remote: { type: "boolean" },
  "url-env": { type: "string" },
  "dry-run": { type: "boolean", short: "n" },
} as const;

const TARGETS = ["claude-code", "cursor", "codex", "opencode", "vscode", "manual"] as const;
const IDS = Object.keys(EDITORS) as EditorId[];

/**
 * The binary of @authtempo/mcp in the workspace: from dist/commands/ (and
 * from src/commands/ in a test) three folders up is packages/.
 */
export const MCP_BIN_URL = new URL("../../../mcp/dist/bin/authtempo-mcp.js", import.meta.url);

/** The server name in every editor file. */
const NAME = "authtempo";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep equality of two parsed JSON values; the key order of an object does not count. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => same(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

/** An argument as a POSIX shell reads it: a word with no special character stays as it is. */
const shellWord = (s: string) =>
  /^[A-Za-z0-9_./:@=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The text of one entry as a person adds it by hand. */
function entryText(id: EditorId, entry: unknown): string {
  const spec = EDITORS[id];
  return spec.format === "toml"
    ? `[${spec.key}.${NAME}]\n${String(entry)}`
    : `"${NAME}": ${JSON.stringify(entry, null, 2)}`;
}

/** The commands of the two editors that have their own `mcp add`. */
function addCommands(entry: McpEntry, o: { remote: boolean; urlEnv: string | null }): string[] {
  // The two remote forms, read 2026-10-17: code.claude.com/docs/en/mcp gives
  // `claude mcp add --transport http <name> <url>`. The Codex page is
  // developers.openai.com/codex/mcp, which answers 308 to
  // learn.chatgpt.com/docs/extend/mcp. It gives `codex mcp add <name> --url
  // <url>` with the optional --oauth-client-id. The remote server has no
  // authentication, so the line drops that flag (plan 11e ruling 9).
  if (o.remote)
    return [
      `claude mcp add --transport http ${NAME} ${REMOTE_MCP_URL}`,
      `codex mcp add ${NAME} --url ${REMOTE_MCP_URL}`,
    ];
  const args = o.urlEnv === null ? entry.args : [...entry.args, "--url-env", o.urlEnv];
  const line = [entry.command, ...args].map(shellWord).join(" ");
  return [`claude mcp add ${NAME} -- ${line}`, `codex mcp add ${NAME} -- ${line}`];
}

/** Stops when a path that exists resolves outside the project folder: the command writes there only. */
function inside(ctx: Ctx, root: string, path: string): void {
  for (const p of [dirname(path), path])
    if (ctx.exists(p)) {
      const real = ctx.realpath(p);
      if (real !== root && !real.startsWith(`${root}${sep}`))
        throw new Stop(`${path} resolves outside the project folder ${root}`);
    }
}

/** What a merge gives: the new text, no change, or the reason to stop. */
type Merge = { text: string } | { unchanged: true } | { stop: string };

/**
 * The new text of a JSON file, or the reason to stop (plan 11e Task 2, the
 * merge rule). Every other key keeps its place and its value; authtempo goes
 * at the end of the server map.
 */
function mergeJson(ctx: Ctx, file: string, text: string, key: string, entry: unknown): Merge {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    try {
      parseJsonc(text);
    } catch {
      return { stop: `${file} does not parse as JSON: fix the file, or add the entry by hand` };
    }
    return {
      stop: `${file} holds comments, and a rewrite drops them: add the entry under "${key}" by hand`,
    };
  }
  if (!isObject(doc)) return { stop: `${file} holds no JSON object: add the entry by hand` };
  const map = doc[key];
  if (map === undefined) {
    doc[key] = { [NAME]: entry };
  } else if (!isObject(map)) {
    return { stop: `"${key}" in ${file} is not an object: add the entry by hand` };
  } else if (Object.hasOwn(map, NAME)) {
    if (same(map[NAME], entry)) return { unchanged: true };
    ctx.err(`${file} has: ${JSON.stringify(map[NAME])}`);
    ctx.err(`this command writes: ${JSON.stringify(entry)}`);
    return {
      stop: `${file} holds another ${NAME} entry: edit it by hand, or remove it and run again`,
    };
  } else {
    map[NAME] = entry;
  }
  return { text: `${JSON.stringify(doc, null, 2)}\n` };
}

/** A TOML line without its comment: a # outside a string starts the comment. */
function tomlCode(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** A TOML key path with its spaces and quotes removed: `[ mcp_servers."authtempo" ]` gives mcp_servers.authtempo. */
const tomlPath = (s: string) => s.replace(/["'\s]/g, "");
const TAKEN = `mcp_servers.${NAME}`;
const isTaken = (path: string) => path === TAKEN || path.startsWith(`${TAKEN}.`);
/** The authtempo key at the start of an inline table entry, bare or quoted, then = or a dot. */
const INLINE_KEY = new RegExp(`[{,]\\s*["']?${NAME}["']?\\s*[.=]`);

/**
 * True when the TOML text defines the authtempo server in any form. The
 * forms are a table header `[mcp_servers.authtempo]` (with spaces or quotes),
 * a key `authtempo` under `[mcp_servers]`, and a dotted or inline key at the
 * root. TOML refuses
 * a table that is defined two times, so an append would break the file.
 */
function codexTaken(text: string): boolean {
  let table = "";
  for (const raw of text.split("\n")) {
    const line = tomlCode(raw).trim();
    if (line === "") continue;
    const header = /^\[\[?(.*?)\]\]?$/.exec(line);
    if (header) {
      table = tomlPath(header[1] ?? "");
      if (isTaken(table)) return true;
      continue;
    }
    const pair = /^([^=]+)=(.*)$/.exec(line);
    if (!pair) continue;
    const key = tomlPath(pair[1] ?? "");
    const path = table === "" ? key : `${table}.${key}`;
    if (isTaken(path)) return true;
    // An inline table: mcp_servers = { authtempo = { ... } }, or a dotted
    // key in it, such as { "authtempo".command = "x" }.
    if (path === "mcp_servers" && INLINE_KEY.test(pair[2] ?? "")) return true;
  }
  return false;
}

/**
 * The new text of a Codex file. The exact table that this command appends,
 * with no key after it, is no change; any other authtempo server stops.
 */
function mergeToml(file: string, old: string, table: string): Merge {
  const at = `\n${old}`.indexOf(`\n${table}`);
  if (at >= 0) {
    const next = old
      .slice(at + table.length)
      .split("\n")
      .map((l) => tomlCode(l).trim())
      .find((l) => l !== "");
    if (next === undefined || next.startsWith("[")) return { unchanged: true };
  }
  if (codexTaken(old))
    return {
      stop: `${file} already defines the ${NAME} server: edit it by hand, or remove it and run again`,
    };
  return { text: `${old}\n${table}` };
}

/**
 * `authtempo mcp [dir] --<editor>` (plan 11e, owner decision 4). It adds
 * the authtempo MCP server to the project file of one editor. With --manual,
 * it prints every entry. It writes in the project folder only, and it reads
 * no secret. It writes no value of the environment: each entry names the
 * variable, and the editor expands it.
 */
export const mcpCommand: Command = {
  help: MCP_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`);
    const chosen = TARGETS.filter((t) => values[t] === true);
    const [target] = chosen;
    if (target === undefined)
      throw new UsageError(
        "name one target: --claude-code, --cursor, --codex, --opencode, --vscode, or --manual",
      );
    if (chosen.length > 1)
      throw new UsageError(`name one target, not ${chosen.map((t) => `--${t}`).join(" and ")}`);
    const remote = values.remote === true;
    const urlEnvFlag = values["url-env"];
    if (urlEnvFlag !== undefined && !ENV_NAME.test(urlEnvFlag))
      throw new UsageError("--url-env takes the name of a variable, not a value");
    if (remote && urlEnvFlag !== undefined)
      throw new UsageError(
        "--url-env has no use with --remote: the remote server reads no database",
      );
    const urlEnv = urlEnvFlag ?? null;
    const json = values.json === true;
    const dryRun = values["dry-run"] === true;
    const say = sayer(ctx, json);

    const dir = resolve(ctx.cwd, positionals[0] ?? ".");
    if (!ctx.exists(dir)) throw new Stop(`the folder ${dir} does not exist`);
    const root = ctx.realpath(dir);
    const hook = ctx.env.AUTHTEMPO_MCP_BIN;
    const bin = hook ? resolve(ctx.cwd, hook) : fileURLToPath(MCP_BIN_URL);
    // Only the workspace binary runs before publication; after it, npx fetches the release.
    if (!remote && UNPUBLISHED && !ctx.exists(bin))
      throw new Stop(
        "build @authtempo/mcp first: pnpm --filter @authtempo/mcp build, then pnpm turbo run index --filter=@authtempo/mcp",
      );
    const entry = mcpEntry({ unpublished: UNPUBLISHED, version: CLI_VERSION, bin, root });
    const opts = { remote, urlEnv };

    if (target === "manual") {
      const all = Object.fromEntries(IDS.map((id) => [id, renderEntry(id, entry, opts)]));
      for (const id of IDS) {
        const spec = EDITORS[id];
        say(`${spec.flag.slice(2)}: ${spec.file}, under "${spec.key}"`);
        for (const line of entryText(id, all[id]).split("\n")) if (line !== "") say(line);
        say("");
      }
      for (const line of addCommands(entry, opts)) say(line);
      if (json)
        printJson(ctx, {
          editor: "manual",
          file: null,
          action: "printed",
          entry: all,
          exit: 0,
          stopped: null,
        } satisfies McpJson);
      return 0;
    }

    const id: EditorId = target;
    const spec = EDITORS[id];
    const rendered = renderEntry(id, entry, opts);
    const file = join(root, spec.file);
    if (id === "codex") ctx.err("A Codex project file applies only in a trusted project.");
    // A merge stop returns 2 with the command's own document, as the import's
    // runParsed does. The document keeps the file and the entry to add by
    // hand (plan 11e ruling 11). A thrown Stop is for a stop before the merge.
    const stopped = (why: string): number => {
      for (const line of entryText(id, rendered).split("\n")) if (line !== "") say(line);
      ctx.err(`stopped: ${why}`);
      if (json)
        printJson(ctx, {
          editor: id,
          file,
          action: "stopped",
          entry: rendered,
          exit: 2,
          stopped: why,
        } satisfies McpJson);
      return 2;
    };
    // OpenCode also reads opencode.jsonc, and a rewrite drops its comments (plan 11e deviation 8).
    const jsonc = join(root, "opencode.jsonc");
    if (id === "opencode" && ctx.exists(jsonc))
      return stopped(
        `${jsonc} holds comments, and a rewrite drops them: add the entry under "mcp" by hand`,
      );
    inside(ctx, root, file);

    const exists = ctx.exists(file);
    const merge: Merge = !exists
      ? {
          text:
            spec.format === "toml"
              ? entryText(id, rendered)
              : `${JSON.stringify({ [spec.key]: { [NAME]: rendered } }, null, 2)}\n`,
        }
      : spec.format === "toml"
        ? mergeToml(file, ctx.readFile(file), entryText(id, rendered))
        : mergeJson(ctx, file, ctx.readFile(file), spec.key, rendered);
    if ("stop" in merge) return stopped(merge.stop);
    const text = "text" in merge ? merge.text : null;

    let action: McpJson["action"];
    if (text === null) {
      ctx.err(`${NAME} is already set in ${file}`);
      action = "unchanged";
    } else if (dryRun) {
      say(`would write ${file}:`);
      for (const line of text.replace(/\n$/, "").split("\n")) say(line);
      action = "printed";
    } else {
      // The one write over a file that exists goes through replaceFile (src/io.ts).
      if (exists) ctx.replaceFile(file, text);
      else ctx.writeNew(file, text);
      ctx.err(`wrote ${file}`);
      if (id === "claude-code")
        ctx.err("Claude Code asks for approval before it uses a project server from .mcp.json.");
      action = "written";
    }
    if (json)
      printJson(ctx, {
        editor: id,
        file,
        action,
        entry: rendered,
        exit: 0,
        stopped: null,
      } satisfies McpJson);
    return 0;
  },
};
