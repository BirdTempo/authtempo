// The skill pack as prompts (plan 11e Task 14). Each skill of
// packages/mcp/skills/ is one prompt, and the text of the prompt is the body
// of its SKILL.md with each argument filled in. So the prompt and the skill
// are one source (spec 21 items 9 and 13). This file imports no Node module,
// because the remote Worker serves the prompts too. The Node reader of the
// skill folder is readSkills of index-reader.ts.
import type { z } from "zod";
import type { PromptSpec, Skill } from "./spec.js";
import { TOOLS } from "./tools.js";

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

/** One binding of the index header: the argument value and its reference page. */
export interface BindingRef {
  name: string;
  page: string;
}

/**
 * The slots that a skill body may hold. A "free" slot is a prompt argument
 * whose schema is the input of a tool row (one source), with no control
 * character and no ".." segment, because its text goes into the prompt. An
 * optional slot with no value gets its `absent` text, so the prompt text
 * reads as a whole step. The values of `binding` are the names of
 * header.bindings; `binding_page` is no argument: it is the page of the binding.
 */
type SlotInfo =
  | {
      kind: "free";
      tool: string;
      key: string;
      description: string;
      required: boolean;
      absent: string;
    }
  | { kind: "binding"; description: string }
  | { kind: "page" };

const SLOTS: Readonly<Record<string, SlotInfo>> = {
  // The docs put a new app under examples/ while the packages are not on a
  // registry, so pnpm links the workspace packages (start/index.md).
  dir: {
    kind: "free",
    tool: "scaffold",
    key: "dir",
    description: "A relative path of a new folder under examples/, such as examples/my-app.",
    required: false,
    absent: "a new folder under examples/, such as examples/my-app",
  },
  base_url: {
    kind: "free",
    tool: "check",
    key: "base_url",
    description: "The origin of the deployed API, such as https://auth.example.com.",
    required: false,
    absent: "the origin that the person gives",
  },
  binding: {
    kind: "binding",
    description: "The name of an authtempo framework binding, as the docs index lists it.",
  },
  binding_page: { kind: "page" },
};

/** True when a text holds a control character, which could start a new line of the prompt. */
function hasControl(text: string): boolean {
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The schema of a free slot: the tool row's input, and the prompt rules. */
function freeSchema(tool: string, key: string): z.ZodType<string> {
  const row = TOOLS.find((t) => t.name === tool);
  const schema = row?.input.shape[key] as z.ZodType<string> | undefined;
  if (schema === undefined) throw new Error(`the tool ${tool} has no input ${key}`);
  return schema
    .refine((v) => !hasControl(v), `${key} holds no control character`)
    .refine((v) => !v.split(/[\\/]/).includes(".."), `${key} holds no .. segment`);
}

/**
 * A value that YAML 1.2 reads as the same plain string: no indicator
 * character at the start, no ": " or " #" inside, and no space at an end. A
 * client of agentskills.io reads the frontmatter as YAML, so a value that
 * YAML reads another way, or refuses, is refused here.
 */
function plainScalar(value: string): boolean {
  return (
    value.length > 0 &&
    !/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(value) &&
    !/:\s|\s#|\s$|\t/.test(value) &&
    !value.endsWith(":")
  );
}

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
      if (!plainScalar(nested[2] ?? ""))
        fail(`the value of metadata.${nested[1]} is no plain YAML scalar`);
      fields[`metadata.${nested[1]}`] = nested[2] ?? "";
      continue;
    }
    const kv = /^([a-z_]+):(?: (.+))?$/.exec(line);
    if (!kv) fail(`the frontmatter line "${line}" is not a key and a value`);
    if (kv?.[2] !== undefined && !plainScalar(kv[2]))
      fail(`the value of ${kv[1]} is no plain YAML scalar`);
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
  if (slots.includes("binding_page") && !slots.includes("binding"))
    fail("the body holds {binding_page} with no {binding}");
  return { name, description, source, title: title ?? "", body, slots };
}

/**
 * The prompt of one skill. Its name is the skill name without the prefix.
 * `args.bindings` is header.bindings of the index: the names are the values
 * of the argument binding (deviation 13 of the plan), and each page fills
 * {binding_page}.
 */
export function skillPrompt(skill: Skill, args: { bindings: readonly BindingRef[] }): PromptSpec {
  const parsed = parseSkill(skill);
  const promptArgs = parsed.slots.flatMap((slot): PromptSpec["args"][number][] => {
    const info = SLOTS[slot];
    if (info === undefined || info.kind === "page") return [];
    if (info.kind === "binding") {
      if (args.bindings.length === 0)
        throw new Error(`skills/${skill.name}: the docs index lists no binding`);
      return [
        {
          name: slot,
          description: info.description,
          required: true,
          values: args.bindings.map((b) => b.name),
          schema: null,
        },
      ];
    }
    return [
      {
        name: slot,
        description: info.description,
        required: info.required,
        values: [],
        schema: freeSchema(info.tool, info.key),
      },
    ];
  });
  return {
    name: parsed.name.slice(SKILL_PREFIX.length),
    title: parsed.title,
    description: parsed.description,
    args: promptArgs,
    text(values) {
      const given = (slot: string) => (Object.hasOwn(values, slot) ? values[slot] : undefined);
      return parsed.body.replace(SLOT, (_all, slot: string) => {
        const info = SLOTS[slot];
        if (info?.kind === "page") {
          const page = args.bindings.find((b) => b.name === given("binding"))?.page;
          if (page === undefined)
            throw new Error(`the prompt ${parsed.name} needs a known binding`);
          return page;
        }
        const value = given(slot);
        if (value !== undefined) return value;
        if (info?.kind !== "free" || info.required)
          throw new Error(`the prompt ${parsed.name} needs the argument ${slot}`);
        return info.absent;
      });
    },
  };
}

/** The prompts of a skill set, in the order of the set. */
export function skillPrompts(
  skills: readonly Skill[],
  args: { bindings: readonly BindingRef[] },
): PromptSpec[] {
  return skills.map((s) => skillPrompt(s, args));
}
