import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { devArgs, devPort } from "../../scripts/dev.mjs";

// The local demo (final review M1 of plan 11b). The /demo/ page and the
// README give `pnpm --filter @authtempo/demo dev`. This file holds that the
// command gives a demo where a page call works. A dev script that keeps the
// planned host as DEMO_ORIGIN gets 403 origin_not_trusted on the first call.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A port that the OS gives as free now (the lane rule: no fixed port in a test). */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? done(address.port) : fail(address),
      );
    });
  });
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One request over https to the local run. wrangler signs its own certificate. */
function send(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<Answer>((done, fail) => {
    const req = request(
      url,
      { method: init.method ?? "GET", headers: init.headers, rejectUnauthorized: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", fail);
    req.end(init.body);
  });
}

let child: ChildProcess | null = null;
const stores: string[] = [];

afterAll(async () => {
  // The run is a group: node, pnpm, wrangler, and workerd. Stop all of them.
  if (child?.pid !== undefined && child.exitCode === null) {
    const exited = new Promise((done) => child?.on("exit", done));
    process.kill(-child.pid, "SIGTERM");
    await exited;
  }
  for (const store of stores.splice(0)) rmSync(store, { recursive: true, force: true });
});

describe("the local demo", () => {
  it("names one port in the listen address and in DEMO_ORIGIN", () => {
    expect(devArgs(8787)).toEqual([
      "dev",
      "--port",
      "8787",
      "--local-protocol",
      "https",
      "--var",
      "DEMO_ORIGIN:https://localhost:8787",
    ]);
    expect(devPort({})).toBe(8787);
    expect(devPort({ DEMO_PORT: "51234" })).toBe(51234);
    expect(() => devPort({ DEMO_PORT: "x" })).toThrow(/port number/);
    const scripts = JSON.parse(readFileSync(resolve(PKG, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    expect(scripts.dev?.endsWith("&& node scripts/dev.mjs")).toBe(true);
  });

  it("answers a magic-link request from the page origin, and mails a link of that origin", async () => {
    const port = await freePort();
    const origin = `https://localhost:${port}`;
    // A new store each run. wrangler dev keeps the gate rows in .wrangler/state,
    // so a sixth run within one hour from 127.0.0.1 gets 429 sandboxesPerIp.
    const store = mkdtempSync(join(tmpdir(), "authtempo-demo-dev-"));
    stores.push(store);
    child = spawn("node", ["scripts/dev.mjs", "--persist-to", store], {
      cwd: PKG,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, DEMO_PORT: String(port) },
    });
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) {
      ready = await send(`${origin}/assets/demo.css`).then(
        (a) => a.status === 200,
        () => false,
      );
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    expect({ ready }).toEqual({ ready: true });

    const first = await send(`${origin}/magic-link`);
    expect(first.status).toBe(303);
    const cookie = String(first.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^__Host-demo_sandbox=[0-9a-f]{32}$/);

    // As the page script sends it: the browser sets Origin to the page origin.
    const asked = await send(`${origin}/auth/magic-link/request`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "pat@example.com" }),
    });
    expect({ status: asked.status, body: asked.body }).toEqual({ status: 200, body: asked.body });

    const box = await send(`${origin}/mailbox`, {
      headers: { cookie, accept: "application/json" },
    });
    const mail = (JSON.parse(box.body) as { mail: { text: string }[] }).mail;
    expect(mail[0]?.text).toContain(`${origin}/auth/magic-link/verify?token=`);

    const social = await send(`${origin}/auth/social/demo/start`, { headers: { cookie } });
    expect(social.status).toBe(302);
    expect(String(social.headers.location)).toMatch(new RegExp(`^${origin}/provider/authorize\\?`));
  }, 120_000);
});
