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

const DOCS_PATH = /^\/docs\/(?:[a-z0-9-]+\/)*$/;

/** The docs version: "latest" until a release exists (spec 18 item 13). */
const docsVersion = z
  .string()
  .min(1)
  .max(40)
  .default("latest")
  .describe('The docs version. One of header.versions of the index; "latest" by default.');

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
      path: z
        .string()
        .regex(DOCS_PATH)
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
];
