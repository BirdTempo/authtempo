import { COMMON_FLAGS, type HelpText } from "./types.js";

export const INIT_HELP: HelpText = {
  command: "init",
  page: "init",
  purpose:
    "Write a new app with a magic link sign-in on one stack. The files are those of the example app of the stack.",
  usage: ["authtempo init [dir] --stack <workers-d1|workers-postgres|node|bun>"],
  examples: [
    {
      line: "authtempo init my-app --stack workers-d1",
      says: "Write a Worker on D1 into the folder my-app.",
    },
    { line: "authtempo init . --stack node", says: "Write a Node server into this folder." },
  ],
  flags: [
    {
      flag: "--stack <stack>",
      says: "The stack: workers-d1, workers-postgres, node, or bun. It has no default.",
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
