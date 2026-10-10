import { env } from "cloudflare:test";
import { statementsOf } from "./sql.js";

/** Runs a SQL text on the test D1 database in one batch. D1 applies a batch as one unit. */
export async function execD1(text: string): Promise<void> {
  await env.DB.batch(statementsOf(text).map((s) => env.DB.prepare(s)));
}

export async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
}
