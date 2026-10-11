/**
 * RFC 4180 CSV: fields split by commas, records by CRLF or LF; a quoted
 * field may hold commas, line breaks, and a doubled quote for one quote.
 * psql's `\copy ... with csv header` writes this form (jsonb as JSON text,
 * quoted), and so does Clerk's dashboard export.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.length === 0) quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("tempo-auth import: the CSV ends inside a quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The records of a CSV with a header row, by column name. A row with another field count is an error. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r, n) => {
      if (r.length !== header.length)
        throw new Error(
          `tempo-auth import: CSV row ${n + 2} has ${r.length} fields, the header has ${header.length}`,
        );
      return Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]));
    });
}
