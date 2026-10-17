/**
 * The editors that `authtempo mcp` writes into (plan 11e, owner decision 4).
 * Each row holds the project file, its format, the key of the server map,
 * and the docs page that gives the shape, with the date of the read. A row
 * changes only after a new read of its page. It imports no Node.js module,
 * so the docs site and the MCP server can read it.
 */

/**
 * Planned at publication by the owner; not live. One source: the installer,
 * /llms.txt, the docs, and the remote Worker's tests read it.
 */
export const REMOTE_MCP_URL = "https://mcp.authtempo.com/mcp";

export type EditorId = "claude-code" | "cursor" | "codex" | "opencode" | "vscode";

export interface EditorSpec {
  /** The flag of `authtempo mcp`, such as `--cursor`. */
  flag: string;
  /** The config file, relative to the project folder. */
  file: string;
  format: "json" | "toml";
  /** The key of the server map; for TOML, the table prefix. */
  key: string;
  /** The docs page that gives the shape. */
  source: string;
  /** The date of the last read of `source`. */
  read: string;
}

export const EDITORS: Readonly<Record<EditorId, EditorSpec>> = {
  // code.claude.com/docs/en/mcp, read 2026-10-17: ${VAR:-default} expands in
  // command, args, env, url, and headers. An unset variable with no default
  // stays as the literal text, so the entry gives the empty default.
  "claude-code": {
    flag: "--claude-code",
    file: ".mcp.json",
    format: "json",
    key: "mcpServers",
    source: "https://code.claude.com/docs/en/mcp",
    read: "2026-10-17",
  },
  // cursor.com/docs/context/mcp, read 2026-10-17: ${env:NAME} in env.
  cursor: {
    flag: "--cursor",
    file: ".cursor/mcp.json",
    format: "json",
    key: "mcpServers",
    source: "https://cursor.com/docs/context/mcp",
    read: "2026-10-17",
  },
  // The Codex MCP page, read 2026-10-17: env_vars names the variables to pass.
  // A project file applies only in a trusted project. On 2026-10-17 the old
  // address (developers.openai.com/codex/mcp) answers 308 to this page.
  codex: {
    flag: "--codex",
    file: ".codex/config.toml",
    format: "toml",
    key: "mcp_servers",
    source: "https://learn.chatgpt.com/docs/extend/mcp",
    read: "2026-10-17",
  },
  // opencode.ai/docs/mcp-servers and opencode.ai/docs/config, read 2026-10-17:
  // {env:NAME} in environment; command is one array.
  opencode: {
    flag: "--opencode",
    file: "opencode.json",
    format: "json",
    key: "mcp",
    source: "https://opencode.ai/docs/mcp-servers",
    read: "2026-10-17",
  },
  // code.visualstudio.com/docs/copilot/reference/mcp-configuration, read
  // 2026-10-17: no ${env:NAME} in mcp.json (plan 11e deviation 7), so no env
  // line; the server reads the variable from the environment of VS Code.
  vscode: {
    flag: "--vscode",
    file: ".vscode/mcp.json",
    format: "json",
    key: "servers",
    source: "https://code.visualstudio.com/docs/copilot/reference/mcp-configuration",
    read: "2026-10-17",
  },
};

/** The variable of VS Code for the folder of the workspace, as the file holds it. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code expands this text, not JavaScript.
const WORKSPACE_FOLDER = "${workspaceFolder}";

/** The variable of the connection string when `--url-env` is not given. */
export const DEFAULT_URL_ENV = "DATABASE_URL";

/** The command and the arguments that start the local server. */
export interface McpEntry {
  command: string;
  args: string[];
}

/**
 * The local server's start command (plan 11e deviation 6). Before
 * publication the workspace binary is the only one that runs; after it,
 * npx runs the release of this CLI's version.
 */
export function mcpEntry(o: {
  unpublished: boolean;
  version: string;
  bin: string;
  root: string;
}): McpEntry {
  return o.unpublished
    ? { command: "node", args: [o.bin, "--root", o.root] }
    : { command: "npx", args: ["-y", `@authtempo/mcp@${o.version}`, "--root", o.root] };
}

/** A TOML basic string. The JSON form of a string is a valid TOML basic string. */
const tomlString = (s: string) => JSON.stringify(s);

/**
 * The entry of one editor, as its docs give it: an object for a JSON file,
 * or the lines of the TOML table (without the table header) for Codex.
 * `urlEnv` is the name of `--url-env`, or null when the flag is not given.
 * No value of the environment goes into the entry: each editor gets a
 * reference that it expands at its own start.
 */
export function renderEntry(
  editor: EditorId,
  entry: McpEntry,
  o: { remote: boolean; urlEnv: string | null },
): unknown {
  const name = o.urlEnv ?? DEFAULT_URL_ENV;
  const args = o.urlEnv === null ? entry.args : [...entry.args, "--url-env", o.urlEnv];
  switch (editor) {
    case "claude-code":
      return o.remote
        ? { type: "http", url: REMOTE_MCP_URL }
        : { type: "stdio", command: entry.command, args, env: { [name]: `\${${name}:-}` } };
    case "cursor":
      return o.remote
        ? { url: REMOTE_MCP_URL }
        : { type: "stdio", command: entry.command, args, env: { [name]: `\${env:${name}}` } };
    case "codex":
      return o.remote
        ? `url = ${tomlString(REMOTE_MCP_URL)}\n`
        : `command = ${tomlString(entry.command)}\nargs = [${args.map(tomlString).join(", ")}]\nenv_vars = [${tomlString(name)}]\n`;
    case "opencode":
      return o.remote
        ? { type: "remote", url: REMOTE_MCP_URL, enabled: true }
        : {
            type: "local",
            command: [entry.command, ...args],
            environment: { [name]: `{env:${name}}` },
            enabled: true,
          };
    case "vscode": {
      if (o.remote) return { type: "http", url: REMOTE_MCP_URL };
      // VS Code expands ${workspaceFolder}, so the file holds no absolute path.
      const at = args.indexOf("--root");
      const vsArgs = args.map((a, i) => (at >= 0 && i === at + 1 ? WORKSPACE_FOLDER : a));
      return { type: "stdio", command: entry.command, args: vsArgs, cwd: WORKSPACE_FOLDER };
    }
  }
}
