import { REMOTE_MCP_URL } from "../editors.js";
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
      says: "Write .mcp.json. Claude Code asks for approval before it uses a project server from .mcp.json (code.claude.com/docs/en/mcp, read 2026-10-17).",
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
      // One source for the URL: editors.ts. The page holds the literal.
      says: `Use the remote server at ${REMOTE_MCP_URL}. It serves the docs tools only and is not live before publication.`,
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
      says: "A usage error, or a stop that writes nothing. The command stops on another authtempo entry, a file that does not parse, or a file with comments. It also stops on a path outside the project folder, a missing folder, or a server that is not built. The command also stops when the file or its server map is not a JSON object.",
    },
  ],
  notes: ["AUTHTEMPO_MCP_BIN names another server file. It is for the tests of this repo."],
};
