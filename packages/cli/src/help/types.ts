/** The docs pages of the CLI (spec 19). The site's check-cli reads each link against its build. */
export const DOCS_BASE = "https://authtempo.com/docs/reference/cli/";

export interface HelpFlag {
  /** The flag as a person types it, such as `--url-env <NAME>` or `-n, --dry-run`. */
  flag: string;
  says: string;
}

/**
 * One help text (spec 19, the help rule). The prose fields (purpose, the
 * `says` of each example, flag, and exit) are Simplified Technical English;
 * the docs site's term and sentence checks read them through `helpProse`.
 */
export interface HelpText {
  /** The words after `authtempo`, such as `init` or `keys rotate`; "" for the program. */
  command: string;
  /** The page under /docs/reference/cli/, such as `init`; "" for the CLI page. */
  page: string;
  purpose: string;
  usage: readonly string[];
  examples: readonly { line: string; says: string }[];
  flags: readonly HelpFlag[];
  exits: readonly { code: 0 | 1 | 2; says: string }[];
  /** The root help only: the command table. */
  commands?: readonly { name: string; says: string }[];
}

/** The two flags of every command. */
export const COMMON_FLAGS: readonly HelpFlag[] = [
  { flag: "--json", says: "Print one JSON document on stdout. The human lines go to stderr." },
  { flag: "-h, --help", says: "Print this help. The command ignores every other argument." },
];

export function pageUrl(h: HelpText): string {
  return h.page === "" ? DOCS_BASE : `${DOCS_BASE}${h.page}/`;
}

/** The complete help: the purpose, the usage, the examples first, the flags, the exit codes, and the docs link. */
export function renderHelp(h: HelpText): string[] {
  const out = [h.purpose, "", "Usage:", ...h.usage.map((u) => `  ${u}`), "", "Examples:"];
  for (const e of h.examples) out.push(`  ${e.says}`, `    ${e.line}`);
  if (h.commands && h.commands.length > 0) {
    out.push("", "Commands:");
    const width = Math.max(...h.commands.map((c) => c.name.length));
    for (const c of h.commands) out.push(`  ${c.name.padEnd(width)}  ${c.says}`);
  }
  out.push("", "Flags:");
  const width = Math.max(...h.flags.map((f) => f.flag.length));
  for (const f of h.flags) out.push(`  ${f.flag.padEnd(width)}  ${f.says}`);
  out.push("", "Exit codes:");
  for (const x of h.exits) out.push(`  ${x.code}  ${x.says}`);
  out.push("", `Docs: ${pageUrl(h)}`);
  return out;
}

/** The short help of a usage error: the usage line, one example, and the way to the full help. */
export function shortHelp(h: HelpText): string[] {
  const name = h.command === "" ? "authtempo" : `authtempo ${h.command}`;
  return [
    `Usage: ${h.usage[0] ?? name}`,
    `Example: ${h.examples[0]?.line ?? name}`,
    `Run ${name} --help`,
  ];
}

/** The prose of a help text, one paragraph each, for the docs site's term and sentence checks. */
export function helpProse(h: HelpText): string[] {
  return [
    h.purpose,
    ...h.examples.map((e) => e.says),
    ...h.flags.map((f) => f.says),
    ...h.exits.map((x) => x.says),
  ];
}
