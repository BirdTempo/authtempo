#!/usr/bin/env node
// The local MCP server on stdio. The stdio rule: stdout carries only MCP
// messages. Every log line, and every error, goes to stderr.
import { realpathSync, statSync } from "node:fs";
import { Transform } from "node:stream";
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

/** The answer to a line that is not JSON: JSON-RPC 2.0 error -32700, with id null. */
const PARSE_ERROR_LINE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: null,
  error: { code: -32700, message: "Parse error" },
})}\n`;

/**
 * A filter in front of the SDK's stdin. The SDK skips a line that is not
 * JSON with no answer and no log (ReadBuffer of @modelcontextprotocol/server
 * 2.3.1, read 2026-10-17). This filter answers such a line with -32700 and
 * writes one line to stderr. The stderr line holds no text of the input,
 * which can hold a secret. Each other line goes to the SDK as it is.
 */
function parseGuard(answer: (line: string) => void): Transform {
  const decoder = new TextDecoder();
  let rest = "";
  const pass = (line: string, push: (text: string) => void) => {
    if (line.trim() === "") return;
    try {
      JSON.parse(line);
    } catch {
      answer(PARSE_ERROR_LINE);
      say("a stdin line is not JSON: answered -32700");
      return;
    }
    push(`${line}\n`);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) pass(line, (text) => this.push(text));
      done();
    },
    flush(done) {
      rest += decoder.decode();
      pass(rest, (text) => this.push(text));
      done();
    },
  });
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
  // Task 7 resolves each tool path inside this value, so it must be a folder.
  if (!statSync(root).isDirectory()) stop(`the root ${root} is not a folder`);
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
    {
      streams: {
        input: process.stdin.pipe(parseGuard((line) => process.stdout.write(line))),
        output: process.stdout,
      },
    },
  );
}

main().catch((e: unknown) => {
  say(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
