// check-mcp (plan 11e Task 17): the MCP reference page against what the
// built server answers on the wire, as check-cli holds the CLI pages to
// `--help` (deviation 15). The tool table, the inputs, the annotations, the
// prompts, the template, and the owned limits each have one source: the
// server. The page must match it in both directions.
import { tableRows } from "./lib/cli-help.ts";
import type { WireLists, WireTool } from "./lib/mcp-wire.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The annotations of every tool, in the order of the page's fact table. */
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The JSON Schema keys of an input that the rules cell shows. Each other key fails the check. */
const KNOWN_KEYS = new Set([
  "type",
  "description",
  "default",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
]);

const RAW_TOOL_H3 = /^<h3 id="(tool-[^"]*)"><code>([^<]*)<\/code><\/h3>\s*$/;

/** The page anchor of a tool: tool- and the name with each "." as "-". */
export function toolAnchor(name: string): string {
  return `tool-${name.replaceAll(".", "-")}`;
}

/** The text of a cell that is one code span, or null. */
function codeOf(cell: string): string | null {
  return /^`([^`]+)`$/.exec(cell.trim())?.[1] ?? null;
}

const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));
const codes = (items: readonly string[]): string => items.map((i) => `\`${i}\``).join(", ");

/**
 * The rules cell of one input, from its JSON Schema: required, the default,
 * or optional; then the values, the length, the range, and the pattern.
 */
export function inputRules(prop: Readonly<Record<string, unknown>>, required: boolean): string {
  const parts = [
    required
      ? "required"
      : "default" in prop
        ? `default \`${JSON.stringify(prop.default)}\``
        : "optional",
  ];
  if (Array.isArray(prop.enum)) parts.push(`one of ${codes(prop.enum.map(String))}`);
  if ("const" in prop) parts.push(`only \`${JSON.stringify(prop.const)}\``);
  const { minLength: lo, maxLength: hi, minimum: min, maximum: max } = prop;
  if (lo !== undefined && hi !== undefined) parts.push(`${lo} to ${hi} characters`);
  else if (hi !== undefined) parts.push(`at most ${hi} characters`);
  else if (lo !== undefined) parts.push(`at least ${lo} characters`);
  if (min !== undefined && max !== undefined) parts.push(`${min} to ${max}`);
  else if (max !== undefined) parts.push(`at most ${max}`);
  else if (min !== undefined) parts.push(`at least ${min}`);
  if (typeof prop.pattern === "string") parts.push(`matches \`${prop.pattern}\``);
  return parts.join("; ");
}

/** The arguments cell of a prompt: each argument with "(required)" or "(optional)", or none. */
function argumentsCell(args: readonly { name: string; required: boolean }[]): string {
  return args.length === 0
    ? "none"
    : args.map((a) => `\`${a.name}\` (${a.required ? "required" : "optional"})`).join(", ");
}

/** The sections of the page that start at a raw tool h3, up to the next h3 or h2. */
function toolSections(page: string): { id: string; name: string; text: string }[] {
  const lines = page.split("\n");
  const out: { id: string; name: string; text: string }[] = [];
  for (const [i, line] of lines.entries()) {
    const m = RAW_TOOL_H3.exec(line);
    if (!m) continue;
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((l) => l.startsWith("<h3") || l.startsWith("## "));
    out.push({
      id: m[1] ?? "",
      name: m[2] ?? "",
      text: (end < 0 ? rest : rest.slice(0, end)).join("\n"),
    });
  }
  return out;
}

/** The first paragraph of a section: the lines up to the first blank line after the text starts. */
function firstParagraph(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() !== "");
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.trim() === "");
  return lines
    .slice(start, end < 0 ? lines.length : end)
    .map((l) => l.trim())
    .join(" ");
}

function compareTool(tool: WireTool, text: string, remote: readonly string[]): string[] {
  const f: string[] = [];
  const n = tool.name;
  if (firstParagraph(text) !== tool.description)
    f.push(`${n}: the description on the page differs from the wire`);
  const facts = new Map((tableRows(text, "Fact") ?? []).map((r) => [r[0] ?? "", r[1] ?? ""]));
  const title = facts.get("Title");
  if (title !== tool.title)
    f.push(`${n}: the title is ${title ?? "missing"} on the page and ${tool.title} on the wire`);
  const surfaces = list(remote.includes(n) ? ["local", "remote"] : ["local"]);
  const onPage = facts.get("Surfaces");
  if (onPage !== surfaces)
    f.push(`${n}: the surfaces are ${onPage ?? "missing"} on the page and ${surfaces} on the wire`);
  for (const hint of HINTS) {
    const cell = facts.get(`\`${hint}\``);
    const want = String(tool.annotations[hint]);
    if (cell === undefined) f.push(`${n}: the page lacks the annotation ${hint}`);
    else if (codeOf(cell) !== want)
      f.push(`${n}: ${hint} is ${codeOf(cell) ?? cell} on the page and ${want} on the wire`);
  }
  const keys = facts.get("Output keys");
  const pageKeys = (keys ?? "")
    .split(",")
    .map((k) => codeOf(k) ?? k.trim())
    .filter((k) => k !== "");
  if (pageKeys.join(", ") !== tool.outputKeys.join(", "))
    f.push(
      `${n}: the output keys are ${list(pageKeys)} on the page and ${list(tool.outputKeys)} on the wire`,
    );
  const rows = new Map(
    (tableRows(text, "Input") ?? []).map((r) => [codeOf(r[0] ?? "") ?? r[0] ?? "", r]),
  );
  for (const [key, prop] of Object.entries(tool.properties)) {
    const unread = Object.keys(prop).filter((k) => !KNOWN_KEYS.has(k));
    for (const k of unread) f.push(`${n}.${key}: the check cannot read the schema key ${k}`);
    const row = rows.get(key);
    if (row === undefined) {
      f.push(`${n}: the page lacks the input ${key}`);
      continue;
    }
    const type = String(prop.type ?? "");
    const rules = inputRules(prop, tool.required.includes(key));
    const says = String(prop.description ?? "");
    if (row[1] !== type)
      f.push(`${n}.${key}: the type is ${row[1]} on the page and ${type} on the wire`);
    if (row[2] !== rules)
      f.push(`${n}.${key}: the rules are ${row[2]} on the page and ${rules} on the wire`);
    if (row[3] !== says)
      f.push(`${n}.${key}: the text is ${row[3]} on the page and ${says} on the wire`);
  }
  for (const key of rows.keys())
    if (!(key in tool.properties)) f.push(`${n}: the input row ${key} is not in the schema`);
  return f;
}

/**
 * The reference page's source against the wire answers of the built server.
 * Each tool is an h3 `tool-<name>` with its description and two tables. The
 * fact table holds the title, the surfaces, the four annotations, and the
 * output keys. The input table holds the type, the rules, and the text of
 * each input. The prompt table, the template table, and the
 * limit table follow. A run error of the server is a failure.
 */
export function checkMcp(page: string, wire: WireLists): CheckReport {
  const r: CheckReport = {
    name: "check-mcp",
    counts: { tools: 0, inputs: 0, prompts: 0, templates: 0, limits: 0 },
    failures: [],
  };
  if (wire.error !== null) {
    r.failures.push(`the server did not answer: ${wire.error}`);
    return requireCounts(r, ["tools", "inputs", "prompts", "templates", "limits"]);
  }
  const sections = toolSections(page);
  const names = new Set(wire.tools.map((t) => t.name));
  for (const tool of wire.tools) {
    r.counts.tools = (r.counts.tools ?? 0) + 1;
    r.counts.inputs = (r.counts.inputs ?? 0) + Object.keys(tool.properties).length;
    const section = sections.find((s) => s.name === tool.name);
    if (section === undefined) {
      r.failures.push(`the page lacks the tool ${tool.name}`);
      continue;
    }
    if (section.id !== toolAnchor(tool.name))
      r.failures.push(
        `${tool.name}: the anchor is ${section.id}; the name gives ${toolAnchor(tool.name)}`,
      );
    r.failures.push(...compareTool(tool, section.text, wire.remote.tools));
  }
  for (const s of sections)
    if (!names.has(s.name)) r.failures.push(`the page anchor ${s.id} names no tool of the wire`);
  for (const name of wire.remote.tools)
    if (!names.has(name)) r.failures.push(`the remote tool ${name} is not on the local surface`);

  const prompts = new Map(
    (tableRows(page, "Prompt") ?? []).map((row) => [codeOf(row[0] ?? "") ?? row[0] ?? "", row]),
  );
  for (const p of wire.prompts) {
    r.counts.prompts = (r.counts.prompts ?? 0) + 1;
    const row = prompts.get(p.name);
    if (row === undefined) {
      r.failures.push(`the page lacks the prompt ${p.name}`);
      continue;
    }
    if (row[1] !== p.title)
      r.failures.push(
        `${p.name}: the prompt title is ${row[1]} on the page and ${p.title} on the wire`,
      );
    const args = argumentsCell(p.arguments);
    if (row[2] !== args)
      r.failures.push(`${p.name}: the arguments are ${row[2]} on the page and ${args} on the wire`);
  }
  for (const name of prompts.keys())
    if (!wire.prompts.some((p) => p.name === name))
      r.failures.push(`the prompt row ${name} is not on the wire`);

  const templates = new Map(
    (tableRows(page, "Template") ?? []).map((row) => [codeOf(row[0] ?? "") ?? row[0] ?? "", row]),
  );
  for (const t of wire.templates) {
    r.counts.templates = (r.counts.templates ?? 0) + 1;
    const row = templates.get(t.uriTemplate);
    if (row === undefined) {
      r.failures.push(`the page lacks the template ${t.uriTemplate}`);
      continue;
    }
    if (codeOf(row[1] ?? "") !== t.name || codeOf(row[2] ?? "") !== t.mimeType)
      r.failures.push(
        `${t.uriTemplate}: the name and type are ${row[1]}, ${row[2]} on the page and ${t.name}, ${t.mimeType} on the wire`,
      );
  }
  for (const uri of templates.keys())
    if (!wire.templates.some((t) => t.uriTemplate === uri))
      r.failures.push(`the template row ${uri} is not on the wire`);

  // Both surfaces serve the prompts and the template (spec 21 item 2), so the page lists them once.
  const localPrompts = wire.prompts.map((p) => p.name);
  if (list(wire.remote.prompts) !== list(localPrompts))
    r.failures.push(
      `the remote prompts are ${list(wire.remote.prompts)}; the local prompts are ${list(localPrompts)}`,
    );
  const localTemplates = wire.templates.map((t) => t.uriTemplate);
  if (list(wire.remote.templates) !== list(localTemplates))
    r.failures.push(
      `the remote templates are ${list(wire.remote.templates)}; the local templates are ${list(localTemplates)}`,
    );

  const limits = new Map(
    (tableRows(page, "Limit") ?? []).map((row) => [codeOf(row[0] ?? "") ?? row[0] ?? "", row]),
  );
  for (const [key, value] of Object.entries(wire.limits)) {
    r.counts.limits = (r.counts.limits ?? 0) + 1;
    const row = limits.get(key);
    if (row === undefined) r.failures.push(`the page lacks the limit ${key}`);
    else if (codeOf(row[1] ?? "") !== String(value))
      r.failures.push(
        `${key}: the limit is ${codeOf(row[1] ?? "") ?? row[1]} on the page and ${value} in LIMITS`,
      );
  }
  for (const key of limits.keys())
    if (!(key in wire.limits)) r.failures.push(`the limit row ${key} is not in LIMITS`);

  return requireCounts(r, ["tools", "inputs", "prompts", "templates", "limits"]);
}
