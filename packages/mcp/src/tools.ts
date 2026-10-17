import { z } from "zod";
import { PAGE_TYPES } from "./index-format.js";
import type { Surface } from "./spec.js";

/**
 * One row of the tool table. The table is pure data (zod schemas, no CLI
 * import), so the remote Worker can hold it. A row that wraps a CLI command
 * names the command and its flags; a docs tool wraps none.
 */
export interface ToolRow {
  name: string;
  title: string;
  /** The first sentence states the effect of the tool: what it reads and what it writes. */
  description: string;
  surfaces: readonly Surface[];
  wraps: {
    command: string;
    positional: readonly string[];
    flags: Readonly<Record<string, string>>;
    /** The flags that the handler always passes, such as --json or --target postgres. */
    fixed: readonly string[];
    toolOnly: readonly string[];
  } | null;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /** A strict object: an input key that the row does not name is an input error. */
  input: z.ZodObject;
  outputKeys: readonly string[];
}

/** The docs tools read the index that the server loaded at its start, and nothing else. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** The docs version: "latest" until a release exists (spec 18 item 13). */
const docsVersion = z
  .string()
  .min(1)
  .max(40)
  .default("latest")
  .describe('The docs version. One of header.versions of the index; "latest" by default.');

/**
 * The stacks of `authtempo init`. The Worker cannot import the CLI, so the
 * list is a copy of STACKS of @authtempo/cli/program; scaffold.test.ts holds the two equal.
 */
export const SCAFFOLD_STACKS = [
  "workers-d1",
  "workers-postgres",
  "node",
  "bun",
  "mcp-server",
] as const;

/**
 * The keys of `authtempo init --json` (INIT_JSON_KEYS of the CLI): the
 * document of a run, with its exit code and the reason of a stop.
 */
const INIT_KEYS = ["stack", "dir", "files", "next", "exit", "stopped"] as const;

export const TOOLS: readonly ToolRow[] = [
  {
    name: "docs.search",
    title: "Search the authtempo docs",
    description:
      "Reads no file and writes nothing. Searches the sections of the authtempo docs and answers the best sections, each with its page path, its anchor, and a short snippet.",
    surfaces: ["local", "remote"],
    wraps: null,
    annotations: READ_ONLY,
    input: z.strictObject({
      query: z.string().min(2).max(200).describe("The words to search for."),
      limit: z.number().int().min(1).max(10).default(5).describe("The most hits to answer."),
      type: z.enum(PAGE_TYPES).optional().describe("Only the pages of this type."),
      version: docsVersion,
    }),
    outputKeys: ["version", "results"],
  },
  {
    name: "docs.read",
    title: "Read an authtempo docs page",
    description:
      "Reads no file and writes nothing. Answers the agent markdown of one docs page, or of one section of it. With no path, it answers the index of every page.",
    surfaces: ["local", "remote"],
    wraps: null,
    annotations: READ_ONLY,
    input: z.strictObject({
      // Any text. The handler adds a final slash and drops the site origin. A
      // path that is still unknown gets the nearest paths, not a schema error.
      path: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("A page path such as /docs/guides/magic-link/. With no path, the index."),
      section: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("The anchor of one section of the page, such as steps."),
      version: docsVersion,
    }),
    outputKeys: ["version", "path", "title", "description", "type", "sources", "markdown", "links"],
  },
  {
    name: "version",
    title: "The versions of authtempo and of the docs index",
    description:
      "Reads no file and writes nothing. Answers the versions of @authtempo/core, the CLI, and this server, the schema version, the protocol revision, and the facts of the docs index.",
    surfaces: ["local", "remote"],
    wraps: null,
    annotations: READ_ONLY,
    input: z.strictObject({}),
    outputKeys: ["core", "cli", "mcp", "schemaVersion", "protocol", "docsIndex"],
  },
  {
    name: "scaffold",
    title: "Write a new authtempo app",
    description:
      "Writes the files of a new app into dir, inside the server root, and overwrites no file. It runs authtempo init with the stack, and answers each file it wrote and the next steps. It runs no install.",
    surfaces: ["local"],
    wraps: {
      command: "init",
      positional: ["dir"],
      flags: { stack: "stack" },
      fixed: ["--json"],
      toolOnly: [],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: z.strictObject({
      // A dash at the start would read as a flag of the CLI, such as --help.
      dir: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^-]/)
        .describe("A relative path of a new folder inside the server root, such as apps/web."),
      stack: z.enum(SCAFFOLD_STACKS).describe("The stack of the app."),
    }),
    outputKeys: INIT_KEYS,
  },
];
