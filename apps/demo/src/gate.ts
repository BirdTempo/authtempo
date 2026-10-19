import { DurableObject } from "cloudflare:workers";

/** The gate keeps an IP for one hour at most (the demo stores no IP past one hour). */
const KEEP_MS = 3_600_000;

/**
 * The one gate of new sandboxes, at idFromName("gate"). It counts each new
 * sandbox per IP. Task 11 adds the limits; in this task it admits each call.
 */
export class Gate extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS admit (ip TEXT NOT NULL, at INTEGER NOT NULL)",
    );
  }

  async admit(ip: string, now: number): Promise<{ ok: true } | { ok: false; limit: string }> {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM admit WHERE at <= ?", now - KEEP_MS);
    sql.exec("INSERT INTO admit (ip, at) VALUES (?, ?)", ip, now);
    return { ok: true };
  }
}
