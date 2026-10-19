import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// The two fields of plan 11a (spec 18). They are optional here so that a page
// that Starlight builds itself, such as its 404 page, never fails this schema.
// The frontmatter check (scripts/check-frontmatter.ts) refuses a docs page
// without them, with the page's path in the message.
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        type: z.enum(["tutorial", "how-to", "reference", "explanation"]).optional(),
        sources: z.array(z.string().min(1)).optional(),
      }),
    }),
  }),
  // The prose of the root pages (plan 11b). The term and sentence checks read
  // these files; no root page holds prose of its own beyond a heading or a label.
  // The home has no entry: it keeps the page of plan 11b1, built from HOME
  // (ruling 5 of the plan 11b lane). check-site-pages holds the rest.
  site: defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/site" }),
    schema: z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      page: z.string().regex(/^\/([a-z-]+\/)*$/),
    }),
  }),
};
