// The Node entry of the CLI for the MCP server (plan 11e). It imports Node
// modules; the public entry `.` does not. The server calls `main(argv, io)`
// in process and reads the tables below, so each has one source.

export { PROVIDERS } from "./commands/import-core.js";
export type { Io } from "./io.js";
export { COMMANDS, main } from "./main.js";
export { type Ctx, guarded } from "./output.js";
export { NAME_ONLY_FLAGS, SECRETISH_FLAG } from "./secrets.js";
export { STACK_INFO, STACKS, UNPUBLISHED } from "./templates.js";
export { CLI_VERSION, SCHEMA_VERSION } from "./version.js";
