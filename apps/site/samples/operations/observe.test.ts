import { afterEach, describe, expect, it, vi } from "vitest";
import { harness, SECRET, signIn } from "../support/harness.ts";
import { authWithAnalytics } from "./observe-analytics-engine.ts";
import { startFlush } from "./observe-node-flush.ts";
import { authWithCollector } from "./observe-otlp.ts";
import tail, { errorEvents } from "./tail-worker.ts";

type Point = { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] };

/** A fetch that keeps the path and the body of each post, and answers 200. */
function collector() {
  const posts: { path: string; body: string }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ path: new URL(String(input)).pathname, body: String(init?.body ?? "") });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { posts, fetcher };
}

const COLLECTOR_ENV = {
  OTLP_ENDPOINT: "https://otlp.example.com",
  OTLP_TOKEN: "collector-token-0123456789",
  AUTH_SECRET: SECRET,
};

// The two Auth builders take the env of the host first. Their names do not
// start with create, because constructs.test.ts calls each create…Auth with the
// harness alone. The tests below construct both with real values.
describe("the observability samples", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("writes a data point for the sign-in, with the event name as the index and no secret", async () => {
    const points: Point[] = [];
    const h = harness();
    const auth = authWithAnalytics(
      { AUTH_EVENTS: { writeDataPoint: (p) => void points.push(p) }, AUTH_SECRET: SECRET },
      h,
    );
    await signIn(auth, h, "ada@example.com");
    await auth.observe.flush();
    const signIns = points.filter((p) => p.indexes?.[0] === "sign_in");
    expect(signIns.map((p) => [p.blobs?.[2], p.blobs?.[4]])).toEqual([["success", "magic_link"]]);
    expect(points.some((p) => p.indexes?.[0] === "request")).toBe(true);
    expect(JSON.stringify(points)).not.toContain(SECRET);
  });

  it("posts the logs, the traces, and the metrics once for each flush, with no secret in a body", async () => {
    const { posts, fetcher } = collector();
    const h = harness();
    const auth = authWithCollector(COLLECTOR_ENV, { ...h, fetch: fetcher });
    await signIn(auth, h, "ada@example.com");
    await auth.observe.flush();
    expect(posts.map((p) => p.path).sort()).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"]);
    for (const p of posts) {
      expect(p.body).not.toContain(SECRET);
      expect(p.body).not.toContain(COLLECTOR_ENV.OTLP_TOKEN);
    }
  });

  it("flushes on a timer, and sends the last batch at the stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { posts, fetcher } = collector();
    const h = harness();
    const auth = authWithCollector(COLLECTOR_ENV, { ...h, fetch: fetcher });
    const stop = startFlush(auth, 5000);
    await signIn(auth, h, "ada@example.com");
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts.filter((p) => p.path === "/v1/logs")).toHaveLength(1);
    await signIn(auth, h, "bob@example.com");
    await stop();
    expect(posts.filter((p) => p.path === "/v1/logs")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(posts.filter((p) => p.path === "/v1/logs")).toHaveLength(2);
  });

  it("posts only the error events of the tailed logs", async () => {
    const error = { name: "error.internal", level: "error" };
    const items = [
      { logs: [{ message: [{ name: "request", level: "info" }] }, { message: [error] }] },
      { logs: [{ message: ["a text line"] }, { message: [null] }] },
    ];
    expect(errorEvents(items)).toEqual([error]);
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response(null, { status: 204 });
    });
    await tail.tail(items, { ALERT_URL: "https://alerts.example.com/hook" });
    await tail.tail([{ logs: [{ message: [{ level: "info" }] }] }], {
      ALERT_URL: "https://alerts.example.com/hook",
    });
    expect(posted).toEqual([JSON.stringify([error])]);
  });
});
