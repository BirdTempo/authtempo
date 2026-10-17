import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/commands/import-core.js";
import { INIT_JSON_KEYS } from "../src/json.js";
import { COMMANDS } from "../src/main.js";
import { STACKS } from "../src/templates.js";
import { CLI_VERSION, SCHEMA_VERSION } from "../src/version.js";
import { assertFreshBuild, PKG } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";

// The entry @authtempo/cli/program (plan 11e Task 1): the MCP server calls the
// CLI in process through it. The test reads the built entry by the package's
// own name, as the server reads it.

beforeAll(() => {
  assertFreshBuild();
});

const program = () => import("@authtempo/cli/program");

describe("the program entry (plan 11e)", () => {
  it("exports the program and the tables that the MCP server reads", async () => {
    const p = await program();
    expect(Object.keys(p.COMMANDS)).toEqual(Object.keys(COMMANDS));
    expect(p.STACKS).toEqual(STACKS);
    expect(p.PROVIDERS).toEqual(PROVIDERS);
    expect(p.CLI_VERSION).toBe(CLI_VERSION);
    expect(p.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });

  it("runs a command in process with a fake io", async () => {
    const p = await program();
    // The built init reads its templates from dist/templates.json.
    const templates = join(PKG, "dist/templates.json");
    const io = fakeIo({ files: { [templates]: readFileSync(templates, "utf8") } });
    const code = await p.main(["init", "app", "--stack", "node", "--json"], io);
    expect(code, io.stderr.join("\n")).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const doc = JSON.parse(io.stdout[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(INIT_JSON_KEYS).sort());
  });

  it("names one rule for a flag that can take a secret", async () => {
    const p = await program();
    expect(p.SECRETISH_FLAG.test("url")).toBe(true);
    expect(p.SECRETISH_FLAG.test("token-env")).toBe(true);
    expect(p.NAME_ONLY_FLAGS).toEqual(new Set(["password-column"]));
  });
});
