import { createExecutionContext, env } from "cloudflare:test";
import type { MailMessage } from "@authtempo/core";
import { expect, it } from "vitest";
import worker, { createWorker } from "../src/index";

const BASE = "https://example.test";
const json = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("signs a person in by magic link on D1 and reads /me with the session cookie", async () => {
  const sent: MailMessage[] = [];
  const app = createWorker({
    async send(m) {
      sent.push(m);
    },
  });

  const ask = await app.fetch(
    json("/auth/magic-link/request", { email: "ada@example.com" }),
    env,
    createExecutionContext(),
  );
  expect(await ask.json()).toEqual({ sent: true });
  const link = /https:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
  const token = new URL(link).searchParams.get("token") ?? "";

  const verify = await app.fetch(
    json("/auth/magic-link/verify", { token }),
    env,
    createExecutionContext(),
  );
  expect(verify.status).toBe(200);
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);

  const me = await app.fetch(
    new Request(`${BASE}/me`, { headers: { cookie } }),
    env,
    createExecutionContext(),
  );
  expect(await me.json()).toEqual({ email: "ada@example.com" });
});

it("answers 500 to a sign-in request until the app has a mail transport", async () => {
  const res = await worker.fetch(
    json("/auth/magic-link/request", { email: "ada@example.com" }),
    env,
    createExecutionContext(),
  );
  expect(res.status).toBe(500);
});
