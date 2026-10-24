import { env } from "cloudflare:test";
import { createAuth, createMemoryAdapter } from "@authtempo/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Ruling 29 of plan 12i: workerd stops a promise that no waitUntil holds at
// the answer. A phone code goes out after the answer, so on Workers core
// waits for that work when the host gives handle no waitUntil.

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = "https://app.example.com";

/** Core with phone sign-up on, and an SMS port that reads D1 before it records the text. */
function phoneAuth() {
  const sent: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    phone: {
      sms: {
        async send({ to }) {
          // Real I/O of workerd before the send counts.
          await env.DB.prepare("SELECT 1").first();
          sent.push(to);
          return "sent";
        },
      },
      regions: ["+1"],
      isolateLimiter: "allow",
      signUp: true,
    },
  });
  const ask = (options?: { waitUntil: (p: Promise<unknown>) => void }) =>
    auth.handle(
      new Request(`${BASE}/auth/phone/request`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ phone: "+14155550100" }),
      }),
      options,
    );
  return { sent, ask };
}

describe("the work after the answer on workerd (ruling 29 of plan 12i)", () => {
  it("stops a detached promise at the answer, and keeps one under waitUntil", async () => {
    const id = crypto.randomUUID();
    const modes = ["detached", "waituntil", "detached", "waituntil"];
    for (const [run, mode] of modes.entries())
      await (await env.DETACHED_PROBE.fetch(`http://probe.invalid/${mode}/${id}/${run}`)).text();
    // Time for any I/O that the runtime let run.
    await new Promise((r) => setTimeout(r, 1000));
    const count = await env.DETACHED_PROBE.fetch(`http://probe.invalid/count/${id}`);
    const made = (await count.json()) as Record<string, number>;
    // A detached run can make the step that it started before the answer. It
    // makes no later step: the SMS never goes out. Each run under waitUntil
    // makes all three.
    expect([made["detached/row"], made["detached/sms"]]).toEqual([undefined, undefined]);
    expect([made["waituntil/cap"], made["waituntil/row"], made["waituntil/sms"]]).toEqual([
      2, 2, 2,
    ]);
  });

  it("names the runtime Cloudflare-Workers, the value that handle reads", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("sends the code before the answer when the host passes no waitUntil", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent, ask } = phoneAuth();
    const res = await ask();
    expect(await res.json()).toEqual({ sent: true });
    expect(sent).toEqual(["+14155550100"]);
    expect(warn.mock.calls).toEqual([
      ["authtempo: no waitUntil on Workers; the answer waited for the work after it"],
    ]);
  });

  it("sends the code after the answer under the waitUntil of the host", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent, ask } = phoneAuth();
    const held: Promise<unknown>[] = [];
    const res = await ask({ waitUntil: (p) => void held.push(p) });
    expect(await res.json()).toEqual({ sent: true });
    expect(sent).toEqual([]);
    await Promise.all(held);
    expect(sent).toEqual(["+14155550100"]);
    expect(warn.mock.calls).toEqual([]);
  });
});
