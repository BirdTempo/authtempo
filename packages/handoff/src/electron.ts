// Shapes checked against the electron docs (app open-url, shell.openExternal, safeStorage) on 2026-10-09 (electron 44.7.0).
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
  timeoutMs?: number;
}): ElectronOpener {
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  let pending: { redirect: string; resolve: (url: string | null) => void } | null = null;
  const settle = (url: string | null) => {
    const p = pending;
    pending = null;
    p?.resolve(url);
  };
  const receive = (url: string) => {
    if (!pending) return;
    if (!parseReturnedUrl(pending.redirect, url).ok) return;
    settle(url);
  };
  const listener: OpenUrlListener = (_event, url) => receive(url);
  return {
    receive,
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
        void input.shell.openExternal(url);
      });
    },
  };
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Uint8Array;
  decryptString(encrypted: Uint8Array): string;
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
        await input.remove();
        return null;
      }
    },
    async set(token) {
      if (!input.safeStorage.isEncryptionAvailable())
        throw new TokenStoreError("encryption_unavailable");
      await input.write(input.safeStorage.encryptString(token));
    },
    clear: () => input.remove(),
  };
}
