import { beforeAll, describe, expect, it } from "vitest";
import { COMMON_OPTIONS } from "../src/args.js";
import type { Command } from "../src/command.js";
import { UsageError } from "../src/errors.js";
import { ROOT_HELP } from "../src/help/authtempo.js";
import { HELP } from "../src/help/index.js";
import { COMMON_FLAGS, type HelpText, pageUrl, renderHelp } from "../src/help/types.js";
import { VERSION_JSON_KEYS } from "../src/json.js";
import { COMMANDS, makeMain } from "../src/main.js";
import { NAME_ONLY_FLAGS, SECRETISH_FLAG } from "../src/secrets.js";
import { assertFreshBuild, ESC, linesOf, runBin } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";

beforeAll(() => {
  assertFreshBuild();
});

/** The flag names that a help text lists: `--url-env <NAME>` gives url-env, `-n, --dry-run` gives dry-run. */
const helpFlags = (flags: readonly { flag: string }[]) =>
  flags.flatMap((f) => [...f.flag.matchAll(/--([a-z0-9.-]+)/g)].map((m) => m[1] ?? ""));

/** The command table in the order of the root help. Each task of plan 11c adds its command. */
const NAMES = [
  "init",
  "migrate",
  "import",
  "check",
  "keys",
  "mcp",
  "secret",
  "info",
  "users",
  "sessions",
  "audit",
  "create-admin",
  "generate",
  "upgrade",
];

/**
 * The commands that need an argument, so the bare command is a usage error
 * (plan 11c2 ruling 4). The list is typed by hand and is not read from
 * NAMES, because some commands run with no argument. A test below holds
 * the two lists to NAMES.
 */
const NEEDS_ARGUMENT = [
  "init",
  "migrate",
  "import",
  "check",
  "keys",
  "mcp",
  "users",
  "sessions",
  "audit",
  "create-admin",
  "generate",
] as const;

/**
 * The commands that run with no argument (ruling 5): `secret` prints a value,
 * `info` prints a report, and `upgrade` reads the package.json of the
 * current folder (plan 12j Task 10).
 */
const NO_ARGUMENT = ["secret", "info", "upgrade"] as const;

describe("the common rules (spec 19)", () => {
  it("has the fourteen commands in the order of the root help", () => {
    expect(Object.keys(COMMANDS)).toEqual(NAMES);
  });

  it("prints a Notes block after the exit codes for a help with notes, and none without", () => {
    const base: HelpText = {
      command: "x",
      page: "x",
      purpose: "A test help.",
      usage: ["authtempo x"],
      examples: [{ line: "authtempo x", says: "Run x." }],
      flags: [{ flag: "--json", says: "Print JSON." }],
      exits: [{ code: 0, says: "Done." }],
    };
    const plain = renderHelp(base);
    expect(plain).not.toContain("Notes:");
    const noted = renderHelp({ ...base, notes: ["A first note.", "A second note."] });
    const at = noted.indexOf("Notes:");
    expect(at).toBeGreaterThan(noted.indexOf("Exit codes:"));
    expect(noted.slice(at - 1, at + 3)).toEqual([
      "",
      "Notes:",
      "  A first note.",
      "  A second note.",
    ]);
    expect(noted.at(-1)).toBe(plain.at(-1));
  });

  it("prints the version of the CLI and the schema version of its core", () => {
    const r = runBin(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("authtempo 0.0.0 (schema version 15)\n");
    const j = runBin(["--version", "--json"]);
    const doc = JSON.parse(j.stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(VERSION_JSON_KEYS).sort());
    expect(doc).toEqual({ cli: "0.0.0", schemaVersion: 15 });
  });

  it("prints the short help on stderr and exits 2 with no command", () => {
    const r = runBin([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr).at(-1)).toBe("Run authtempo --help");
  });

  it("prints the complete root help for --help and for help, with every command and the docs link", () => {
    const a = runBin(["--help"]);
    const b = runBin(["help"]);
    expect(a.status).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    for (const c of Object.values(COMMANDS)) expect(a.stdout).toContain(`  ${c.help.command}  `);
    expect(a.stdout).toContain("Docs: https://authtempo.com/docs/reference/cli/\n");
  });

  it("suggests a near command and a near flag, and runs neither", () => {
    const c = runBin(["key"]);
    expect(c.status).toBe(2);
    expect(linesOf(c.stderr)[0]).toBe("unknown command key. Did you mean keys?");
    const f = runBin(["keys", "rotate", "https://api.example.com", "--yess"]);
    expect(f.status).toBe(2);
    expect(f.stdout).toBe("");
    expect(linesOf(f.stderr)[0]).toBe("unknown flag --yess. Did you mean --yes?");
  });

  it("names a command of the table in every example of every help text", () => {
    for (const h of HELP)
      for (const e of h.examples) {
        const [program, command] = e.line.split(" ");
        expect(program, e.line).toBe("authtempo");
        expect(Object.keys(COMMANDS), e.line).toContain(command);
      }
  });

  it("gives a short form only to --help (-h) and --dry-run (-n)", () => {
    const ALLOWED: Record<string, string> = { help: "h", "dry-run": "n" };
    for (const [name, c] of Object.entries(COMMANDS))
      for (const [flag, spec] of Object.entries(c.options))
        if (spec.short !== undefined)
          expect(`${name} --${flag} -${spec.short}`).toBe(`${name} --${flag} -${ALLOWED[flag]}`);
  });

  it("names --yes in the text of a flag only in a help that lists --yes", () => {
    const named = HELP.filter((h) =>
      h.flags.some((f) => f.flag !== "--yes" && f.says.includes("--yes")),
    ).map((h) => h.command);
    const listed = HELP.filter((h) => h.flags.some((f) => f.flag === "--yes")).map(
      (h) => h.command,
    );
    expect(named.filter((c) => !listed.includes(c))).toEqual([]);
    const tokenFile = (command: string) =>
      HELP.find((h) => h.command === command)?.flags.find((f) => f.flag === "--token-file <path>")
        ?.says;
    for (const command of [
      "keys rotate",
      "secret rewrap",
      "users ban",
      "users unban",
      "users platform-role",
      "users second-factor-off",
      "sessions end",
      "sessions end-all",
      "create-admin",
    ])
      expect(tokenFile(command)).toBe(
        "The file that holds the operator secret. A dash reads stdin, and then the command needs --yes.",
      );
    for (const command of [
      "secret status",
      "info",
      "users list",
      "users search",
      "users get",
      "audit list",
    ])
      expect(tokenFile(command)).toBe(
        "The file that holds the operator secret. A dash reads stdin.",
      );
  });

  it("splits NAMES into the commands that need an argument and the ones that run bare, with no name in both", () => {
    const both = [...NEEDS_ARGUMENT, ...NO_ARGUMENT];
    expect(new Set(both)).toEqual(new Set(NAMES));
    expect(both.length).toBe(NAMES.length);
    for (const name of NEEDS_ARGUMENT)
      expect((NO_ARGUMENT as readonly string[]).includes(name), name).toBe(false);
  });

  it("prints the short help on stderr and exits 2 for a bare command that needs an argument", () => {
    for (const name of NEEDS_ARGUMENT) {
      const command = COMMANDS[name];
      if (!command) throw new Error(`no command ${name}`);
      const r = runBin([name]);
      expect(r.status, name).toBe(2);
      expect(r.stdout, name).toBe("");
      expect(linesOf(r.stderr).at(-1), name).toBe(`Run authtempo ${command.help.command} --help`);
    }
  });

  it("writes no escape byte in any output", () => {
    for (const args of [
      ["--help"],
      ["--version"],
      ["key"],
      [],
      ...NAMES.flatMap((n) => [[n], [n, "--help"]]),
    ]) {
      const r = runBin(args);
      expect(r.stdout + r.stderr, args.join(" ")).not.toContain(ESC);
    }
  });

  for (const name of NAMES) {
    describe(`authtempo ${name}`, () => {
      const command = COMMANDS[name];
      if (!command) throw new Error(`no command ${name}`);

      it("prints the same complete help for --help, -h, help <command>, and --help among other arguments", () => {
        const runs = [
          runBin([name, "--help"]),
          runBin([name, "-h"]),
          runBin(["help", name]),
          runBin([name, "--nonsense", "--help", "extra"]),
        ];
        for (const r of runs) {
          expect(r.status).toBe(0);
          expect(r.stdout).toBe(runs[0]?.stdout);
        }
        const text = runs[0]?.stdout ?? "";
        for (const part of [
          "Usage:",
          "Examples:",
          "Flags:",
          "Exit codes:",
          `Docs: ${pageUrl(command.help)}\n`,
        ])
          expect(text).toContain(part);
        expect(text.indexOf("Examples:")).toBeLessThan(text.indexOf("Flags:"));
      });

      it("prints the short help on stderr and exits 2 on an unknown flag", () => {
        const r = runBin([name, "--no-such-flag"]);
        expect(r.status).toBe(2);
        expect(r.stdout).toBe("");
        expect(linesOf(r.stderr)[0]).toBe("unknown flag --no-such-flag");
        expect(linesOf(r.stderr).at(-1)).toBe(`Run authtempo ${command.help.command} --help`);
      });

      it("lists every flag of its parser in its help, and no flag that the parser lacks", () => {
        expect(new Set(helpFlags(command.help.flags))).toEqual(
          new Set(Object.keys(command.options)),
        );
        // Each subcommand has its own parser and its own help (plan 11c2).
        for (const [sub, s] of Object.entries(command.subcommands ?? {}))
          expect(new Set(helpFlags(s.help.flags)), `${name} ${sub}`).toEqual(
            new Set(Object.keys(s.options)),
          );
      });

      it("takes no secret as the value of a flag", () => {
        for (const [flag, spec] of Object.entries(command.options))
          if (spec.type === "string" && SECRETISH_FLAG.test(flag) && !NAME_ONLY_FLAGS.has(flag))
            expect(flag, `--${flag} takes a value that can be a secret`).toMatch(/-(env|file)$/);
      });
    });
  }
});

describe("subcommands (plan 11c2)", () => {
  /** A help text of a test command or a test subcommand, with one flag of its own. */
  const sub = (command: string, flag: string): HelpText => ({
    command,
    page: command.replace(" ", "-"),
    purpose: `Run ${command}.`,
    usage: [`authtempo ${command}`],
    examples: [{ line: `authtempo ${command}`, says: `Run ${command}.` }],
    flags: [{ flag, says: "A test flag." }, ...COMMON_FLAGS],
    exits: [{ code: 0, says: "Done." }],
  });
  // A table of one test command, built with makeMain: this block adds no real command.
  const demo: Command = {
    help: sub("demo", "--alpha"),
    options: { ...COMMON_OPTIONS, alpha: { type: "boolean" } },
    subcommands: {
      run: {
        help: sub("demo run", "--beta"),
        options: { ...COMMON_OPTIONS, beta: { type: "boolean" } },
      },
    },
    async run(argv) {
      if (argv[0] === "run" && argv.includes("--bad")) throw new UsageError("bad flag");
      return 0;
    },
  };
  const demoMain = makeMain({ demo });
  const runHelp = demo.subcommands?.run?.help;
  if (!runHelp) throw new Error("no subcommand run");

  it("prints the help of a subcommand for `demo run --help`, `demo run -h`, and `help demo run`", async () => {
    for (const argv of [
      ["demo", "run", "--help"],
      ["demo", "run", "-h"],
      ["help", "demo", "run"],
    ]) {
      const io = fakeIo();
      expect(await demoMain(argv, io), argv.join(" ")).toBe(0);
      expect(io.stdout, argv.join(" ")).toEqual(renderHelp(runHelp));
      expect(io.stderr).toEqual([]);
    }
    const io = fakeIo();
    expect(await demoMain(["demo", "--help"], io)).toBe(0);
    expect(io.stdout).toEqual(renderHelp(demo.help));
  });

  it("prints the usage of the subcommand on a usage error", async () => {
    const io = fakeIo();
    expect(await demoMain(["demo", "run", "--bad"], io)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      "bad flag",
      "Usage: authtempo demo run",
      "Example: authtempo demo run",
      "Run authtempo demo run --help",
    ]);
  });

  it("holds HELP to the table, each subcommand after its command", () => {
    expect(HELP).toEqual([
      ROOT_HELP,
      ...Object.values(COMMANDS).flatMap((c) => [
        c.help,
        ...Object.values(c.subcommands ?? {}).map((s) => s.help),
      ]),
    ]);
  });
});
