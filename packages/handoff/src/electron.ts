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

export interface TokenCipher {
  available(): boolean | Promise<boolean>;
  encrypt(plain: string): Promise<Uint8Array>;
  /** `reEncrypt` is true when the platform asks the app to store the token again. */
  decrypt(bytes: Uint8Array): Promise<{ plain: string; reEncrypt: boolean }>;
}

/**
 * On Linux with no secret store, Electron selects `basic_text`. That backend uses a fixed, public password, so the file is plaintext in effect.
 * The promise that the store never writes a plaintext token must not rest on what the availability call answers in that state, which depends on the Electron version.
 * Checked against the Electron 44.7.0 docs on 2026-10-09.
 */
function isWeakBackend(backend: string | undefined): boolean {
  return backend === "basic_text" || backend === "unknown";
}

/** Wraps the sync `safeStorage` API. Use `asyncSafeStorageCipher` in a new app. */
export function safeStorageCipher(safeStorage: SafeStorageLike): TokenCipher {
  return {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      !isWeakBackend(safeStorage.getSelectedStorageBackend?.()),
    encrypt: async (plain) => safeStorage.encryptString(plain),
    decrypt: async (bytes) => ({ plain: safeStorage.decryptString(bytes), reEncrypt: false }),
  };
}

/** The async `safeStorage` functions. Electron 44 adds them; Electron 45 deprecates the sync ones. */
export interface AsyncSafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plain: string): Promise<Uint8Array>;
  decryptStringAsync(bytes: Uint8Array): Promise<{ result: string; shouldReEncrypt: boolean }>;
  /** Linux only. The other platforms have no such function. */
  getSelectedStorageBackend?(): string;
}

/** Wraps the async `safeStorage` API, and asks the store to write again when Electron says so. */
export function asyncSafeStorageCipher(safeStorage: AsyncSafeStorageLike): TokenCipher {
  return {
    available: async () =>
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      !isWeakBackend(safeStorage.getSelectedStorageBackend?.()),
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: async (bytes) => {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(bytes);
      return { plain: result, reEncrypt: shouldReEncrypt };
    },
  };
}

/**
 * The bearer token at rest, encrypted by the OS keychain through a
 * `TokenCipher`. It stays in the main process; a renderer asks the main
 * process to make requests, it never holds the token. With no encryption
 * available the store refuses to write: a plaintext token on disk is worse
 * than a sign-in prompt.
 */
export function createTokenStore(input: {
  cipher: TokenCipher;
  /** Reads the bytes `write` last stored, or null. Node's fs returns a Buffer, which is a Uint8Array. */
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}): TokenStore {
  return {
    async get() {
      const bytes = await input.read();
      if (!bytes) return null;
      let decrypted: { plain: string; reEncrypt: boolean };
      try {
        decrypted = await input.cipher.decrypt(bytes);
      } catch {
        // The keychain entry changed, or the file is damaged. Drop it; the person signs in again.
        // The contract is that unreadable bytes never throw, even when the remove fails.
        await input.remove().catch(() => {});
        return null;
      }
      if (decrypted.reEncrypt) {
        // The platform asked for a fresh encryption. A failure here keeps the old bytes, which still decrypt, so the person stays signed in.
        try {
          await input.write(await input.cipher.encrypt(decrypted.plain));
        } catch {}
      }
      return decrypted.plain;
    },
    async set(token) {
      if (!(await input.cipher.available())) throw new TokenStoreError("encryption_unavailable");
      await input.write(await input.cipher.encrypt(token));
    },
    clear: () => input.remove(),
  };
}
