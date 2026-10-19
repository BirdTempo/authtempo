import { DurableObject } from "cloudflare:workers";
import { MIGRATIONS } from "./migrations.gen.js";

/** The life of a sandbox: its alarm deletes the store 60 minutes after create() (decision 1). */
export const SANDBOX_LIFE_MS = 3_600_000;

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
  /** Makes the store: the shipped migrations, then the meta rows, then the alarm. */
  async create(): Promise<{ resetAt: number }> {
    if (this.isLive()) throw new Error("demo: the sandbox exists");
    const sql = this.ctx.storage.sql;
    // One exec runs each file of several statements; no file holds ";" in a string (Task 8 Step 1).
    for (const m of MIGRATIONS) this.ctx.storage.transactionSync(() => sql.exec(m.sql));
    const createdAt = Date.now();
    const resetAt = createdAt + SANDBOX_LIFE_MS;
    this.ctx.storage.transactionSync(() => {
      sql.exec(META_DDL);
      const put = "INSERT INTO demo_meta (key, value) VALUES (?, ?)";
      sql.exec(put, "created_at", String(createdAt));
      sql.exec(put, "reset_at", String(resetAt));
      sql.exec(put, "secret", randomSecret());
    });
    await this.ctx.storage.setAlarm(resetAt);
    return { resetAt };
  }

  /** True when create() ran on this store. It reads only, so an unknown id stays empty. */
  async exists(): Promise<boolean> {
    return this.isLive();
  }

  /** Answers one request of a live sandbox. No path here makes a sandbox. */
  async handle(_request: Request): Promise<Response> {
    if (!this.isLive()) return json(404, { error: "no_sandbox" });
    return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  /** Deletes the store at once. deleteAll() also deletes the alarm (deviation 10). */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /** The reset: the alarm at reset_at deletes the whole store. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
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
