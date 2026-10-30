// The names that every pack check reads (plan 12j, spec 33 item 6). check-pack
// reads them for each release tarball. Each older proof/pack-files.mjs imports
// FORBIDDEN_PACK_NAMES and forbiddenMatch from here, so one list holds them all.
// Node runs this file by type stripping, also from a proof, so it holds only
// syntax that type stripping erases.

/**
 * The scripts that npm or pnpm runs at pack or at publish. A dry run that runs
 * one is not dry, so no released manifest holds one. pnpm 12.8.1 runs each one
 * under publish --dry-run (review of Task 6, m1).
 */
export const PACK_SCRIPTS = [
  "prepack",
  "postpack",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
] as const;

/**
 * The scripts that npm and pnpm run at each install of an app. No released
 * package holds one: it would run code on the machine of each app, with no
 * read by the app (ruling 67 of plan 12j, Low 1). pnpm 12.8.1 refuses a build
 * script that no allowBuilds names, but that is a default of a supplier.
 */
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

/**
 * Names that never ship, each with what it holds. A name that ends in "/" is a
 * folder at the start of a path or after any "/". A name that starts with "*"
 * matches the file name. Any other name matches a path part that starts with it.
 * Each name matches at any depth, so a folder that `files` names cannot ship it.
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
  ".npmrc", // a registry token
  "*.pem", // a private key or a certificate
  "*.key", // a private key
  "id_rsa", // an SSH private key, and its .pub file
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.sqlite", // a local database, which can hold user rows
  "*.sqlite3",
  "*.db",
  ".git/", // the repository history and its config
  ".omc/", // the state of an agent tool
  ".superpowers/", // the plans and the review notes of the lane
  "AGENTS.md", // a notes file that turbo writes
  "proof/", // a repository proof: it runs only in the repository, and git holds its record
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

/**
 * The version constant in dist of each released package that has one, by
 * name (ruling 65 of plan 12j, M2). The code of the package answers it: core
 * in GET /operator/info and the OpenAPI document, mcp in its server info and
 * its version tool. The build writes the module from package.json
 * (scripts/write-version.mjs), and check-pack holds the value to the
 * manifest version of the tarball. So a test pinned to a new value cannot
 * ship 0.0.0. A test holds each entry to the build script of its package.
 */
export const VERSION_CONSTANTS: Readonly<Record<string, { file: string; name: string }>> = {
  "@authtempo/core": { file: "dist/version.generated.js", name: "VERSION" },
  "@authtempo/mcp": { file: "dist/version.generated.js", name: "MCP_VERSION" },
};

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
