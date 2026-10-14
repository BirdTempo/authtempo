import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PKG, REPO } from "./bin.js";

/** The node_modules of the D1 example (11a Task 6): wrangler 4.148.0 and @authtempo/adapter-d1. */
export const D1_MODULES = join(REPO, "examples/worker-d1/node_modules");

/**
 * A Worker project for `authtempo migrate --target d1` inside the workspace
 * (plan 11c): wrangler.jsonc with one or two D1 databases, a small Worker
 * script, and a link to the D1 example's node_modules. A fixed `name` keeps
 * the folder for a person who wants to read the local database after a run.
 */
export function d1Project(
  o: {
    name?: string;
    migrationsDir?: string;
    files?: Record<string, string>;
    second?: boolean;
    modules?: boolean;
  } = {},
): { dir: string; database: string } {
  const dir = join(PKG, ".scaffold", o.name ?? `d1-${crypto.randomUUID().slice(0, 8)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = (binding: string, name: string) => ({
    binding,
    database_name: name,
    database_id: `${name}-fixture`,
    migrations_dir: o.migrationsDir ?? "node_modules/@authtempo/adapter-d1/migrations",
  });
  const config = {
    name: "cli-d1-fixture",
    main: "worker.ts",
    compatibility_date: "2026-09-30",
    d1_databases: [db("DB", "cli-d1"), ...(o.second ? [db("OTHER", "cli-d1-other")] : [])],
  };
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    `// A fixture of plan 11c: a Worker project for authtempo migrate --target d1.\n${JSON.stringify(config, null, 2)}\n`,
  );
  writeFileSync(join(dir, "worker.ts"), 'export default { fetch: () => new Response("ok") };\n');
  for (const [path, text] of Object.entries(o.files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (o.modules !== false) symlinkSync(D1_MODULES, join(dir, "node_modules"), "dir");
  return { dir, database: "cli-d1" };
}
