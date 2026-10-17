// The protocol-free description of a server. No file but protocol.ts imports
// the SDK, so a change of the SDK changes protocol.ts only.
import type { ToolRow } from "./tools.js";

export type Surface = "local" | "remote";

/** The answer of a tool. A tool fault is `isError: true`, never a protocol error. */
export interface ToolResult {
  structured: Record<string, unknown>;
  isError: boolean;
  /** The text block. When it is absent, the text block is the JSON of `structured`. */
  text?: string;
}

export interface ToolImpl {
  row: ToolRow;
  call(input: Record<string, unknown>): Promise<ToolResult>;
}

/** One resource template. The SDK lists it in resources/templates/list. */
export interface ResourceTemplateSpec {
  name: string;
  uriTemplate: string;
  title: string;
  description: string;
  mimeType: string;
}

/** One entry of resources/list. */
export interface ResourceEntry {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

/** One page of resources/list. A page with no nextCursor is the last page. */
export interface ResourceListPage {
  resources: readonly ResourceEntry[];
  nextCursor?: string;
}

/**
 * The resources of a server. The list and the read cover every template, so
 * the seam pages one list and not one list per template.
 */
export interface ResourceSpec {
  templates: readonly ResourceTemplateSpec[];
  /** One page of the list, or null for a cursor that the list did not give. */
  list(cursor: string | undefined): ResourceListPage | null;
  /** The text of one resource, or null when the URI names no resource. */
  read(uri: string): string | null;
}

/**
 * One prompt: one skill of the skill pack (prompts.ts). Each argument is a
 * string. An argument with values takes one of them; an empty list takes any text.
 */
export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  args: readonly {
    name: string;
    description: string;
    required: boolean;
    values: readonly string[];
  }[];
  /** The text of the prompt for the given arguments. */
  text(args: Readonly<Record<string, string>>): string;
}

/** One skill of the skill pack: the folder name and the text of its SKILL.md. */
export interface Skill {
  name: string;
  markdown: string;
}

export type SkillSet = readonly Skill[];

export interface ServerSpec {
  name: "authtempo";
  version: string;
  instructions: string;
  tools: readonly ToolImpl[];
  resources: ResourceSpec;
  prompts: readonly PromptSpec[];
}
