import { COMMON_FLAGS, type HelpText } from "./types.js";

export const MCP_HELP: HelpText = {
  command: "mcp",
  page: "mcp",
  purpose: "Add the authtempo MCP server to the config of an editor in this project.",
  usage: [
    "authtempo mcp [dir] --claude-code|--cursor|--codex|--opencode|--vscode|--manual [--remote] [--url-env <NAME>] [-n, --dry-run] [--json]",
  ],
  examples: [
    {
      line: "authtempo mcp --claude-code",
      says: "Add the local server to .mcp.json in this folder.",
    },
    {
      line: "authtempo mcp ./app --cursor --url-env APP_DATABASE_URL",
      says: "Add the local server to Cursor. The server reads the connection string from APP_DATABASE_URL.",
    },
    {
      line: "authtempo mcp --manual --remote",
      says: "Print the entry of the remote docs server for each editor, and write no file.",
    },
  ],
  flags: [
    {
      flag: "--claude-code",
      says: "Write .mcp.json. Claude Code asks for approval before it uses a project server from .mcp.json (code.claude.com/docs/en/mcp, read 2026-10-14).",
    },
    { flag: "--cursor", says: "Write .cursor/mcp.json." },
    {
      flag: "--codex",
      says: "Write .codex/config.toml. A Codex project file applies only in a trusted project.",
    },
    {
      flag: "--opencode",
      says: "Write opencode.json. When the project has opencode.jsonc, the command prints the entry and stops.",
    },
    {
      flag: "--vscode",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the help names the VS Code variable.
      says: "Write .vscode/mcp.json. The entry uses ${workspaceFolder} and has no env line.",
    },
    {
      flag: "--manual",
      says: "Write no file. Print the entry of each editor and the claude mcp add and codex mcp add commands.",
    },
    {
      flag: "--remote",
      says: "Use the remote server at https://mcp.authtempo.com/mcp. It serves the docs tools only and is not live before publication.",
    },
    {
      flag: "--url-env <NAME>",
      says: "The variable that holds the connection string. The default is DATABASE_URL. The file holds the name, never the value.",
    },
    { flag: "-n, --dry-run", says: "Print the file and its new text, and write nothing." },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "The command wrote the entry, found the same entry, or printed it." },
    {
      code: 2,
      says: "A usage error, a file that does not parse, another authtempo entry, or a server that is not built. The test hook AUTHTEMPO_MCP_BIN names another server file.",
    },
  ],
};
