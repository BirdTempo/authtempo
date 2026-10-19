/**
 * The global setup of the test run (plan 11g Task 5): an empty `.answers/`
 * with the start time, so the check run reads the records of this run only.
 */
const DIR = new URL("../../.answers/", import.meta.url);

/** Core's typecheck has no Node types (core runs on Workers); the specifier in a constant keeps node:fs out of it. */
interface StartFs {
  rmSync(dir: URL, options: { recursive: true; force: true }): void;
  mkdirSync(dir: URL, options: { recursive: true }): void;
  writeFileSync(file: URL, text: string): void;
}
const FS_MODULE = "node:fs";

export async function setup(): Promise<void> {
  const { rmSync, mkdirSync, writeFileSync }: StartFs = await import(/* @vite-ignore */ FS_MODULE);
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(new URL("start", DIR), `${new Date().toISOString()}\n`);
}
