// The Node reader of the index and the skills, for the local binary. The
// remote Worker reads the same data from its assets (Task 16). So this file
// and bin/ are the only files of src/ that read Node modules.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentIndex, parseAgentIndex } from "./index-format.js";
import type { SkillSet } from "./spec.js";

/** The command that writes the index next to the binary. */
export const INDEX_COMMAND = "pnpm turbo run index --filter=@authtempo/mcp";

/** The index of a file, through the format's parser. It throws with the command to run when the file is missing. */
export function readIndexFile(file: string): AgentIndex {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`the docs index ${file} is missing: run ${INDEX_COMMAND}`);
  }
  return parseAgentIndex(text);
}

/**
 * The skills of a folder: one SKILL.md in each subfolder, in name order.
 * A folder that does not exist gives an empty set.
 */
export function readSkills(dir: string): SkillSet {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, markdown: readFileSync(join(dir, name, "SKILL.md"), "utf8") }));
}
