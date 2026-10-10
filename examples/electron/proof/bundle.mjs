// Builds a temporary app bundle for the proof. macOS routes a URL scheme only to a bundle whose
// Info.plist declares it in CFBundleURLTypes (Electron 44.7.0 docs for setAsDefaultProtocolClient
// and open-url, read 2026-10-10). The unpackaged Electron.app declares no example-app.
// On macOS 27.0 the unpackaged app got open-url all the same (spike, 2026-10-10): the runtime
// call set a handler preference for com.github.electron. A shipped app is a bundle, and every
// Electron dev binary shares that bundle id, so the proof keeps its own bundle.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const BUNDLE_ID = "dev.tempo-auth.example-electron";
// Chromium names the Keychain item "<app name> Safe Storage". The app name comes from productName.
const KEYCHAIN_SERVICE = "TempoAuthExample Safe Storage";
// Every child process has a limit, so a dialog or a stuck tool fails the run, never hangs it.
// 15 s for a quick tool. 60 s for a copy or a signature of the whole Electron.app (about 250 MB).
const QUICK = 15_000;
const SLOW = 60_000;

/**
 * Deletes every Keychain item of the proof. The access list of an item names an earlier ad hoc
 * signature, so a read would ask for a password and the proof would hang (Review Focus 2).
 * One call deletes one item, so this repeats until `security` answers exit 44 (no such item).
 */
export function deleteKeychainItem() {
  for (let i = 0; i < 20; i++) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE], {
        stdio: "ignore",
        timeout: QUICK,
      });
    } catch (e) {
      // Exit 44: no such item, which is the clean state. Any other end (a timeout on a Keychain
      // dialog, a locked Keychain) leaves an item, so it must fail the run.
      if (e.status === 44) return;
      throw new Error(
        `security delete-generic-password ended with ${e.status ?? e.code ?? e.signal}`,
      );
    }
  }
  throw new Error(`more than 20 Keychain items named "${KEYCHAIN_SERVICE}"; delete them by hand`);
}

export function buildBundle(outDir) {
  // From Node, require("electron") answers the path of the binary in Electron.app/Contents/MacOS.
  const binary = require("electron");
  const source = resolve(binary, "..", "..", "..");
  const app = join(outDir, "TempoAuthExample.app");
  execFileSync("ditto", [source, app], { timeout: SLOW });
  const plist = join(app, "Contents", "Info.plist");
  const pb = (command) =>
    execFileSync(PLIST_BUDDY, ["-c", command, plist], { stdio: "pipe", timeout: QUICK });
  pb(`Set :CFBundleIdentifier ${BUNDLE_ID}`);
  pb("Set :CFBundleName TempoAuthExample");
  try {
    pb("Delete :CFBundleURLTypes");
  } catch {
    // Electron.app may declare none. The delete keeps the step the same either way.
  }
  pb("Add :CFBundleURLTypes array");
  pb("Add :CFBundleURLTypes:0 dict");
  pb(`Add :CFBundleURLTypes:0:CFBundleURLName string ${BUNDLE_ID}`);
  pb("Add :CFBundleURLTypes:0:CFBundleURLSchemes array");
  pb("Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string example-app");
  // Electron runs Contents/Resources/app before its default app. The stub imports the built main,
  // so module resolution starts in examples/electron and finds the workspace packages.
  const appDir = join(app, "Contents", "Resources", "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "package.json"),
    JSON.stringify({
      name: "tempo-auth-example-electron",
      productName: "TempoAuthExample",
      type: "module",
      main: "main.js",
    }),
  );
  const main = pathToFileURL(join(PKG_DIR, "dist", "main.js")).href;
  writeFileSync(join(appDir, "main.js"), `import ${JSON.stringify(main)};\n`);
  // The plist edit breaks the bundle seal. An ad hoc signature makes it valid again.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "pipe",
    timeout: SLOW,
  });
  execFileSync(LSREGISTER, ["-f", app], { timeout: QUICK });
  return { app, exe: join(app, "Contents", "MacOS", "Electron") };
}

/**
 * Removes the bundle from LaunchServices. It answers null, or the error text. It never throws:
 * `lsregister -u` exits 1 for a path that is not registered (a stale or empty folder), so only
 * the caller knows if an error matters.
 */
export function unregisterBundle(app) {
  try {
    execFileSync(LSREGISTER, ["-u", app], { stdio: "pipe", timeout: QUICK });
    return null;
  } catch (e) {
    return `lsregister -u ended with ${e.status ?? e.code ?? e.signal}: ${String(e.stderr ?? "").trim()}`;
  }
}

/**
 * The bundle ids of the LaunchServices handler preference for a URL scheme, or null when there
 * is none. Unregistering the bundle does not remove this preference (macOS 27.0, 2026-10-10), so
 * `open example-app://...` fails with -10814 until the next run sets it again. The dump is about
 * 20 MB and takes about 2 s; 30 s allows a loaded machine.
 */
export function handlerPreference(scheme) {
  const dump = execFileSync(LSREGISTER, ["-dump"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  for (const block of dump.split(/\n-{20,}\n/)) {
    if (!/^handlerpref id:/m.test(block)) continue;
    if (!new RegExp(`^URL scheme:\\s+${scheme}$`, "m").test(block)) continue;
    return /^all roles:\s+(.+)$/m.exec(block)?.[1]?.trim() ?? "(no roles line)";
  }
  return null;
}
