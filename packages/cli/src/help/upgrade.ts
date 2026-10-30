import { COMMON_FLAGS, type HelpText } from "./types.js";

export const UPGRADE_HELP: HelpText = {
  command: "upgrade",
  page: "upgrade",
  purpose:
    "Move every authtempo package of an app to one version. The command reads the registry, writes the versions in package.json, and prints the Breaking lines, the deprecations, and the next steps. It runs no install.",
  usage: ["authtempo upgrade [dir] [--to <version>] [--registry <url>] [--dry-run] [--json]"],
  examples: [
    {
      line: "authtempo upgrade --dry-run",
      says: "Show the change for the app in this folder, and write nothing.",
    },
    {
      line: "authtempo upgrade",
      says: "Move each authtempo package of the app in this folder to the latest version.",
    },
    {
      line: "authtempo upgrade apps/api --to 0.2.1",
      says: "Move each authtempo package of the app in apps/api to version 0.2.1.",
    },
  ],
  flags: [
    {
      flag: "--to <version>",
      says: "The target version, such as 0.2.1. The default is the latest version of @authtempo/core. A target below the installed version stops the command.",
    },
    {
      flag: "--registry <url>",
      says: "The npm registry to read. The default is https://registry.npmjs.org/. http is for localhost, 127.0.0.1, or [::1] only.",
    },
    {
      flag: "-n, --dry-run",
      says: "Print the change and write nothing. The exit code is the code of a real run.",
    },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "The versions are written, or the app is already at the target." },
    {
      code: 1,
      says: "A crossed minor has a Breaking line. The versions are written. Read each Breaking line before the install.",
    },
    {
      code: 2,
      says: "A usage error, a stop, or no answer from the registry. The command wrote nothing.",
    },
  ],
};
