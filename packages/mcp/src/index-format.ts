import { z } from "zod";

/**
 * The format of the agent index, `dist/agent/index.json`. The site build
 * writes it and validates its own output with `parseAgentIndex`; the server
 * validates it at load. This file is the one owner of the format, so a change
 * of the format changes this file only. It imports no Node module, because
 * the remote server runs on a Worker.
 */
export const AGENT_INDEX_VERSION = 1;

export const PAGE_TYPES = ["tutorial", "how-to", "reference", "explanation"] as const;

export interface AgentPage {
  /** The URL path, such as `/docs/guides/magic-link/`. */
  path: string;
  title: string;
  description: string;
  type: (typeof PAGE_TYPES)[number];
  /** The label of the sidebar group. A page at the top level of the sidebar has "". */
  group: string;
  sources: string[];
  /** The agent markdown of the page. */
  markdown: string;
  /** The `/docs/` link targets of the page, in order, with no duplicate. */
  links: string[];
}

export interface AgentSection {
  /** The URL path of the page of the section. */
  path: string;
  heading: string;
  /** The id of the heading on the built page, or null when the build gives none. */
  anchor: string | null;
  depth: 2 | 3;
  /** The agent markdown under the heading, up to the next `##` or `###` heading. */
  text: string;
}

export interface AgentIndex {
  header: {
    format: 1;
    commit: string;
    builtFrom: string;
    pages: number;
    sections: number;
    versions: string[];
    /** Each forbidden word, in lower case, to its approved term. */
    terms: Record<string, string>;
    bindings: { name: string; page: string }[];
  };
  pages: AgentPage[];
  sections: AgentSection[];
}

const DOCS_PATH = /^\/docs\/(?:[a-z0-9-]+\/)*$/;

const pageSchema = z.strictObject({
  path: z.string().regex(DOCS_PATH),
  title: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(PAGE_TYPES),
  group: z.string(),
  sources: z.array(z.string()),
  markdown: z.string().min(1),
  links: z.array(z.string()),
});

const sectionSchema = z.strictObject({
  path: z.string().regex(DOCS_PATH),
  heading: z.string().min(1),
  anchor: z.string().min(1).nullable(),
  depth: z.union([z.literal(2), z.literal(3)]),
  text: z.string(),
});

const indexSchema = z
  .strictObject({
    header: z.strictObject({
      format: z.literal(AGENT_INDEX_VERSION),
      commit: z.string().min(1),
      builtFrom: z.string().min(1),
      pages: z.number().int().nonnegative(),
      sections: z.number().int().nonnegative(),
      versions: z.array(z.string()).min(1),
      terms: z.record(z.string(), z.string()),
      bindings: z.array(
        z.strictObject({ name: z.string().min(1), page: z.string().regex(DOCS_PATH) }),
      ),
    }),
    pages: z.array(pageSchema),
    sections: z.array(sectionSchema),
  })
  // The header counts are a promise of the file. A count that differs from
  // its array is a file that was cut or joined by hand.
  .refine((i) => i.header.pages === i.pages.length, {
    message: "header.pages differs from the number of pages",
    path: ["header", "pages"],
  })
  .refine((i) => i.header.sections === i.sections.length, {
    message: "header.sections differs from the number of sections",
    path: ["header", "sections"],
  });

/** The index of a JSON text. Throws with the first issue when the text does not keep the format. */
export function parseAgentIndex(text: string): AgentIndex {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`the agent index is not JSON: ${(e as Error).message}`);
  }
  const result = indexSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? issue.path.join(".") || "(root)" : "(root)";
    throw new Error(`the agent index is not valid: ${where}: ${issue?.message ?? "unknown issue"}`);
  }
  const index: AgentIndex = result.data;
  return index;
}
