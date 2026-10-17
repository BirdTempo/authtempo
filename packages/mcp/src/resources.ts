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

/**
 * A cursor is the key of the index, a colon, and the offset of the next
 * entry. The key makes a cursor of another index build fail. This matters
 * for the stateless remote surface, where two requests can meet two deploys.
 */
const OFFSET = /^[1-9][0-9]*$/;

/**
 * The key of an index: its commit, a hyphen, and a hash of its page paths.
 * A build with no git has the commit "unknown", and a dirty tree has the commit
 * of the clean one. The hash still differs when the pages differ (review R-I1 of Task 6).
 */
export function indexKey(index: AgentIndex): string {
  return `${index.header.commit}-${fnv1a(index.pages.map((p) => p.path).join("\n"))}`;
}

/**
 * The 32-bit FNV-1a hash of a text, as 8 hex digits. It is no security check,
 * only a change marker. It needs no Node module and no async call.
 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The entries of the list, in the sidebar order. It throws for a page whose URI is not its own. */
export function resourceEntries(index: AgentIndex): ResourceEntry[] {
  return index.pages.map((p) => ({
    uri: resourceUri(p.path),
    name: p.path,
    title: p.title,
    description: p.description,
    mimeType: RESOURCE_MIME,
  }));
}

/**
 * One page of the entries. It returns null for a cursor that the list does
 * not give. Such a cursor has another index key, an offset that is not a page
 * start, or an offset past the end.
 */
function pageOf(
  entries: readonly ResourceEntry[],
  key: string,
  cursor: string | undefined,
  size: number,
): ResourceListPage | null {
  let start = 0;
  if (cursor !== undefined) {
    const colon = cursor.lastIndexOf(":");
    if (colon < 0 || cursor.slice(0, colon) !== key) return null;
    const offset = cursor.slice(colon + 1);
    if (!OFFSET.test(offset)) return null;
    start = Number(offset);
    if (start >= entries.length) return null;
    if (start % size !== 0) return null;
  }
  const resources = entries.slice(start, start + size);
  const next = start + size;
  if (next < entries.length) return { resources, nextCursor: `${key}:${next}` };
  return { resources };
}

/**
 * One page of the resource list, in the sidebar order of the index. It
 * returns null for a cursor that this list does not give.
 */
export function listResources(
  index: AgentIndex,
  cursor: string | undefined,
  size: number = RESOURCE_PAGE,
): ResourceListPage | null {
  return pageOf(resourceEntries(index), indexKey(index), cursor, size);
}

/** The agent markdown of the page of a URI, or null when no page has the URI. */
export function readResource(index: AgentIndex, uri: string): string | null {
  const path = pathOf(uri);
  if (path === null) return null;
  return index.pages.find((p) => p.path === path)?.markdown ?? null;
}

/** The resources of a server: the one template, the paged list, and the read. */
export function docsResources(index: AgentIndex, size: number = RESOURCE_PAGE): ResourceSpec {
  // The entries are made once, so a page with a wrong URI fails at the start of the server.
  const entries = resourceEntries(index);
  const key = indexKey(index);
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
    list: (cursor) => pageOf(entries, key, cursor, size),
    read: (uri) => readResource(index, uri),
  };
}
