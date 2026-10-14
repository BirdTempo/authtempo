// The server of a deploy. Set DATABASE_URL, AUTH_SECRET, BASE_URL, HOST, and
// PORT, then run it with Node (`node src/main.ts`) or Bun (`bun src/main.ts`).
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import postgres from "postgres";
import { createApp, mail, type Serve } from "./app.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`main: set ${name}`);
    process.exit(2);
  }
  return value;
}

const baseURL = required("BASE_URL");
const sql = postgres(required("DATABASE_URL"), { max: 10 });
// Once per process start. The migrations are safe to run from two processes at once.
await applyPostgresMigrations(sql);
const app = createApp({ baseURL, secret: required("AUTH_SECRET"), sql, mail });
const serve: Serve =
  "Bun" in globalThis
    ? (await import("./server-bun.ts")).serveBun
    : (await import("./server-node.ts")).serveNode;
await serve(app.fetch, {
  port: Number(process.env.PORT ?? "3000"),
  hostname: process.env.HOST ?? "127.0.0.1",
  origin: baseURL,
});
console.log(`main: listening for ${baseURL}`);
