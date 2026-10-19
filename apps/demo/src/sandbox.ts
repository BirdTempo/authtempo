import { DurableObject } from "cloudflare:workers";
import type { Auth } from "@authtempo/core";
import { demoAuth } from "./auth.js";
import { DEMO_LIMITS } from "./facts.js";
import { checkSandboxLimit, routeOf } from "./limits.js";
import { createMailbox, MAILBOX_DDL, type Mailbox } from "./mailbox.js";
import { MIGRATIONS } from "./migrations.gen.js";
import { DEMO_BODIES } from "./pages/index.js";
import { DEMO_PAGES, page } from "./pages/layout.js";
import { PROVIDER_DDL, providerRoute } from "./provider.js";
import { sqliteD1 } from "./sqlite-d1.js";

const META_DDL = "CREATE TABLE demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

/** 32 random bytes in base64url with no padding: 43 characters. */
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One visitor sandbox: its own SQLite store, secret, and alarm. Only create()
 * writes a new sandbox. The Worker calls it for an id that it made itself, so
 * an id from a cookie never makes a store.
 */
export class Sandbox extends DurableObject<Cloudflare.Env> {
  /** The auth of this sandbox, built once per object instance. */
  private demo: { auth: Auth; db: D1Database; mailbox: Mailbox } | null = null;

  /**
   * Makes the store: the alarm at created_at + sandboxLifeMs, then the
   * shipped migrations, then the demo tables and the meta rows. Use of the
   * sandbox does not move the alarm (decision 1).
   */
  async create(): Promise<{ resetAt: number }> {
    if (this.isLive()) throw new Error("demo: the sandbox exists");
    const sql = this.ctx.storage.sql;
    const createdAt = Date.now();
    const resetAt = createdAt + DEMO_LIMITS.sandboxLifeMs;
    // The alarm comes first. If the object stops part way, the alarm still
    // deletes the part store at the reset time (ruling 32).
    await this.ctx.storage.setAlarm(resetAt);
    // One exec runs each file of several statements; no file holds ";" in a string (Task 8 Step 1).
    for (const m of MIGRATIONS) this.ctx.storage.transactionSync(() => sql.exec(m.sql));
    this.ctx.storage.transactionSync(() => {
      sql.exec(META_DDL);
      sql.exec(MAILBOX_DDL);
      sql.exec(PROVIDER_DDL);
      const put = "INSERT INTO demo_meta (key, value) VALUES (?, ?)";
      sql.exec(put, "created_at", String(createdAt));
      sql.exec(put, "reset_at", String(resetAt));
      sql.exec(put, "secret", randomSecret());
    });
    return { resetAt };
  }

  /** True when create() ran on this store. It reads only, so an unknown id stays empty. */
  async exists(): Promise<boolean> {
    return this.isLive();
  }

  /** Answers one request of a live sandbox. No path here makes a sandbox. */
  async handle(request: Request): Promise<Response> {
    if (!this.isLive()) return json(404, { error: "no_sandbox" });
    const { auth, db, mailbox } = this.open();
    const url = new URL(request.url);
    if (url.pathname.startsWith("/auth/")) {
      // The demo limits come before core, so a refused request changes no row.
      const route = routeOf(request.method, url.pathname);
      const checked =
        route === null ? null : await checkSandboxLimit(this.ctx.storage.sql, route, request);
      if (checked !== null && !checked.ok)
        return json(429, { error: "demo_limit", limit: checked.limit });
      return auth.handle(request);
    }
    if (url.pathname === "/whoami") {
      // As examples/worker: the session cookie, a ts_ bearer, or a tk_ bearer.
      const c = await auth.caller(request);
      if (!c) return json(401, { error: "unauthorized" });
      const res = json(200, { kind: c.kind, id: c.user.id, email: c.user.email });
      // After a sliding refresh, renew the cookie or the browser drops it early.
      const renewed = c.kind === "session" ? auth.sessionCookie(request, c) : null;
      if (renewed) res.headers.set("set-cookie", renewed);
      return res;
    }
    if (url.pathname.startsWith("/provider/")) return providerRoute(request, db);
    const accept = request.headers.get("accept") ?? "";
    if (
      url.pathname === "/mailbox" &&
      request.method === "GET" &&
      accept.includes("application/json")
    )
      return json(200, { mail: mailbox.list() });
    const entry = DEMO_PAGES.find((p) => p.path === url.pathname);
    if (entry === undefined) return json(404, { error: "not_found" });
    // A call form posts to its own page only when no script runs. The page script makes each call.
    if (request.method !== "GET" && request.method !== "HEAD") {
      // RFC 9110 15.5.6: a 405 answer names the methods of the resource in Allow.
      const refused = json(405, { error: "method_not_allowed" });
      refused.headers.set("allow", "GET, HEAD");
      return refused;
    }
    const { body, script } = DEMO_BODIES[entry.path];
    const state = { resetAt: this.resetAt(), mail: mailbox.list(), origin: this.env.DEMO_ORIGIN };
    // RFC 9110 9.3.2: HEAD answers as GET. The runtime sends no body for a
    // HEAD answer, so HEAD takes the GET answer. A probe of 2026-10-20 gave an
    // empty body also for a page answer with a body.
    return page({
      title: entry.title,
      path: entry.path,
      resetAt: state.resetAt,
      body: body(state),
      script,
    });
  }

  /** The reset time that create() wrote, in ms since the epoch. */
  private resetAt(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM demo_meta WHERE key = 'reset_at'")
      .one();
    return Number(row.value);
  }

  /** Deletes the store at once. deleteAll() also deletes the alarm (deviation 10). */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /**
   * The reset: the alarm at reset_at deletes the whole store. deleteAll()
   * also deletes the alarm (deviation 10). The next request with the old
   * cookie finds no sandbox and gets a new one through the gate.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /** The auth, the D1 surface, and the mailbox of this store, made at the first request. */
  private open(): { auth: Auth; db: D1Database; mailbox: Mailbox } {
    if (this.demo) return this.demo;
    const storage = this.ctx.storage;
    const secret = storage.sql
      .exec<{ value: string }>("SELECT value FROM demo_meta WHERE key = 'secret'")
      .one().value;
    const db = sqliteD1(storage.sql, (fn) => storage.transactionSync(fn));
    const mailbox = createMailbox(storage.sql);
    const auth = demoAuth({ origin: this.env.DEMO_ORIGIN, secret, db, mailbox });
    this.demo = { auth, db, mailbox };
    return this.demo;
  }

  private isLive(): boolean {
    const sql = this.ctx.storage.sql;
    const table = sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'demo_meta'")
      .toArray();
    if (table.length === 0) return false;
    return sql.exec("SELECT 1 FROM demo_meta WHERE key = 'created_at'").toArray().length === 1;
  }
}
