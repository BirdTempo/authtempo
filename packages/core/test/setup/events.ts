import { vi } from "vitest";

/**
 * The one node:fs call of the event recorder. Core's typecheck has no Node
 * types, because core runs on Workers; vitest runs in Node. A specifier in
 * a constant keeps the import out of the typecheck (as answers.ts does).
 */
interface AppendFs {
  appendFileSync(file: URL, text: string): void;
}
const FS_MODULE = "node:fs";
const { appendFileSync }: AppendFs = await import(/* @vite-ignore */ FS_MODULE);

type Observer = import("../../src/observe/observer.js").Observer;
type RequestScope = import("../../src/observe/observer.js").RequestScope;
type ResolvedObserve = import("../../src/observe/config.js").ResolvedObserve;
type AuthEvent = import("../../src/observe/port.js").AuthEvent;
type Include = ResolvedObserve["include"];

// One pair of files per worker process: vitest sets VITEST_WORKER_ID in each one.
const node = (globalThis as { process?: { pid: number; env: Record<string, string | undefined> } })
  .process;
const ID = `${node?.pid ?? 0}-${node?.env.VITEST_WORKER_ID ?? "0"}`;
const DIR = new URL("../../.events/", import.meta.url);
const EVENTS_FILE = new URL(`${ID}.jsonl`, DIR);
const CREDENTIALS_FILE = new URL(`credentials-${ID}.jsonl`, DIR);

/** What a line of the credentials file holds. The check run reads it and never prints a value. */
type Kind = "secret" | "credential" | "address";

function remember(kind: Kind, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) return;
  appendFileSync(CREDENTIALS_FILE, `${JSON.stringify({ kind, value })}\n`);
}

// The hook of `recordCredential` and `recordAddress` in test/helpers.ts.
(globalThis as { __authtempoRecord?: (kind: Kind, value: string) => void }).__authtempoRecord =
  remember;

/** The include of a config with no `observe` (spec 31 item 8). */
const DEFAULT_INCLUDE: Include = { ip: "none", userAgent: "none", email: "none" };

/**
 * The event recorder of plan 12h Task 12. It wraps the two observers that
 * `resolveConfig` makes, in every test file of core. A test file that mocks
 * the observer itself replaces this mock: observer.test.ts and
 * no-await-flush.test.ts write no record. The observer of the product stays
 * as it is. Its `emit`, `scope`, `unscoped`, and `flush` run unchanged, so
 * the default output and the sinks get the same events.
 *
 * Beside it, each emit goes to a second real `createObserver` with the same
 * scope chain. That observer has the include, the hash secret, and the
 * scrub list of the config. It flushes at each emit to a sink that writes
 * one line per event in `.events/<pid>-<worker>.jsonl`. So no event waits
 * for a flush of the test. A record is the event that a sink of that config
 * gets. It holds the stamp, the scope, the fields after the kinds, the
 * `rejected` list, the `unscoped` mark, and the hashes. A config with no
 * `observe` gets the default include. Only the observer of the product
 * drops an event, so the recorder reads the `observe.dropped` events from
 * the sink of the product. The check run (`vitest.events.config.ts`) reads
 * the lines.
 */
vi.mock("../../src/observe/observer.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/observe/observer.js")>();
  type Deps = Parameters<typeof m.createObserver>[1];

  /** One line for each event of a batch, with the include of the config. */
  const append = (include: Include, batch: readonly AuthEvent[]) => {
    for (const event of batch)
      appendFileSync(EVENTS_FILE, `${JSON.stringify({ include, event })}\n`);
  };

  /** The second observer. Its buffer never fills, because each emit flushes it. */
  function recorder(include: Include, deps: Omit<Deps, "clock">): Observer {
    const config: ResolvedObserve = {
      sink: { write: (batch: readonly AuthEvent[]) => append(include, batch) },
      include,
      trustTraceparent: false,
      buffer: 10_000,
      flushTimeoutMs: 10_000,
      readiness: false,
    };
    // The real clock: a fake clock of a test sees no extra read.
    return m.createObserver(config, { ...deps, clock: { now: () => new Date() } });
  }

  /** The observer of the product, and the second observer with the same scope. */
  function tap(real: Observer, record: Observer): Observer {
    return {
      emit(input) {
        real.emit(input);
        record.emit(input);
        void record.flush();
      },
      scope(scope: RequestScope) {
        // The addresses of each request of the suite, from the scope that the router builds.
        remember("address", scope.ip);
        remember("address", scope.userAgent);
        return tap(real.scope(scope), record.scope(scope));
      },
      unscoped: () => tap(real.unscoped(), record.unscoped()),
      flush: () => real.flush(),
      stats: () => real.stats(),
    };
  }

  return {
    ...m,
    createObserver: (...a: Parameters<typeof m.createObserver>) => {
      const [config, deps] = a;
      const { sink } = config;
      // The sink of the product, with a tee of the drop reports. The sink sees the same batch.
      const teed: ResolvedObserve = {
        ...config,
        sink: {
          write(batch: readonly AuthEvent[]) {
            append(
              config.include,
              batch.filter((event) => event.name === "observe.dropped"),
            );
            return sink.write(batch);
          },
        },
      };
      return tap(m.createObserver(teed, deps), recorder(config.include, deps));
    },
    createDefaultObserver: (...a: Parameters<typeof m.createDefaultObserver>) => {
      const hashSecret = () => {
        throw new Error("the default include hashes nothing");
      };
      return tap(
        m.createDefaultObserver(...a),
        recorder(DEFAULT_INCLUDE, { hashSecret, secrets: a[0].secrets }),
      );
    },
  };
});

/**
 * The credentials that core mints in the suite: each `randomToken` and each
 * `randomDigits` value joins the deny list (ruling 29 of plan 12h). So each
 * session token, `tk_` token, `to_` token, and email code is on it. A helper
 * of a test need not read the value. A client id (`cl_`) is public, so it
 * stays off the list. A test file that mocks this module itself replaces
 * this mock: its mints are not recorded. Seven test files do that:
 * email-change-decoy, email-change, email-otp-compare, oauth-client-secret,
 * operator-guards, password-hash, and totp-primitives (each `.test.ts`).
 */
vi.mock("../../src/primitives/crypto.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/primitives/crypto.js")>();
  // CLIENT_ID_PREFIX of oauth-clients.ts. An import of that module here would load the
  // engine before a test file sets its own mocks.
  const CLIENT_ID_PREFIX = "cl_";
  return {
    ...m,
    randomToken: (prefix: string) => {
      const token = m.randomToken(prefix);
      if (prefix !== CLIENT_ID_PREFIX) remember("credential", token);
      return token;
    },
    randomDigits: (length: number) => {
      const code = m.randomDigits(length);
      remember("credential", code);
      return code;
    },
  };
});

/**
 * The secrets of each config of the suite: the scrub list of the config,
 * which holds each source (spec 31 item 9). They join the deny list of the
 * check run.
 */
vi.mock("../../src/config.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/config.js")>();
  return {
    ...m,
    resolveConfig: (input: Parameters<typeof m.resolveConfig>[0]) => {
      const config = m.resolveConfig(input);
      for (const value of m.secretValues(config.keyring, input.social)) remember("secret", value);
      return config;
    },
  };
});
