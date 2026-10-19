import { DurableObject } from "cloudflare:workers";

/** The gate keeps an IP for one hour at most (the demo stores no IP past one hour). */
const KEEP_MS = 3_600_000;

/**
 * The one gate of new sandboxes, at idFromName("gate"). It counts each new
 * sandbox per IP. Task 11 adds the limits; in this task it admits each call.
 * Its alarm deletes each IP one hour after its visit (ruling 32).
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
    // With no new visitor, no admit runs, so the alarm deletes each row at one hour.
    if ((await this.ctx.storage.getAlarm()) === null) await this.alarmAtOldest();
    return { ok: true };
  }

  /** Deletes each row of one hour or more, then sets the alarm for the next oldest row. */
  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM admit WHERE at <= ?", Date.now() - KEEP_MS);
    await this.alarmAtOldest();
  }

  /** The alarm at the oldest row plus one hour, or no alarm when the table is empty. */
  private async alarmAtOldest(): Promise<void> {
    const oldest = this.ctx.storage.sql.exec("SELECT min(at) AS m FROM admit").one().m;
    if (typeof oldest === "number") await this.ctx.storage.setAlarm(oldest + KEEP_MS);
  }
}
