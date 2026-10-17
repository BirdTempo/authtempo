// One remote address, four copies (plan 11e Task 16, review L-4). The Worker
// answers the host of wrangler.jsonc at MCP_PATH. The installer writes
// REMOTE_MCP_URL of @authtempo/cli. The index answer and the CLI reference page
// state it too. The CLI cannot depend on this package (a cycle), so this test ties them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_MCP_URL as CLI_URL } from "@authtempo/cli";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../cli/src/jsonc.js";
import { REMOTE_MCP_URL as INDEX_URL } from "../src/docs-tools.js";
import { MCP_PATH } from "../src/worker.js";
import { PKG, REPO } from "./support/bin.js";

describe("the remote address", () => {
  it("is the same in the Worker, the installer, the index answer, and the CLI page", () => {
    const config = parseJsonc(readFileSync(join(PKG, "wrangler.jsonc"), "utf8")) as {
      vars: { MCP_HOST: string };
    };
    const address = `https://${config.vars.MCP_HOST}${MCP_PATH}`;
    expect(CLI_URL).toBe(address);
    expect(INDEX_URL).toBe(address);
    const page = readFileSync(
      join(REPO, "apps/site/src/content/docs/docs/reference/cli/mcp.md"),
      "utf8",
    );
    const row = page.split("\n").find((l) => l.startsWith("| `--remote` |"));
    expect(row).toContain(`\`${address}\``);
  });
});
