import type { ResolvedConfig, ResolvedOAuth } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { randomToken } from "../primitives/crypto.js";
import { hasControlChar } from "../primitives/text.js";
import type { OAuthClientRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { type OAuthResult, oauthFail, oauthOk } from "./oauth-result.js";

/**
 * The OAuth clients (plan 9g, spec 8.13 item 1). Core serves public clients
 * only: no client has a secret, and `token_endpoint_auth_method` is `none`;
 * PKCE binds each code to the client that asked for it. A client is
 * registered (RFC 7591, a `cl_` id) or is the URL of its own metadata
 * document (draft-ietf-oauth-client-id-metadata-document, read 2026-10-13).
 */

export const CLIENT_ID_PREFIX = "cl_";
const CLIENT_ID_RE = /^cl_[A-Za-z0-9_-]{43}$/;
const REGISTER_PER_IP = { seconds: 3600, max: 10 };
export const CIMD_TIMEOUT_MS = 10_000;
export const CIMD_MAX_BYTES = 65_536;
export const CIMD_CACHE_MS = 3_600_000;
/** The documents one isolate keeps. The oldest goes first. */
const CIMD_CACHE_MAX = 500;
const REDIRECT_MAX = 10;
const URI_MAX = 2048;
const NAME_MAX = 80;
/** A busy client must not write its row on every request. */
const LAST_SEEN_EVERY_MS = 86_400_000;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const RESPONSE_TYPES = ["code"];
/** Schemes that run code or read local data in a browser: never a redirect target. */
const BLOCKED_SCHEMES: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
  "filesystem:",
  "ws:",
  "wss:",
  "ftp:",
]);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:$/;
/**
 * The loopback hosts of an http redirect URI. Not `[::1]`: a CSP host-source
 * has no IPv6 literal form, so the consent page cannot name it in
 * `form-action`, and the browser would stop at the allow. A client on the
 * loopback uses 127.0.0.1.
 */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
/** Host suffixes of names that only a local network resolves. A host equal to the name without its dot is refused too. */
const PRIVATE_SUFFIXES: readonly string[] = [".local", ".home.arpa", ".internal"];
/** A parsed IPv4 host. The URL parser writes every IPv4 form (`127.1`, `0x7f.0.0.1`) as four decimal parts. */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface CimdEntry {
  name: string | null;
  redirectUris: string[];
  /** Epoch milliseconds by the config clock. */
  until: number;
}

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}

/**
 * One redirect URI of a public client (RFC 8252 sections 7.1 and 7.3, the
 * OAuth 2.1 draft): https; http on a loopback host with any port; or a
 * private-use scheme. No fragment, no credentials, no control character.
 */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > URI_MAX) return false;
  if (value.includes("#") || hasControlChar(value)) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (u.protocol === "https:") return true;
  // `hostname` is the parsed form, so `127.1` and `0x7f.0.0.1` pass as
  // 127.0.0.1. The list keeps the raw value, and the authorize step matches
  // the raw value exactly, so an odd form is still a loopback URI: harmless.
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return SCHEME_RE.test(u.protocol) && !BLOCKED_SCHEMES.has(u.protocol);
}

/** 1 to 10 valid redirect URIs, each once, or null. */
function redirectList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > REDIRECT_MAX) return null;
  if (!value.every(validRedirectUri)) return null;
  return [...new Set(value as string[])];
}

/** The client's name: null when absent, undefined when it is not 1 to 80 characters with no control character. */
function clientName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > NAME_MAX) return undefined;
  return hasControlChar(value) ? undefined : value;
}

function subsetOf(value: unknown, allowed: readonly string[]): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((x) => typeof x === "string" && allowed.includes(x));
}

/** A dynamic registration (RFC 7591 section 3, read from the RFC as known on 2026-10-13, not re-read). */
export async function registerClient(
  config: ResolvedConfig,
  input: { metadata: Record<string, unknown>; ip: string | null },
): Promise<OAuthResult<RegisteredClient>> {
  if (!config.oauth?.dynamic) return oauthFail("invalid_request");
  if (!(await config.limiter.allow(`oauth-register:ip:${ipKey(input.ip)}`, REGISTER_PER_IP)))
    return oauthFail("rate_limited");
  const m = input.metadata;
  const redirectUris = redirectList(m.redirect_uris);
  if (!redirectUris) return oauthFail("invalid_redirect_uri");
  const name = clientName(m.client_name);
  if (name === undefined) return oauthFail("invalid_client_metadata");
  if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== "none")
    return oauthFail("invalid_client_metadata");
  if (!subsetOf(m.grant_types, GRANT_TYPES) || !subsetOf(m.response_types, RESPONSE_TYPES))
    return oauthFail("invalid_client_metadata");
  const now = config.clock.now();
  const row = await config.storage.create("oauthClient", {
    id: randomToken(CLIENT_ID_PREFIX),
    kind: "registered",
    name,
    redirectUris,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return oauthOk({
    client_id: row.id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(name !== null ? { client_name: name } : {}),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: [...GRANT_TYPES],
    response_types: [...RESPONSE_TYPES],
  });
}

/**
 * A client id that may name a metadata document (the CIMD draft section 3,
 * read 2026-10-13): https, a path other than `/`, no dot segment, no query,
 * no fragment, and no credentials. Core also refuses the hosts that only an
 * internal network reaches. `oauth.fetch` should refuse them too, but no
 * supplier's fetch may be the only guard: on Node or Bun a plain `fetch`
 * reaches internal hosts.
 */
export function validCimdUrl(value: string, baseURL: string): boolean {
  if (value.length > URI_MAX || value.includes("#") || hasControlChar(value)) return false;
  if (/\/\.\.?(\/|$)/.test(value)) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  // The canonical form only. The parser folds `%2e%2e`, `.%2E`, a backslash,
  // a capital in the host, and a default port, so without this one document
  // answers for many client ids.
  if (u.href !== value) return false;
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  if (u.search !== "" || u.pathname === "/") return false;
  // A trailing dot names the same host: `localhost.` is `localhost`.
  const host = u.hostname.replace(/\.$/, "");
  // An IP literal (IPv4 or IPv6, 127.0.0.1 and [::1] too): a public client has a DNS name, and an address may be internal.
  if (host.startsWith("[") || IPV4_RE.test(host)) return false;
  // `localhost` and `*.localhost` resolve to the loopback (RFC 6761 section 6.3).
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  // A single label (no dot) is an intranet name.
  if (!host.includes(".")) return false;
  // The special-use and private names that only a local network resolves:
  // `.local` (RFC 6762 mDNS), `.home.arpa` (RFC 8375), and `.internal`
  // (the ICANN private-use name, 2024).
  if (PRIVATE_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) return false;
  // This instance's own host: a document there would make core fetch itself.
  // The compare is by `hostname`, with no port: a document on another port
  // of this host is refused too, which is stricter than the host and port.
  if (host === new URL(baseURL).hostname) return false;
  return true;
}

/** The body as text, or null past `max` bytes, on a read error, or when `signal` aborts. */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  // A rejection after the read ended has no reader: it must not count as unhandled.
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch {
    return null;
  }
}

/**
 * The fields core reads from a client ID metadata document, or null with
 * one log line that names the reason and never the document. The fetch is
 * the app's guarded fetch; core adds `redirect: "manual"`, a 10-second
 * timeout for the answer and the body, and a 64 KB cap. The document must
 * name its own URL as `client_id` (the draft, section 4, read 2026-10-13).
 */
export async function fetchCimd(
  fetchFn: typeof fetch | null,
  url: string,
): Promise<{ name: string | null; redirectUris: string[] } | null> {
  const refuse = (why: string) => {
    console.error("authtempo: client metadata document refused", why);
    return null;
  };
  if (!fetchFn) return refuse("no fetch");
  const ctrl = new AbortController();
  // setTimeout, not AbortSignal.timeout: a test moves it with fake timers.
  const timer = setTimeout(() => ctrl.abort(), CIMD_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: ctrl.signal,
      });
    } catch {
      return refuse("the fetch failed or timed out");
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return refuse(`status ${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      await res.body?.cancel().catch(() => {});
      return refuse("not application/json");
    }
    const text = await readCapped(res, CIMD_MAX_BYTES, ctrl.signal);
    if (text === null) return refuse("larger than 64 KB, not UTF-8, or not in time");
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return refuse("not JSON");
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
      return refuse("not a JSON object");
    const d = doc as Record<string, unknown>;
    if (d.client_id !== url) return refuse("client_id is not the document URL");
    const redirectUris = redirectList(d.redirect_uris);
    if (!redirectUris) return refuse("redirect_uris");
    const name = clientName(d.client_name);
    if (name === undefined) return refuse("client_name");
    if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none")
      return refuse("token_endpoint_auth_method is not none: core serves public clients only");
    return { name, redirectUris };
  } finally {
    clearTimeout(timer);
  }
}

/** Writes or refreshes the row of a document that this call read. */
async function writeCimdRow(
  config: ResolvedConfig,
  url: string,
  entry: CimdEntry,
  row: OAuthClientRow | null,
  now: Date,
): Promise<OAuthClientRow> {
  const data = {
    kind: "cimd" as const,
    name: entry.name,
    redirectUris: entry.redirectUris,
    lastSeenAt: now,
    updatedAt: now,
  };
  const where = [{ field: "id" as const, op: "eq" as const, value: url }];
  if (row) {
    await config.storage.update("oauthClient", where, data);
    return { ...row, ...data };
  }
  try {
    return await config.storage.create("oauthClient", { id: url, ...data, createdAt: now });
  } catch (e) {
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
    // A parallel request wrote the row first: this document's values win, and
    // the row comes back from storage, with the winner's `createdAt`.
    await config.storage.update("oauthClient", where, data);
    const winner = await config.storage.findOne("oauthClient", where);
    if (!winner) throw e;
    return winner;
  }
}

async function cimdClient(
  config: ResolvedConfig,
  oauth: ResolvedOAuth,
  url: string,
  now: Date,
): Promise<OAuthClientRow | null> {
  const cached = oauth.cimdCache.get(url);
  if (cached && cached.until > now.getTime()) {
    const row = await config.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: url },
    ]);
    // A row that the sweep deleted while the document lives in the cache comes back.
    return row ?? writeCimdRow(config, url, cached, null, now);
  }
  const doc = await fetchCimd(oauth.fetch, url);
  if (!doc) return null;
  const entry: CimdEntry = { ...doc, until: now.getTime() + CIMD_CACHE_MS };
  oauth.cimdCache.delete(url);
  if (oauth.cimdCache.size >= CIMD_CACHE_MAX) {
    const oldest = oauth.cimdCache.keys().next().value;
    if (oldest !== undefined) oauth.cimdCache.delete(oldest);
  }
  oauth.cimdCache.set(url, entry);
  const row = await config.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: url }]);
  return writeCimdRow(config, url, entry, row, now);
}

/**
 * The client of `clientId`, or null: a registered `cl_` client, or a CIMD
 * client whose document this call or this isolate's cache read. A failed
 * fetch answers null: the document is the source of the client's data.
 */
export async function findClient(
  config: ResolvedConfig,
  clientId: string,
): Promise<OAuthClientRow | null> {
  const oauth = config.oauth;
  if (!oauth) return null;
  const now = config.clock.now();
  if (CLIENT_ID_RE.test(clientId)) {
    const row = await config.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: clientId },
      { field: "kind", op: "eq", value: "registered" },
    ]);
    if (row && now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS) {
      await config.storage.update("oauthClient", [{ field: "id", op: "eq", value: row.id }], {
        lastSeenAt: now,
        updatedAt: now,
      });
      return { ...row, lastSeenAt: now, updatedAt: now };
    }
    return row;
  }
  if (!oauth.cimd || !validCimdUrl(clientId, config.baseURL)) return null;
  return cimdClient(config, oauth, clientId, now);
}
