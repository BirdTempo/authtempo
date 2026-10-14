import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file under `dir` that `accept` takes, sorted, as absolute paths. A
 * missing `dir` throws: a check that reads no directory must fail, not pass.
 */
export function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out;
}
