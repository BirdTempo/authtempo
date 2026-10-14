import { beforeAll, describe, expect, it } from "vitest";
import { ROOT_HELP } from "../src/help/authtempo.js";
import { HELP } from "../src/help/index.js";
import { pageUrl } from "../src/help/types.js";
import { VERSION_JSON_KEYS } from "../src/json.js";
import { COMMANDS } from "../src/main.js";
import { assertFreshBuild, ESC, linesOf, runBin } from "./support/bin.js";

beforeAll(() => {
  assertFreshBuild();
});

/** The flag names that a help text lists: `--url-env <NAME>` gives url-env, `-n, --dry-run` gives dry-run. */
const helpFlags = (flags: readonly { flag: string }[]) =>
  flags.flatMap((f) => [...f.flag.matchAll(/--([a-z0-9.-]+)/g)].map((m) => m[1] ?? ""));

/** The command table in the order of the root help. Each task of plan 11c adds its command. */
const NAMES = ["import", "keys"];

describe("the common rules (spec 19)", () => {
  it("has the commands of the tasks so far, and one help text for each", () => {
    expect(Object.keys(COMMANDS)).toEqual(NAMES);
    expect(HELP).toEqual([ROOT_HELP, ...Object.values(COMMANDS).map((c) => c.help)]);
  });

  it("prints the version of the CLI and the schema version of its core", () => {
    const r = runBin(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("authtempo 0.0.0 (schema version 7)\n");
    const j = runBin(["--version", "--json"]);
    const doc = JSON.parse(j.stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(VERSION_JSON_KEYS).sort());
    expect(doc).toEqual({ cli: "0.0.0", schemaVersion: 7 });
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

      it("prints the short help on stderr and exits 2 on a usage error", () => {
        const r = runBin([name]);
        expect(r.status).toBe(2);
        expect(r.stdout).toBe("");
        expect(linesOf(r.stderr).at(-1)).toBe(`Run authtempo ${command.help.command} --help`);
      });

      it("lists every flag of its parser in its help, and no flag that the parser lacks", () => {
        expect(new Set(helpFlags(command.help.flags))).toEqual(
          new Set(Object.keys(command.options)),
        );
      });

      it("takes no secret as the value of a flag", () => {
        const SECRETISH = /secret|password|token|key|url|postgres|dsn/;
        // A column name, not a value: the Auth.js password column of `import`.
        const NAME_ONLY = new Set(["password-column"]);
        for (const [flag, spec] of Object.entries(command.options))
          if (spec.type === "string" && SECRETISH.test(flag) && !NAME_ONLY.has(flag))
            expect(flag, `--${flag} takes a value that can be a secret`).toMatch(/-(env|file)$/);
      });
    });
  }
});
