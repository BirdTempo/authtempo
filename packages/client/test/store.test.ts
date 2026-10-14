import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "../src/store.js";

type Answer = { data: string | null; error: string | null };

/** A read that waits until the test answers it, and counts each call. */
function controlled() {
  const pending: ((a: Answer) => void)[] = [];
  let reads = 0;
  const read = () =>
    new Promise<Answer>((resolve) => {
      reads++;
      pending.push(resolve);
    });
  const answer = (a: Answer) => {
    const next = pending.shift();
    if (!next) throw new Error("no read is waiting");
    next(a);
  };
  return { read, answer, reads: () => reads, waiting: () => pending.length };
}

describe("createSessionStore (plan 11d, moved from the compatibility package)", () => {
  it("is pending before the first read, reads once at the first subscriber, and keeps one snapshot", async () => {
    const c = controlled();
    const store = createSessionStore<string, string>({ read: c.read, onThrow: () => "threw" });
    expect(store.get()).toEqual({ data: null, error: null, isPending: true, isRefetching: false });
    expect(c.reads()).toBe(0);
    const stop1 = store.subscribe(() => {});
    const stop2 = store.subscribe(() => {});
    expect(c.reads()).toBe(1);
    c.answer({ data: "ada", error: null });
    await vi.waitFor(() => expect(store.get().isPending).toBe(false));
    const snapshot = store.get();
    expect(snapshot).toEqual({ data: "ada", error: null, isPending: false, isRefetching: false });
    expect(store.get()).toBe(snapshot);
    stop1();
    stop2();
  });

  it("drops a read that a newer change made stale, and reads once more", async () => {
    const c = controlled();
    const store = createSessionStore<string, string>({ read: c.read, onThrow: () => "threw" });
    const stop = store.subscribe(() => {});
    // A change (a sign-out) asks for a read while the first one runs.
    void store.refetch();
    c.answer({ data: "stale", error: null });
    await vi.waitFor(() => expect(c.waiting()).toBe(1));
    c.answer({ data: null, error: null });
    await vi.waitFor(() => expect(store.get().isPending).toBe(false));
    expect(store.get().data).toBeNull();
    expect(c.reads()).toBe(2);
    stop();
  });

  it("starts no read from inside a notify, so a listener that refetches on each change ends (N-R7)", async () => {
    let reads = 0;
    const store = createSessionStore<string, string>({
      read: async () => {
        reads++;
        // One timer tick per read: a read loop with no end then still lets the test's timer run.
        await new Promise((r) => setTimeout(r, 0));
        return { data: "ada", error: null };
      },
      onThrow: () => "threw",
    });
    const stop = store.subscribe(() => void store.refetch());
    await vi.waitFor(() => expect(store.get().isPending).toBe(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(1);
    stop();
  });

  it("shows the error of a read that threw, and stops waiting", async () => {
    const store = createSessionStore<string, string>({
      read: async () => {
        throw new Error("boom");
      },
      onThrow: (e) => `threw: ${(e as Error).message}`,
    });
    const stop = store.subscribe(() => {});
    await vi.waitFor(() => expect(store.get().isPending).toBe(false));
    expect(store.get()).toEqual({
      data: null,
      error: "threw: boom",
      isPending: false,
      isRefetching: false,
    });
    stop();
  });

  it("does nothing on refetchIfStarted before the first subscriber, and shows isRefetching after", async () => {
    const c = controlled();
    const store = createSessionStore<string, string>({ read: c.read, onThrow: () => "threw" });
    store.refetchIfStarted();
    expect(c.reads()).toBe(0);
    const states: boolean[] = [];
    const stop = store.subscribe(() => states.push(store.get().isRefetching));
    c.answer({ data: "ada", error: null });
    await vi.waitFor(() => expect(store.get().isPending).toBe(false));
    store.refetchIfStarted();
    expect(c.reads()).toBe(2);
    c.answer({ data: "ada", error: null });
    await vi.waitFor(() => expect(store.get().isRefetching).toBe(false));
    expect(states).toEqual([false, true, false]);
    stop();
  });
});
