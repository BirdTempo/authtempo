/**
 * The stacks of `authtempo init` and the facts of each one: the entry
 * `@authtempo/cli/stacks`. This file imports nothing and reads no file, so
 * the help reads the list in workerd, and a bundler can inline the entry. The
 * site builds its home page from it (plan 11b Task 5, ruling 20 of its lane).
 * templates.ts and ./program re-export both tables. test/stacks.test.ts holds
 * the no-import rule.
 */
export const STACKS = ["workers-d1", "workers-postgres", "node", "bun", "mcp-server"] as const;
export type Stack = (typeof STACKS)[number];

export interface StackInfo {
  /** The example app under examples/ that the stack copies. */
  example: string;
  /** The name of the stack in the scaffold's README. */
  label: string;
  /** The tutorial page under /docs/start/. */
  page: string;
  /** The file that lists the secrets: wrangler dev reads .dev.vars, the Node and Bun servers .env. */
  secrets: ".dev.vars.example" | ".env.example";
  /** The steps after `cd` and `pnpm install`. */
  next: readonly string[];
}

export const STACK_INFO: Readonly<Record<Stack, StackInfo>> = {
  "workers-d1": {
    example: "worker-d1",
    label: "Cloudflare Workers on D1",
    page: "workers-d1",
    secrets: ".dev.vars.example",
    next: ["cp .dev.vars.example .dev.vars", "authtempo migrate --target d1", "pnpm dev"],
  },
  "workers-postgres": {
    example: "worker-postgres",
    label: "Cloudflare Workers on Postgres through Hyperdrive",
    page: "workers-hyperdrive",
    secrets: ".dev.vars.example",
    next: [
      "cp .dev.vars.example .dev.vars",
      // A placeholder in quotes: a pasted <…> is a shell redirect.
      "export DATABASE_URL='postgres://…'",
      "authtempo migrate --target postgres",
      "pnpm dev",
    ],
  },
  // The Node and Bun servers apply the migrations at their start (src/main.ts of the example).
  node: {
    example: "node",
    label: "Node",
    page: "node",
    secrets: ".env.example",
    next: ["cp .env.example .env", "node --env-file=.env src/main.ts"],
  },
  bun: {
    example: "node",
    label: "Bun",
    page: "bun",
    secrets: ".env.example",
    next: ["cp .env.example .env", "bun src/main.ts"],
  },
  // An app's own MCP server, guarded by requireMcpAuth (plan 11e). It is a
  // Worker on D1, so its steps are those of workers-d1.
  "mcp-server": {
    example: "mcp-server",
    label: "an MCP server on Cloudflare Workers with D1",
    page: "mcp-server",
    secrets: ".dev.vars.example",
    next: ["cp .dev.vars.example .dev.vars", "authtempo migrate --target d1", "pnpm dev"],
  },
};
