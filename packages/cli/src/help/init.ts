import { STACKS } from "../stacks.js";
import { COMMON_FLAGS, type HelpText } from "./types.js";

/** The stacks as prose: "a, b, or c". The help reads STACKS, so a new stack needs no edit here. */
const STACK_PROSE = `${STACKS.slice(0, -1).join(", ")}, or ${STACKS.at(-1) ?? ""}`;

export const INIT_HELP: HelpText = {
  command: "init",
  page: "init",
  purpose:
    "Write a new app with a magic link sign-in on one stack. The files are those of the example app of the stack.",
  usage: [`authtempo init [dir] --stack <${STACKS.join("|")}>`],
  examples: [
    {
      line: "authtempo init my-app --stack workers-d1",
      says: "Write a Worker on D1 into the folder my-app.",
    },
    { line: "authtempo init . --stack node", says: "Write a Node server into this folder." },
    {
      line: "authtempo init my-mcp --stack mcp-server",
      says: "Write an MCP server on a Worker with D1 into the folder my-mcp.",
    },
  ],
  flags: [
    {
      flag: "--stack <stack>",
      says: `The stack: ${STACK_PROSE}. It has no default.`,
    },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "The command wrote every file, and printed the next steps." },
    {
      code: 2,
      says: "A usage error, or the folder holds a file of the app. The command then writes nothing.",
    },
  ],
};
