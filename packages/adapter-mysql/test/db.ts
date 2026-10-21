import mysql, { type Pool, type PoolOptions, type RowDataPacket } from "mysql2/promise";
import { migrateSteps } from "../src/migrations.js";

export interface MysqlServer {
  version: "8.4" | "9.7";
  url: string;
}

/** The two servers of docker-compose.yml (owner decision 2 of plan 12g). */
export const MYSQL_SERVERS: readonly MysqlServer[] = [
  {
    version: "8.4",
    url: process.env.AUTHTEMPO_MYSQL84_URL ?? "mysql://root:tempo@127.0.0.1:3384/",
  },
  {
    version: "9.7",
    url: process.env.AUTHTEMPO_MYSQL97_URL ?? "mysql://root:tempo@127.0.0.1:3397/",
  },
];

export const MYSQL_84 = MYSQL_SERVERS[0] as MysqlServer;

/** The server of `url` as mysql2 options, with no database. */
function serverOptions(url: string): PoolOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

/** One connection with no database, for CREATE DATABASE, KILL, and DROP DATABASE. */
async function admin<T>(server: MysqlServer, run: (c: mysql.Connection) => Promise<T>) {
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection(serverOptions(server.url));
  } catch (e) {
    throw new Error(
      `authtempo mysql tests need MySQL ${server.version} at ${server.url}: ${(e as Error).message}. Run: docker compose up -d mysql84 mysql97`,
    );
  }
  try {
    return await run(conn);
  } finally {
    await conn.end();
  }
}

export interface PoolSettings {
  /** Connections in the pool. 4 by default, so a write outside an open transaction has one. */
  connectionLimit?: number;
  /** mysql2 client flags, such as "-FOUND_ROWS". */
  flags?: string[];
  /** A statement that each new connection runs first, such as a session setting. */
  onConnect?: string;
}

/** A pool on `database`. Each session waits 5 s for a row lock, not the server's 50 (ruling 5 of plan 12g). */
export function poolOn(server: MysqlServer, database: string, settings: PoolSettings = {}): Pool {
  const pool = mysql.createPool({
    ...serverOptions(server.url),
    database,
    connectionLimit: settings.connectionLimit ?? 4,
    timezone: "Z",
    ...(settings.flags ? { flags: settings.flags } : {}),
  });
  pool.pool.on("connection", (conn) => {
    conn.query("SET SESSION innodb_lock_wait_timeout = 5");
    if (settings.onConnect) conn.query(settings.onConnect);
  });
  return pool;
}

export interface MysqlDatabase {
  server: MysqlServer;
  name: string;
  pool: Pool;
  /** A pool of its own on the same database, which `close` ends too. */
  pool2(settings?: PoolSettings): Pool;
  /** A raw read or write: `q\`SELECT id FROM ta_user WHERE id = ${id}\``. `id(name)` quotes a name. */
  q: Tag;
  close(): Promise<void>;
}

/** A quoted name inside a `q` statement. */
class Ident {
  constructor(readonly name: string) {}
}

export interface Tag {
  <T extends readonly unknown[] = RowDataPacket[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  (name: string): Ident;
}

/** The `q` tag of `pool`: each value is a parameter of a prepared statement, each Ident a quoted name. */
export function tagOf(pool: Pool): Tag {
  function tag(first: TemplateStringsArray | string, ...values: unknown[]): unknown {
    if (typeof first === "string") return new Ident(first);
    let sql = first[0] ?? "";
    const params: unknown[] = [];
    values.forEach((v, i) => {
      if (v instanceof Ident) sql += `\`${v.name}\``;
      else {
        sql += "?";
        params.push(v);
      }
      sql += first[i + 1] ?? "";
    });
    return pool.execute(sql, params as never[]).then(([rows]) => rows);
  }
  return tag as Tag;
}

/** A test database older than one hour is left by a killed run, so a supply drops it. */
const STALE_AFTER_MS = 60 * 60 * 1000;
/** The name form of `testDatabaseName`: the creation time in ms, then a random part. */
const NAME_RE = /^t_(\d{13})_[0-9a-f]{32}$/;
/** The name form before 2026-10-21 22:30 CST, which holds no time. */
const LEGACY_RE = /^t_[0-9a-f]{32}$/;

/** The name of a new test database, `t_<ms>_<hex>`. A sweep reads its age from the name. */
export function testDatabaseName(now = Date.now()): string {
  return `t_${now}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Drops each test database of `server` that is older than one hour, and
 * answers their names. A killed run never closes its databases, and 15 of
 * them were left on 2026-10-21. A database of the legacy name form is old
 * when its oldest table is, so a legacy database with no table stays.
 */
export async function dropStaleDatabases(server: MysqlServer, now = Date.now()): Promise<string[]> {
  return admin(server, async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT s.SCHEMA_NAME AS name, TIMESTAMPDIFF(SECOND, MIN(t.CREATE_TIME), NOW()) AS age
      FROM information_schema.SCHEMATA s
      LEFT JOIN information_schema.tables t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
      WHERE s.SCHEMA_NAME LIKE 't\\_%' GROUP BY s.SCHEMA_NAME`,
    );
    const stale = rows
      .filter((r) => {
        const made = NAME_RE.exec(r.name)?.[1];
        if (made !== undefined) return now - Number(made) > STALE_AFTER_MS;
        return LEGACY_RE.test(r.name) && r.age !== null && Number(r.age) * 1000 > STALE_AFTER_MS;
      })
      .map((r) => String(r.name));
    for (const name of stale) await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
    return stale;
  });
}

/** One sweep per server in each test process. A supply waits for it before its first database. */
const sweeps = new Map<string, Promise<string[]>>();

/**
 * A new database `t_<ms>_<hex>` with the binary collation. With `migrate`, the
 * steps of `applyMysqlMigrations` run without GET_LOCK (ruling 2 of plan
 * 12g). A MySQL named lock is held per server, not per database. So every
 * test database on one server would share `authtempo_migrations`.
 * migrations.test.ts keeps the locked runner. It fails, never skips, when
 * the server does not answer.
 */
export async function freshDatabase(
  server: MysqlServer,
  opts: PoolSettings & { migrate?: boolean; name?: string } = {},
): Promise<MysqlDatabase> {
  const name = opts.name ?? testDatabaseName();
  await admin(server, (c) =>
    c.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`),
  );
  if (opts.migrate !== false) {
    const setup = await mysql.createConnection({ ...serverOptions(server.url), database: name });
    try {
      await migrateSteps(setup);
    } finally {
      await setup.end();
    }
  }
  const pools: Pool[] = [];
  const open = (settings: PoolSettings) => {
    const p = poolOn(server, name, settings);
    pools.push(p);
    return p;
  };
  const pool = open(opts);
  return {
    server,
    name,
    pool,
    pool2: (settings = {}) => open(settings),
    q: tagOf(pool),
    async close() {
      await Promise.all(
        pools.map((p) =>
          Promise.race([p.end().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]),
        ),
      );
      // A hung transaction holds a connection and its metadata locks, so
      // DROP DATABASE would wait. Kill each session left on the database first.
      await admin(server, async (c) => {
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()",
          [name],
        );
        for (const r of rows) await c.query(`KILL ${Number(r.id)}`).catch(() => {});
        await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
      });
    },
  };
}

/**
 * Fresh migrated databases of one server, made `ahead` at a time before a
 * test asks. So a suite that needs one database per test does not wait for
 * each CREATE in turn. `drain` closes the ones that no test took. At the
 * start, the supply drops the stale databases of killed runs.
 */
export function databaseSupply(server: MysqlServer, ahead = 3) {
  const queue: Promise<MysqlDatabase>[] = [];
  let sweep = sweeps.get(server.url);
  if (!sweep) {
    sweep = dropStaleDatabases(server);
    // A failure surfaces in take(); this handler keeps it from being unhandled meanwhile.
    sweep.catch(() => {});
    sweeps.set(server.url, sweep);
  }
  const swept = sweep;
  const fill = () => {
    while (queue.length < ahead) {
      const next = swept.then(() => freshDatabase(server));
      // A failure surfaces in take(); this handler keeps it from being unhandled meanwhile.
      next.catch(() => {});
      queue.push(next);
    }
  };
  return {
    take(): Promise<MysqlDatabase> {
      fill();
      const next = queue.shift() as Promise<MysqlDatabase>;
      fill();
      return next;
    },
    async drain(): Promise<void> {
      const left = queue.splice(0);
      for (const db of left) await (await db.catch(() => null))?.close();
    },
  };
}
