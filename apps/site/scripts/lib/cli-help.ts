import { execFileSync } from "node:child_process";
import { HELP, helpProse } from "@authtempo/cli";
import type { Page } from "./markdown.ts";
import { REPO } from "./paths.ts";

/**
 * Each help text of the CLI as a page of prose (plan 11c, spec 19), so the
 * term and sentence checks read the help as they read the docs. Each
 * purpose, example, flag, and exit text is one paragraph.
 */
export function cliHelpPages(): Page[] {
  return HELP.map((h) => ({
    path: `cli-help/${h.page === "" ? "authtempo" : h.page}`,
    source: `---\ntitle: ${h.command === "" ? "authtempo" : h.command}\n---\n\n${helpProse(h).join("\n\n")}\n`,
  }));
}

/** One command and the text that its `--help` printed. */
export interface HelpRun {
  /** The words after `authtempo`, such as `keys rotate`; "" for the program. */
  command: string;
  /** The stdout of `authtempo <command> --help`, or "" when the run failed. */
  output: string;
  /** Why the run failed, or null. */
  error: string | null;
}

/** The built binary. The site's Turbo task builds the CLI first (a dev dependency). */
const BIN = `${REPO}packages/cli/dist/bin/authtempo.js`;

/**
 * Runs `authtempo <command> --help` through the built binary for each help
 * text, so the check reads what a person reads, and not only the data that
 * the binary prints from. The list of commands comes from `HELP`, the one
 * list that the binary's command table is held to.
 */
export function helpRuns(): HelpRun[] {
  return HELP.map((h) => {
    const args = [...(h.command === "" ? [] : h.command.split(" ")), "--help"];
    try {
      const output = execFileSync(process.execPath, [BIN, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { command: h.command, output, error: null };
    } catch (e) {
      const err = e as { status?: number | null; stderr?: string; message?: string };
      const why = (err.stderr ?? err.message ?? "").trim().split("\n")[0] ?? "";
      return { command: h.command, output: "", error: `exit ${err.status ?? "?"}: ${why}` };
    }
  });
}

/** One flag as the help or a page names it. */
export interface FlagForm {
  /** The long form, such as `--dry-run`, or the only form. */
  name: string;
  /** The short form, such as `-n`, or null. */
  short: string | null;
  /** The value: a placeholder such as `<NAME>`, a value such as `postgres`, or null. */
  value: string | null;
}

/** The parts of a help text that a page must match. */
export interface ParsedHelp {
  flags: FlagForm[];
  exits: { code: string; says: string }[];
  /** The URL of the `Docs:` line, or null. */
  docs: string | null;
}

/** The lines of one titled block of the help, such as `Flags:`, up to the next blank line. */
function block(lines: readonly string[], title: string): string[] {
  const at = lines.indexOf(title);
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && l.trim() === "");
  return lines.slice(at + 1, end < 0 ? lines.length : end);
}

/**
 * One flag spec: `--url-env <NAME>`, `-n, --dry-run`, `--remote`, or (on a
 * page) `--target postgres`. A short form comes first, with a comma.
 */
export function parseFlagSpec(spec: string): FlagForm | null {
  const m = /^(?:(-[A-Za-z]),\s*)?(--?[A-Za-z0-9][\w.-]*)(?:\s+(.+))?$/.exec(spec.trim());
  if (!m) return null;
  return { name: m[2] ?? "", short: m[1] ?? null, value: m[3] ?? null };
}

/** The flags, the exit codes, and the docs link of a `--help` output. */
export function parseHelp(output: string): ParsedHelp {
  const lines = output.split("\n");
  const flags: FlagForm[] = [];
  for (const line of block(lines, "Flags:")) {
    // The flag column is padded to one width, so two spaces end the spec.
    const spec = line.trim().split(/\s{2,}/)[0] ?? "";
    const f = parseFlagSpec(spec);
    if (f) flags.push(f);
  }
  const exits: { code: string; says: string }[] = [];
  for (const line of block(lines, "Exit codes:")) {
    const m = /^\s*(\d+)\s{2,}(.+)$/.exec(line);
    if (m) exits.push({ code: m[1] ?? "", says: (m[2] ?? "").trim() });
  }
  const docs = /^Docs: (\S+)$/m.exec(output)?.[1] ?? null;
  return { flags, exits, docs };
}

/** The rows of the one markdown table whose first header cell is `header`, as cells. */
export function tableRows(source: string, header: string): string[][] | null {
  const lines = source.split("\n").map((l) => l.trim());
  const at = lines.findIndex(
    (l, i) =>
      l.startsWith("|") && cellsOf(l)[0] === header && (lines[i + 1] ?? "").startsWith("| ---"),
  );
  if (at < 0) return null;
  const rows: string[][] = [];
  for (let i = at + 2; i < lines.length && lines[i]?.startsWith("|"); i++)
    rows.push(cellsOf(lines[i] ?? ""));
  return rows;
}

function cellsOf(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * The flags of a page's flag table: each code span of the first cell that
 * starts with `-`. A cell such as `` `-n`, `--dry-run` `` is one flag with
 * its short form. A cell with no flag, such as `[dir]`, names an argument.
 */
export function pageFlags(cell: string): FlagForm[] {
  const spans = [...cell.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.startsWith("-"));
  const out: FlagForm[] = [];
  let short: string | null = null;
  for (const s of spans) {
    const f = parseFlagSpec(s);
    if (!f) continue;
    if (/^-[A-Za-z]$/.test(f.name) && f.value === null) {
      short = f.name;
      continue;
    }
    out.push({ ...f, short: f.short ?? short });
    short = null;
  }
  if (short !== null) out.push({ name: short, short: null, value: null });
  return out;
}
