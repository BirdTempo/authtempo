// The one source of the test server ports (design
// docs/superpowers/specs/2026-10-22-test-servers-per-worktree-design.md).
// No other file in packages, examples, apps, or scripts may hold a test port:
// apps/site/test/test-ports.test.ts scans for one.
//
// Each worktree that runs tests has its own slot, so a sweep, a drop, or a
// reset in one worktree cannot reach the servers of another. A port is
// BASE + slot * STRIDE + the offset of its service. Slot 0 is the main
// worktree: it keeps the ports of the set that docker-compose.yml runs.

/** The first port of slot 0 by the formula. Slot 0 uses its own row, so ports 20000 to 20009 stay unused. */
export const BASE = 20000;
/** Ten ports a slot. Six services use offsets 0 to 5; offsets 6 to 9 are free for later servers. */
export const STRIDE = 10;
/** The last slot: its ports end at 20999, below the ephemeral range of macOS (49152) and Linux (32768). */
export const MAX_SLOT = 99;

/**
 * The test servers in the order of docker-compose.yml. `name` is the compose
 * service, `envVar` the variable that the test helpers read, and `url` the
 * address of the server on its port.
 * @type {readonly { name: string, offset: number, envVar: string, url: (port: number) => string }[]}
 */
export const SERVICES = [
  {
    name: "postgres",
    offset: 0,
    envVar: "TEMPO_AUTH_PG_URL",
    url: (port) => `postgres://tempo:tempo@localhost:${port}/tempo_auth`,
  },
  {
    name: "libsql",
    offset: 1,
    envVar: "AUTHTEMPO_LIBSQL_URL",
    url: (port) => `http://127.0.0.1:${port}`,
  },
  {
    name: "libsql-cli",
    offset: 2,
    envVar: "AUTHTEMPO_LIBSQL_CLI_URL",
    url: (port) => `http://127.0.0.1:${port}`,
  },
  {
    name: "libsql-cli-compat",
    offset: 3,
    envVar: "AUTHTEMPO_LIBSQL_COMPAT_URL",
    url: (port) => `http://127.0.0.1:${port}`,
  },
  {
    name: "mysql84",
    offset: 4,
    envVar: "AUTHTEMPO_MYSQL84_URL",
    url: (port) => `mysql://root:tempo@127.0.0.1:${port}/`,
  },
  {
    name: "mysql97",
    offset: 5,
    envVar: "AUTHTEMPO_MYSQL97_URL",
    url: (port) => `mysql://root:tempo@127.0.0.1:${port}/`,
  },
];

/**
 * The ports of the set that docker-compose.yml runs for the main worktree.
 * They came before this table, and docs and habits name them, so slot 0 keeps them.
 * @type {Readonly<Record<string, number>>}
 */
export const SLOT_0 = {
  postgres: 5439,
  libsql: 8089,
  "libsql-cli": 8090,
  "libsql-cli-compat": 8091,
  mysql84: 3384,
  mysql97: 3397,
};

/** @param {string} name */
function serviceOf(name) {
  const service = SERVICES.find((s) => s.name === name);
  if (service === undefined) throw new Error(`unknown test service: ${name}`);
  return service;
}

/** @param {number} slot */
function checkSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT)
    throw new Error(`slot ${slot} is outside 0 to ${MAX_SLOT}`);
}

/**
 * The host port of one service in one slot.
 * @param {number} slot
 * @param {string} name
 * @returns {number}
 */
export function portOf(slot, name) {
  checkSlot(slot);
  const service = serviceOf(name);
  if (slot === 0) return /** @type {number} */ (SLOT_0[name]);
  return BASE + slot * STRIDE + service.offset;
}

/**
 * The variables of the named services in one slot.
 * @param {number} slot
 * @param {readonly string[]} names
 * @returns {Record<string, string>}
 */
export function envOf(slot, names) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of names) {
    const service = serviceOf(name);
    env[service.envVar] = service.url(portOf(slot, name));
  }
  return env;
}

/**
 * The text of .test-servers.env: one KEY=VALUE line a variable, sorted.
 * @param {number} slot
 * @param {readonly string[]} names
 * @returns {string}
 */
export function envFileText(slot, names) {
  return Object.entries(envOf(slot, names))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
}
