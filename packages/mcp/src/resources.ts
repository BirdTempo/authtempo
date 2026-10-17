// The docs resources: each page of the index is one resource, and its text
// is the page's agent markdown. The list and the read come from the index
// only, so the resources equal the index (spec 21 item 13). This file
// imports no Node module, because the remote Worker serves it too.
import type { AgentIndex } from "./index-format.js";
import type { ResourceEntry, ResourceListPage, ResourceSpec } from "./spec.js";

/** The number of entries of one resources/list answer. */
export const RESOURCE_PAGE = 100;

/**
 * The scheme of the resource URIs. "authtempo" is a valid RFC 3986 scheme
 * name. The https form is not used: the site is not published, and a client
 * can fetch an https resource itself.
 */
const PREFIX = "authtempo://docs/";

/** The RFC 6570 template of each page. The "+" operator lets the path hold slashes. */
export const RESOURCE_TEMPLATE = `${PREFIX}{+path}`;

export const RESOURCE_MIME = "text/markdown";

/** The last segment of the home page URI. The home page path /docs/ has no segment of its own. */
const HOME = "index";

/**
 * The URI of a page path: /docs/guides/magic-link/ gives
 * authtempo://docs/guides/magic-link, and /docs/ gives authtempo://docs/index.
 */
export function resourceUri(path: string): string {
  if (path === "/docs/") return `${PREFIX}${HOME}`;
  // A page at /docs/index/ would have the URI of the home page.
  if (path === `/docs/${HOME}/`) throw new Error(`the page ${path} has the URI of the home page`);
  return `${PREFIX}${path.slice("/docs/".length, -1)}`;
}

/** The page path of a resource URI, or null when the URI is not of the docs form. */
function pathOf(uri: string): string | null {
  if (!uri.startsWith(PREFIX)) return null;
  const rest = uri.slice(PREFIX.length);
  if (rest === HOME) return "/docs/";
  return rest.length === 0 ? null : `/docs/${rest}/`;
}

/** A cursor is the offset of the next entry, as the list gave it: no sign and no leading zero. */
const CURSOR = /^[1-9][0-9]*$/;

/**
 * One page of the resource list, in the sidebar order of the index. It
 * returns null for a cursor that this list does not give.
 */
export function listResources(
  index: AgentIndex,
  cursor: string | undefined,
  size: number = RESOURCE_PAGE,
): ResourceListPage | null {
  let start = 0;
  if (cursor !== undefined) {
    if (!CURSOR.test(cursor)) return null;
    start = Number(cursor);
    if (start >= index.pages.length) return null;
  }
  const resources: ResourceEntry[] = index.pages.slice(start, start + size).map((p) => ({
    uri: resourceUri(p.path),
    name: p.path,
    title: p.title,
    description: p.description,
    mimeType: RESOURCE_MIME,
  }));
  const next = start + size;
  if (next < index.pages.length) return { resources, nextCursor: String(next) };
  return { resources };
}

/** The agent markdown of the page of a URI, or null when no page has the URI. */
export function readResource(index: AgentIndex, uri: string): string | null {
  const path = pathOf(uri);
  if (path === null) return null;
  return index.pages.find((p) => p.path === path)?.markdown ?? null;
}

/** The resources of a server: the one template, the paged list, and the read. */
export function docsResources(index: AgentIndex, size: number = RESOURCE_PAGE): ResourceSpec {
  return {
    templates: [
      {
        name: "docs-page",
        uriTemplate: RESOURCE_TEMPLATE,
        title: "authtempo docs page",
        description:
          "One page of the authtempo docs as agent markdown. The path is the page path with no final slash, and index is the home page.",
        mimeType: RESOURCE_MIME,
      },
    ],
    list: (cursor) => listResources(index, cursor, size),
    read: (uri) => readResource(index, uri),
  };
}
