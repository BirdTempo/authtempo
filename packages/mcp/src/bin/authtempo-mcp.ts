#!/usr/bin/env node
// The local MCP server on stdio. The stdio rule: stdout carries only MCP
// messages. Every log line, and every error, goes to stderr.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLI_VERSION } from "@authtempo/cli/program";
import { readIndexFile, readSkills } from "../index-reader.js";
import { serveStdio } from "../protocol.js";
import { createServer, URL_ENV_NAME } from "../server.js";

const say = (line: string) => process.stderr.write(`authtempo-mcp: ${line}\n`);

/** A usage error or a stop: a line on stderr and exit 2, with nothing on stdout. */
function stop(line: string): never {
  say(line);
  process.exit(2);
}

async function main(): Promise<void> {
  let values: { root?: string; "url-env"?: string; index?: string };
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        root: { type: "string" },
        "url-env": { type: "string" },
        index: { type: "string" },
      },
    }));
  } catch (e) {
    stop((e as Error).message);
  }
  const urlEnv = values["url-env"];
  if (urlEnv !== undefined && !URL_ENV_NAME.test(urlEnv))
    stop("--url-env takes the name of a variable, not a value");

  // The root is resolved once, at start: each later path check compares with this one value.
  let root: string;
  try {
    root = realpathSync(values.root ?? process.cwd());
  } catch {
    stop(`the root ${values.root ?? process.cwd()} does not exist`);
  }
  const indexFile = values.index ?? fileURLToPath(new URL("../agent/index.json", import.meta.url));
  let index: ReturnType<typeof readIndexFile>;
  try {
    index = readIndexFile(indexFile);
  } catch (e) {
    // A missing file names the command that writes it; a file that fails the parser names the issue.
    stop((e as Error).message);
  }
  const skills = readSkills(fileURLToPath(new URL("../../skills/", import.meta.url)));
  say(`root ${root}, ${index.pages.length} pages`);
  await serveStdio(
    createServer({
      surface: "local",
      index,
      skills,
      root,
      env: process.env,
      cli: CLI_VERSION,
      ...(urlEnv === undefined ? {} : { urlEnv }),
    }),
  );
}

main().catch((e: unknown) => {
  say(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
