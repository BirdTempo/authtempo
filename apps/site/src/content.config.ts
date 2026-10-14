import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
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
};
