// The skill pack as prompts (plan 11e Task 14). Each skill of
// packages/mcp/skills/ is one prompt, and the text of the prompt is the body
// of its SKILL.md with each argument filled in. So the prompt and the skill
// are one source (spec 21 items 9 and 13). This file imports no Node module,
// because the remote Worker serves the prompts too. The Node reader of the
// skill folder is readSkills of index-reader.ts.
import type { PromptSpec, Skill } from "./spec.js";

/** The prefix of each skill name. The prompt name is the skill name without it. */
export const SKILL_PREFIX = "authtempo-";

/**
 * The stacks whose prompt is not integrate-<stack>. The stack is the app-side
 * MCP surface; its runbook is the guide, not a framework integration.
 */
export const PROMPT_OF_STACK: Readonly<Record<string, string>> = {
  "mcp-server": "protect-mcp-server",
};

/** The prompt of one stack of `authtempo init`. */
function stackPrompt(stack: string): string {
  return Object.hasOwn(PROMPT_OF_STACK, stack)
    ? (PROMPT_OF_STACK[stack] ?? `integrate-${stack}`)
    : `integrate-${stack}`;
}

/**
 * The prompt names that the stacks and the providers give: one per stack,
 * one for the framework bindings, one per import provider, one for Better
 * Auth, and one for the deployment check (spec 21 item 9).
 */
export function expectedPrompts(stacks: readonly string[], providers: readonly string[]): string[] {
  return [
    ...stacks.map(stackPrompt),
    "integrate-binding",
    ...providers.map((p) => `migrate-${p}`),
    "migrate-better-auth",
    "check-deployment",
  ];
}

/** The agentskills.io name rule (agentskills.io/specification, read 2026-10-14). */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
/** The body of a skill stays under 500 lines (agentskills.io/specification, read 2026-10-14). */
export const BODY_LINES_MAX = 500;

/** One argument slot of a skill body, such as {dir}. */
const SLOT = /\{([a-z_]+)\}/g;

/**
 * The argument slots that a skill body may hold. An optional slot with no
 * value gets its `absent` text, so the prompt text reads as a whole step.
 * The values of `binding` are the names of header.bindings of the index.
 */
const SLOTS: Readonly<
  Record<string, { description: string; required: boolean; absent: string; bindings: boolean }>
> = {
  dir: {
    description: "A relative path of a new folder inside the server root, such as apps/web.",
    required: false,
    absent: "a new folder inside the root, such as my-app",
    bindings: false,
  },
  binding: {
    description: "The name of an authtempo framework binding, as the docs index lists it.",
    required: true,
    absent: "",
    bindings: true,
  },
  base_url: {
    description: "The origin of the deployed API, such as https://auth.example.com.",
    required: false,
    absent: "the origin that the person gives",
    bindings: false,
  },
};

/** A skill read through its frontmatter. */
export interface ParsedSkill {
  name: string;
  description: string;
  /** The docs page that the skill comes from (metadata.source). */
  source: string;
  /** The text of the first heading of the body. */
  title: string;
  /** The body after the frontmatter, with no blank line at the start. */
  body: string;
  /** The argument slots of the body, in the order of their first use. */
  slots: string[];
}

/**
 * Reads the frontmatter of a SKILL.md: the keys name, description, and
 * metadata with source, each on one line. It throws for another key, a
 * missing key, or a value that breaks a rule of agentskills.io.
 */
export function parseSkill(skill: Skill): ParsedSkill {
  const fail = (why: string): never => {
    throw new Error(`skills/${skill.name}/SKILL.md: ${why}`);
  };
  const lines = skill.markdown.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) fail("the file has no frontmatter");
  const fields: Record<string, string> = {};
  let inMetadata = false;
  for (const line of lines.slice(1, end)) {
    const nested = /^ {2}([a-z_]+): (.+)$/.exec(line);
    if (nested && inMetadata) {
      fields[`metadata.${nested[1]}`] = nested[2] ?? "";
      continue;
    }
    const kv = /^([a-z_]+):(?: (.+))?$/.exec(line);
    if (!kv) fail(`the frontmatter line "${line}" is not a key and a value`);
    const key = kv?.[1] ?? "";
    inMetadata = key === "metadata" && kv?.[2] === undefined;
    if (!inMetadata) fields[key] = kv?.[2] ?? "";
  }
  const keys = Object.keys(fields).sort().join(",");
  if (keys !== "description,metadata.source,name")
    fail(`the frontmatter keys are ${keys}, not description, metadata.source, and name`);
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  const source = fields["metadata.source"] ?? "";
  if (name.length > NAME_MAX || !NAME.test(name))
    fail(`the name ${name} is not 1 to ${NAME_MAX} of a-z, 0-9, and single hyphens`);
  if (name !== skill.name) fail(`the name ${name} is not the folder name`);
  if (!name.startsWith(SKILL_PREFIX)) fail(`the name ${name} does not start with ${SKILL_PREFIX}`);
  if (description.length < 1 || description.length > DESCRIPTION_MAX)
    fail(`the description has ${description.length} characters, not 1 to ${DESCRIPTION_MAX}`);
  if (!/^\/docs\/(?:[a-z0-9-]+\/)*$/.test(source))
    fail(`metadata.source ${source} is not a docs page path`);
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");
  if (body.split("\n").length >= BODY_LINES_MAX)
    fail(`the body has ${BODY_LINES_MAX} lines or more`);
  const title = /^# (.+)$/.exec(body.split("\n")[0] ?? "")?.[1];
  if (title === undefined) fail("the body does not start with a level-1 heading");
  const slots: string[] = [];
  for (const m of body.matchAll(SLOT)) {
    const slot = m[1] ?? "";
    if (!Object.hasOwn(SLOTS, slot)) fail(`the body holds the unknown argument {${slot}}`);
    if (!slots.includes(slot)) slots.push(slot);
  }
  return { name, description, source, title: title ?? "", body, slots };
}

/**
 * The prompt of one skill. Its name is the skill name without the prefix.
 * `args.bindings` holds the names of header.bindings of the index: the values
 * of the argument binding (deviation 13 of the plan).
 */
export function skillPrompt(skill: Skill, args: { bindings: readonly string[] }): PromptSpec {
  const parsed = parseSkill(skill);
  const promptArgs = parsed.slots.map((slot) => {
    const info = SLOTS[slot];
    if (info === undefined) throw new Error(`unknown argument ${slot}`);
    if (info.bindings && args.bindings.length === 0)
      throw new Error(`skills/${skill.name}: the docs index lists no binding`);
    return {
      name: slot,
      description: info.description,
      required: info.required,
      values: info.bindings ? [...args.bindings] : [],
    };
  });
  return {
    name: parsed.name.slice(SKILL_PREFIX.length),
    title: parsed.title,
    description: parsed.description,
    args: promptArgs,
    text(values) {
      return parsed.body.replace(SLOT, (_all, slot: string) => {
        const info = SLOTS[slot];
        const value = Object.hasOwn(values, slot) ? values[slot] : undefined;
        if (value !== undefined) return value;
        if (info === undefined || info.required)
          throw new Error(`the prompt ${parsed.name} needs the argument ${slot}`);
        return info.absent;
      });
    },
  };
}

/** The prompts of a skill set, in the order of the set. */
export function skillPrompts(
  skills: readonly Skill[],
  args: { bindings: readonly string[] },
): PromptSpec[] {
  return skills.map((s) => skillPrompt(s, args));
}
