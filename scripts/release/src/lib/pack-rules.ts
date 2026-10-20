// The names that every pack check reads (plan 12j, spec 33 item 6). check-pack
// reads them for each release tarball. Each older proof/pack-files.mjs imports
// FORBIDDEN_PACK_NAMES and forbiddenMatch from here, so one list holds them all.
// Node runs this file by type stripping, also from a proof, so it holds only
// syntax that type stripping erases.

/**
 * Names that never ship, each with what it holds. A name that ends in "/" is a
 * folder at the start of a path or after any "/". A name that starts with "*"
 * matches the file name. Any other name matches a path part that starts with it.
 */
export const FORBIDDEN_PACK_NAMES = [
  ".env", // local secrets
  ".dev.vars", // wrangler dev secrets
  ".wrangler/", // the local D1 copy and the dev bundle of wrangler dev
  "node_modules/",
  ".scaffold/", // the scaffold copies of the CLI tests
  "test/",
  "src/", // except under a files entry that names a src folder
  "typetest/",
  "coverage/",
  "*.test.*",
  "*.tsbuildinfo",
] as const;

/**
 * The files that every release tarball holds outside `files`. pnpm adds
 * package.json, README.md, and LICENSE to each pack. An MIT package must carry
 * its notice, so LICENSE is required (ruling 12 of the plan 12j lane).
 */
export const ALWAYS_SHIPPED = ["package.json", "README.md", "LICENSE"] as const;

/** The changelog of each released package, which `files` lists (spec 33 item 3). */
export const CHANGELOG_FILE = "CHANGELOG.md";

/** File extensions of native or compiled code. A pack holds one only when its package declares it. */
export const BINARY_EXTENSIONS = [".node", ".wasm", ".so", ".dylib", ".dll", ".exe"] as const;

/** The declared binary files of each released package, by name. No package ships one today. */
export const DECLARED_BINARIES: Readonly<Record<string, readonly string[]>> = {};

/** The license of every released package: the owner's decision 2 of 2026-10-14. */
export const RELEASE_LICENSE = "MIT";

/**
 * The forbidden name that `path` matches, or null. `files` is the `files` list
 * of the package. A path under an entry that names a src folder, such as
 * worker/src of @authtempo/import, does not match "src/".
 */
export function forbiddenMatch(path: string, files: readonly string[] = []): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  for (const name of FORBIDDEN_PACK_NAMES) {
    if (name.startsWith("*")) {
      // "*.test.*" holds ".test." in the file name; "*.tsbuildinfo" ends it.
      const middle = name.slice(1).replace(/\*$/, "");
      if (name.endsWith("*") ? base.includes(middle) : base.endsWith(middle)) return name;
      continue;
    }
    if (!(path.startsWith(name) || path.includes(`/${name}`))) continue;
    if (name === "src/" && underSrcEntry(path, files)) continue;
    return name;
  }
  return null;
}

function underSrcEntry(path: string, files: readonly string[]): boolean {
  return files.some((entry) => {
    const folder = entry.replace(/^\.\//, "").replace(/\/$/, "");
    return (folder === "src" || folder.endsWith("/src")) && path.startsWith(`${folder}/`);
  });
}

/** The `repository` field of a released package: the public repository and the package folder. */
export function repositoryFor(
  url: string,
  dir: string,
): { type: "git"; url: string; directory: string } {
  return { type: "git", url: `git+${url}.git`, directory: dir };
}
