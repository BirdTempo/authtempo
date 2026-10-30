// The version module of a package, from its package.json (ruling 65 of plan
// 12j, M2). `changeset version` moves only package.json, so a version literal
// in src stays at 0.0.0 in every release (final review D of plan 12j, M2). The
// build and the typecheck of core and of mcp run this script in the package
// folder, as `node ../../scripts/write-version.mjs <NAME>`. It writes
// src/version.generated.ts with one constant of that name. Each package
// .gitignore keeps the file out of git, so no commit holds a second source.
// check-pack holds the constant in dist to the manifest of each tarball.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const name = process.argv[2];
if (name === undefined || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error("write-version: give the name of the constant, such as VERSION");
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`write-version: the version of package.json is not x.y.z: ${String(version)}`);
  process.exit(1);
}

const target = resolve("src/version.generated.ts");
const text = [
  "// Generated from the version of package.json by scripts/write-version.mjs. Do not edit.",
  `export const ${name} = ${JSON.stringify(version)};`,
  "",
].join("\n");

// The typecheck runs this script after the build. A write of the same bytes
// makes src newer than dist, and the build-age rule of release-check (spec 33
// item 12.1) then fails on a fresh build (ruling 57 of plan 12j). So the
// script writes only when the bytes differ, as copy-migrations does.
const same = existsSync(target) && readFileSync(target, "utf8") === text;
if (!same) writeFileSync(target, text);
console.log(`write-version: ${name} ${version}, ${same ? "unchanged" : "written"}`);
