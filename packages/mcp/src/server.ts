// The factory of the server: one protocol-free ServerSpec per surface, from
// one tool table, one docs index, and one skill set. It imports no CLI
// module and no Node module, because the remote Worker calls it too.
import { VERSION as CORE_VERSION, SCHEMA_VERSION } from "@authtempo/core";
import { docsTools } from "./docs-tools.js";
import type { AgentIndex } from "./index-format.js";
import { docsResources } from "./resources.js";
import type { ServerSpec, SkillSet, Surface } from "./spec.js";

/**
 * The version of this package. A Worker cannot read package.json, so the
 * value is here; protocol-raw.test.ts holds it to package.json.
 */
export const MCP_VERSION = "0.0.0";

/** The newest protocol revision that the SDK serves (2026-07-28, @modelcontextprotocol/server 2.3.1). */
export const PROTOCOL_REVISION = "2026-07-28";

/** The name of an environment variable: the CLI's rule (packages/cli/src/secrets.ts, ENV_NAME). */
export const URL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FIRST =
  "Use these tools to integrate authtempo into this project. First read the installed version of @authtempo/core from the lockfile, and call `version` to compare it with the docs index. Then call `docs.search` at most three times for one question, and call `docs.read` on the best path.";

/**
 * The instructions of each surface. The remote text is the first three
 * sentences of the local text. The plan's local text also names
 * migrate.plan, migrate.run, and schema.migrate. Tasks 8 and 9 add that
 * sentence with the rows. instructions.test.ts holds each name to a row.
 */
export const INSTRUCTIONS: Record<Surface, string> = {
  local: `${FIRST} A tool that writes says so in the first sentence of its description.`,
  remote: FIRST,
};

export function createServer(opts: {
  surface: Surface;
  index: AgentIndex;
  skills: SkillSet;
  root?: string;
  env?: Readonly<Record<string, string | undefined>>;
  urlEnv?: string;
  /** The CLI version, which only the local binary can read; absent, the version tool answers null. */
  cli?: string;
}): ServerSpec {
  if (opts.urlEnv !== undefined && !URL_ENV_NAME.test(opts.urlEnv))
    throw new Error("--url-env takes the name of a variable, not a value");
  const tools = docsTools(opts.index, {
    core: CORE_VERSION,
    cli: opts.surface === "local" ? (opts.cli ?? null) : null,
    mcp: MCP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_REVISION,
  }).filter((t) => t.row.surfaces.includes(opts.surface));
  return {
    name: "authtempo",
    version: MCP_VERSION,
    instructions: INSTRUCTIONS[opts.surface],
    tools,
    // Both surfaces serve the docs resources (spec 21 item 2).
    resources: docsResources(opts.index),
    prompts: [],
  };
}
