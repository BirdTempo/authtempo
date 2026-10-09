// The example desktop app for the plan 6c device proof. Main process only, no window.
// It follows the Electron section of packages/handoff/README.md.
// Shapes checked against the electron 44.7.0 type definitions on 2026-10-10.
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@tempo-auth/client";
import { createHandoff } from "@tempo-auth/handoff";
import {
  asyncSafeStorageCipher,
  createTokenStore,
  type ElectronShellLike,
  electronOpener,
} from "@tempo-auth/handoff/electron";
import { app, safeStorage, shell } from "electron";

const SCHEME = "example-app";
const REDIRECT = `${SCHEME}://auth`;
const BASE_URL = process.env.EXAMPLE_API_URL ?? "http://localhost:8787";

// The single-instance lock lives in the userData folder. Both instances must set the same
// path before they ask for the lock, or the second instance gets a lock of its own.
const proofDir = process.env.PROOF_DIR;
if (proofDir) app.setPath("userData", join(proofDir, "user-data"));
const logDir = proofDir ?? app.getPath("userData");
const logFile = join(logDir, "events.jsonl");

function log(event: string, data: Record<string, unknown> = {}): void {
  mkdirSync(logDir, { recursive: true });
  const line = { event, pid: process.pid, at: new Date().toISOString(), ...data };
  appendFileSync(logFile, `${JSON.stringify(line)}\n`);
}

// The Electron docs ask for the open-url listener early, before ready. This one only logs.
// The opener adds its own listener while a sign-in waits.
app.on("open-url", (_event, url) => log("open-url", { url }));

if (!app.requestSingleInstanceLock()) {
  // Electron sent this argv to the first instance. `app.quit()` does not stop this script, so stop here.
  log("second-instance-exit", { argv: process.argv.slice(1) });
  app.quit();
} else {
  main().catch((e: unknown) => {
    log("crashed", { message: String(e) });
    app.exit(1);
  });
}

async function main(): Promise<void> {
  log("started", { electron: process.versions.electron, platform: process.platform });
  log("protocol-client", { registered: app.setAsDefaultProtocolClient(SCHEME) });

  // In the proof, the script plays the browser over HTTP. The app then logs the start URL and
  // opens nothing. Without PROOF_DIR the system browser opens, as in a real app.
  const proofShell: ElectronShellLike = {
    openExternal: async (url) => log("open-external", { url }),
  };
  const opener = electronOpener({ shell: proofDir ? proofShell : shell, app });
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${SCHEME}://`)) ?? "";
    log("second-instance", { url });
    opener.receive(url);
  });

  const file = join(app.getPath("userData"), "token.bin");
  const store = createTokenStore({
    cipher: asyncSafeStorageCipher(safeStorage),
    read: () =>
      readFile(file).catch((e: NodeJS.ErrnoException) =>
        e.code === "ENOENT" ? null : Promise.reject(e),
      ),
    write: (bytes) => writeFile(file, bytes),
    remove: () =>
      unlink(file).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      }),
  });
  const client = createClient({ baseURL: BASE_URL, credentials: "omit", token: () => store.get() });
  const handoff = createHandoff({ baseURL: BASE_URL, redirect: REDIRECT, opener });

  // set() needs ready: before ready, Windows and Linux report no encryption.
  await app.whenReady();
  const rounds = Number(process.env.PROOF_ROUNDS ?? "1");
  for (let round = 1; round <= rounds; round++) {
    const result = await handoff.signIn();
    if (!result.ok) {
      log("sign-in-failed", { round, code: result.code, status: result.status });
      continue;
    }
    const token = result.value.token;
    await store.set(token);
    const stored = await store.get();
    const onDisk = await readFile(file);
    const me = await fetch(`${BASE_URL}/me`, {
      headers: { authorization: `Bearer ${stored ?? ""}` },
    });
    const meBody = me.ok ? ((await me.json()) as { email: string }) : null;
    const session = await client.session();
    log("signed-in", {
      round,
      email: result.value.user.email,
      storedMatches: stored === token,
      plaintextOnDisk: onDisk.includes(token),
      meStatus: me.status,
      meEmail: meBody?.email ?? null,
      sessionEmail: session.ok ? (session.value?.user.email ?? null) : null,
    });
  }
  log("done");
  app.quit();
}
