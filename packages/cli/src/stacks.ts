/**
 * The stack names of `authtempo init`. This file imports nothing, so the help
 * can read the list in workerd. templates.ts reads its package.json at load,
 * and examples/worker loads the CLI entry, with its help, in the Workers pool.
 */
export const STACKS = ["workers-d1", "workers-postgres", "node", "bun", "mcp-server"] as const;
export type Stack = (typeof STACKS)[number];
