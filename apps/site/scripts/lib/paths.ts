import { fileURLToPath } from "node:url";

/** apps/site/, with a trailing slash. */
export const SITE = fileURLToPath(new URL("../../", import.meta.url));
/** The repo root, with a trailing slash. */
export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
/** The build output of `astro build`. */
export const DIST = `${SITE}dist/`;
/** The page sources. Every page is under docs/, so its URL is under /docs/. */
export const DOCS = `${SITE}src/content/docs/`;
/** The prose of the root pages: the content collection `site` (plan 11b Task 2). */
export const SITE_CONTENT = `${SITE}src/content/site/`;
