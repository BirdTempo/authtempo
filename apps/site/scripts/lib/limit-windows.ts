import { readFileSync } from "node:fs";
import { walk } from "./files.ts";
import { REPO } from "./paths.ts";

/**
 * The window of one `limit(config, family, subject, window)` call of core,
 * read from the source. A part is null when the code takes it from a setting,
 * such as `phone.dailyCap`.
 */
export interface LimitWindowFact {
  family: string;
  seconds: number | null;
  max: number | null;
  /** The file of the call, relative to the core source folder. */
  at: string;
}

export interface SourceFile {
  path: string;
  text: string;
}

/** Every .ts file of packages/core/src, the one source of the limit windows. */
export function coreSources(): SourceFile[] {
  const dir = `${REPO}packages/core/src/`;
  return walk(dir, (p) => p.endsWith(".ts") && !p.endsWith(".d.ts")).map((p) => ({
    path: p.slice(dir.length),
    text: readFileSync(p, "utf8"),
  }));
}

/** The arguments of a call, from the index after its "(", split at the commas of depth 0. */
function callArgs(text: string, from: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote !== null) {
      cur += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (depth === 0) {
        out.push(cur.trim());
        // A trailing comma leaves an empty last argument.
        return out.filter((a, i) => a !== "" || i < out.length - 1);
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return out;
}

/**
 * The text of `const <name> = <value>;`: the last one before `before`, else
 * the first one after it. A module const may follow the function that reads
 * it. Null when the file has none.
 */
function constBefore(text: string, name: string, before: number): string | null {
  let found: string | null = null;
  const re = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*`, "g");
  for (const m of text.matchAll(re)) {
    if (found !== null && (m.index ?? 0) > before) break;
    const start = (m.index ?? 0) + m[0].length;
    const end = text.indexOf(";", start);
    found = text.slice(start, end).trim();
  }
  return found;
}

/**
 * The value of `name`: the last const of the file before the call, else the
 * one exported const of that name in all of core. Null when none is found
 * or two files differ.
 */
function resolveName(files: readonly SourceFile[], file: SourceFile, name: string, at: number) {
  const own = constBefore(file.text, name, at);
  if (own !== null) return own;
  const all = new Set(
    files.flatMap((f) => {
      if (!new RegExp(`\\bexport\\s+const\\s+${name}\\b`).test(f.text)) return [];
      const v = constBefore(f.text, name, f.text.length);
      return v === null ? [] : [v];
    }),
  );
  return all.size === 1 ? ([...all][0] ?? null) : null;
}

/** A number of the source: a literal, a product of literals, or a const that is one. */
function numberOf(
  expr: string,
  files: readonly SourceFile[],
  file: SourceFile,
  at: number,
): number | null {
  const e = expr.trim();
  if (/^[\d_]+(\s*\*\s*[\d_]+)*$/.test(e))
    return e.split("*").reduce((n, part) => n * Number(part.trim().replaceAll("_", "")), 1);
  if (/^[A-Z][A-Z0-9_]*$/.test(e)) {
    const v = resolveName(files, file, e, at);
    return v === null ? null : numberOf(v, files, file, at);
  }
  return null;
}

/** The two parts of a window object literal `{ seconds: …, max: … }`, else null. */
function windowOf(
  literal: string,
  files: readonly SourceFile[],
  file: SourceFile,
  at: number,
): { seconds: number | null; max: number | null } | null {
  const m = /^\{\s*seconds:\s*([^,]+),\s*max:\s*([^,}]+?),?\s*\}$/.exec(literal.trim());
  if (m === null) return null;
  return {
    seconds: numberOf(m[1] ?? "", files, file, at),
    max: numberOf(m[2] ?? "", files, file, at),
  };
}

/**
 * Every `limit(...)` call of core with its family and window. A call whose
 * family or window the scan cannot read is a failure. A family in `dynamic`
 * is the exception: its window is { null, null }, and the caller exempts it.
 */
export function limitWindows(
  files: readonly SourceFile[],
  dynamic: ReadonlySet<string>,
): { facts: LimitWindowFact[]; failures: string[] } {
  const facts: LimitWindowFact[] = [];
  const failures: string[] = [];
  for (const file of files)
    for (const m of file.text.matchAll(/(?<![\w.])(function\s+)?limit\(/g)) {
      // The declaration of `limit` itself.
      if (m[1] !== undefined) continue;
      const at = m.index ?? 0;
      const args = callArgs(file.text, at + m[0].length);
      const families = [...(args[1] ?? "").matchAll(/"([a-z][a-z-]*:[a-z][a-z-]*)"/g)].map(
        (f) => f[1] ?? "",
      );
      if (args.length !== 4 || families.length === 0) {
        failures.push(`${file.path}: a limit call with no family to read: ${args.join(", ")}`);
        continue;
      }
      const arg = args[3] ?? "";
      const literal = /^[A-Za-z_]\w*$/.test(arg) ? resolveName(files, file, arg, at) : arg;
      const window = literal === null ? null : windowOf(literal, files, file, at);
      for (const family of families) {
        if (window !== null) facts.push({ family, ...window, at: file.path });
        else if (dynamic.has(family))
          facts.push({ family, seconds: null, max: null, at: file.path });
        else failures.push(`${file.path}: the window ${arg} of ${family} is not a window literal`);
      }
    }
  return { facts, failures };
}
