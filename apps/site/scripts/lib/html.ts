function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decode(s.replace(/<[^>]+>/g, "")).trim();
}

/** Every `id` attribute of a page. Astro writes attributes in double quotes. */
export function idsOf(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1] ?? "")));
}

/** Every `href` attribute of a page, in document order. */
export function hrefsOf(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => decode(m[1] ?? ""));
}

/** The `id` of every h3 of a page: the anchor of a route or of an error code. */
export function h3Ids(html: string): string[] {
  return [...html.matchAll(/<h3\b[^>]*\sid="([^"]+)"/g)].map((m) => decode(m[1] ?? ""));
}

/** The text of the first cell of every table body row. */
export function firstCells(html: string): string[] {
  const out: string[] = [];
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cell = /<td[^>]*>([\s\S]*?)<\/td>/.exec(row[1] ?? "");
    if (cell) out.push(stripTags(cell[1] ?? ""));
  }
  return out;
}

/** The text of every `<code>` element of a page. */
export function codeTexts(html: string): Set<string> {
  return new Set(
    [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => stripTags(m[1] ?? "")),
  );
}

/** The id and the text of every h3 that has an id: the entry of a route or of an error code. */
export function h3Headings(html: string): { id: string; text: string }[] {
  return [...html.matchAll(/<h3\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => ({
    id: decode(m[1] ?? ""),
    text: stripTags(m[2] ?? ""),
  }));
}

/**
 * The text of every `<code>` element in a body cell whose column header is
 * one of `headers`, for every table of a page. A cell may hold more than one
 * code span, as in "`a`, `b`".
 */
export function columnCodes(html: string, headers: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of html.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
    const heads = [
      ...(/<thead>([\s\S]*?)<\/thead>/.exec(t[1] ?? "")?.[1] ?? "").matchAll(
        /<th[^>]*>([\s\S]*?)<\/th>/g,
      ),
    ].map((m) => stripTags(m[1] ?? ""));
    const columns = heads.flatMap((h, i) => (headers.includes(h) ? [i] : []));
    if (columns.length === 0) continue;
    const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(t[1] ?? "")?.[1] ?? "";
    for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
        (m) => m[1] ?? "",
      );
      for (const i of columns)
        for (const c of (cells[i] ?? "").matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g))
          out.push(stripTags(c[1] ?? ""));
    }
  }
  return out;
}
