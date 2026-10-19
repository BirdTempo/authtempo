// The local demo (final review M1 of plan 11b). wrangler dev listens on one
// port over local https, and DEMO_ORIGIN names the same origin. So core
// trusts the origin of each page, and each mail link and provider URL leads
// back to this run. With the planned host as DEMO_ORIGIN, core refuses each
// call of a page with 403 origin_not_trusted.
// The port is DEMO_DEV_PORT of src/facts.ts, or DEMO_PORT when it is set.
// Each other argument goes to wrangler, as `--persist-to <dir>` for a new store.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEMO_DEV_PORT, demoDevOrigin } from "../src/facts.ts";

/** The arguments of `wrangler` for a local run on `port`. */
export function devArgs(port) {
  return [
    "dev",
    "--port",
    String(port),
    "--local-protocol",
    "https",
    "--var",
    `DEMO_ORIGIN:${demoDevOrigin(port)}`,
  ];
}

/** The port of a run: DEMO_PORT when it is set, else DEMO_DEV_PORT. */
export function devPort(env) {
  const port = Number(env.DEMO_PORT ?? DEMO_DEV_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`dev: DEMO_PORT must be a port number, not "${env.DEMO_PORT}"`);
  return port;
}

const PKG = fileURLToPath(new URL("..", import.meta.url));

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = devPort(process.env);
  console.log(`dev: open ${demoDevOrigin(port)}/ and accept the local certificate of wrangler`);
  // The four keys of each wrangler spawn (ruling 40 of plan 11e).
  const child = spawn("pnpm", ["exec", "wrangler", ...devArgs(port), ...process.argv.slice(2)], {
    cwd: PKG,
    stdio: "inherit",
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      NO_COLOR: "1",
      WRANGLER_HIDE_BANNER: "true",
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 1));
}
