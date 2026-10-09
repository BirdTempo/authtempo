// Shapes checked against the electron docs on 2026-10-09 (electron 44.7.0): app open-url (with event.preventDefault),
// app second-instance, app.requestSingleInstanceLock, shell.openExternal, and safeStorage (isEncryptionAvailable, getSelectedStorageBackend).
import type { HandoffOpener } from "./handoff.js";
import { parseReturnedUrl } from "./redirect.js";

export interface ElectronShellLike {
  openExternal(url: string): Promise<void>;
}

type OpenUrlListener = (event: unknown, url: string) => void;

export interface ElectronAppLike {
  on(event: "open-url", listener: OpenUrlListener): unknown;
  removeListener(event: "open-url", listener: OpenUrlListener): unknown;
}

export interface ElectronOpener extends HandoffOpener {
  /**
   * Windows and Linux deliver the URL as a command line argument of a second
   * instance. Forward it from the `second-instance` handler:
   * `opener.receive(argv.find((a) => a.startsWith("consumera://")) ?? "")`.
   * The app must hold `app.requestSingleInstanceLock()`. Without the lock,
   * Windows and Linux start a second full app, `second-instance` never fires,
   * and the sign-in waits until the timeout.
   */
  receive(url: string): void;
}

/**
 * Opens the start URL in the default browser and waits for the app's own
 * scheme to come back. macOS delivers it as an `open-url` event; the other
 * platforms through `receive`. One handoff waits at a time: a second `open`
 * resolves the first with null. A URL that arrives while nothing waits, or
 * that is not on the redirect, is dropped.
 */
export function electronOpener(input: {
  shell: ElectronShellLike;
  app: ElectronAppLike;
  /** Default ten minutes, the start row's shortest life on the API. */
  timeoutMs?: number | undefined;
}): ElectronOpener {
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  let pending: { redirect: string; resolve: (url: string | null) => void } | null = null;
  const settle = (url: string | null) => {
    const p = pending;
    pending = null;
    p?.resolve(url);
  };
  /** True when the URL ended the wait. */
  const accept = (url: string): boolean => {
    if (!pending) return false;
    if (!parseReturnedUrl(pending.redirect, url).ok) return false;
    settle(url);
    return true;
  };
  const listener: OpenUrlListener = (event, url) => {
    // The Electron docs ask the handler to call preventDefault when the app handles the URL. A dropped URL stays unhandled.
    if (accept(url)) (event as { preventDefault?: () => void } | null)?.preventDefault?.();
  };
  return {
    receive: (url) => void accept(url),
    open(url, redirect) {
      settle(null);
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          if (pending?.resolve === wrapped) settle(null);
        }, timeoutMs);
        const wrapped = (result: string | null) => {
          clearTimeout(timer);
          input.app.removeListener("open-url", listener);
          resolve(result);
        };
        pending = { redirect, resolve: wrapped };
        input.app.on("open-url", listener);
        // The person sees no browser, so waiting out the timeout is wrong. Settle now.
        input.shell.openExternal(url).catch(() => {
          if (pending?.resolve === wrapped) settle(null);
        });
      });
    },
  };
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Uint8Array;
  decryptString(encrypted: Uint8Array): string;
  /** Linux only. The other platforms have no such function. */
  getSelectedStorageBackend?(): string;
}

export class TokenStoreError extends Error {
  code: "encryption_unavailable";
  constructor(code: "encryption_unavailable") {
    super(
      code === "encryption_unavailable"
        ? "safeStorage has no encryption on this machine; the token was not stored"
        : code,
    );
    this.name = "TokenStoreError";
    this.code = code;
  }
}

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The bearer token at rest, encrypted by the OS keychain through
 * `safeStorage`. It stays in the main process; a renderer asks the main
 * process to make requests, it never holds the token. With no encryption
 * available the store refuses to write: a plaintext token on disk is worse
 * than a sign-in prompt.
 */
export function createTokenStore(input: {
  safeStorage: SafeStorageLike;
  /** Reads the bytes `write` last stored, or null. Node's fs returns a Buffer, which `decryptString` accepts. */
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}): TokenStore {
  return {
    async get() {
      const bytes = await input.read();
      if (!bytes) return null;
      try {
        return input.safeStorage.decryptString(bytes);
      } catch {
        // The keychain entry changed, or the file is damaged. Drop it; the person signs in again.
        // The contract is that unreadable bytes never throw, even when the remove fails.
        await input.remove().catch(() => {});
        return null;
      }
    },
    async set(token) {
      if (!input.safeStorage.isEncryptionAvailable())
        throw new TokenStoreError("encryption_unavailable");
      // On Linux with no secret store, Electron selects `basic_text`. That backend uses a fixed, public password, so the file is plaintext in effect.
      // The promise that the store never writes a plaintext token must not rest on what isEncryptionAvailable answers in that state, which depends on the Electron version.
      // Checked against the Electron 44.7.0 docs on 2026-10-09.
      const backend = input.safeStorage.getSelectedStorageBackend?.();
      if (backend === "basic_text" || backend === "unknown")
        throw new TokenStoreError("encryption_unavailable");
      await input.write(input.safeStorage.encryptString(token));
    },
    clear: () => input.remove(),
  };
}
