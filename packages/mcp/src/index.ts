// The entry of @authtempo/mcp: the factory, the tool table, and the
// instructions. The binary is dist/bin/authtempo-mcp.js.
export { createServer, INSTRUCTIONS } from "./server.js";
export type {
  PromptSpec,
  ResourceSpec,
  ServerSpec,
  Skill,
  SkillSet,
  Surface,
  ToolImpl,
  ToolResult,
} from "./spec.js";
export { TOOLS, type ToolRow } from "./tools.js";
