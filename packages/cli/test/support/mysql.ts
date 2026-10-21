import mysql, { type RowDataPacket } from "mysql2/promise";

/** The two MySQL servers of docker-compose.yml (owner decision 2 of plan 12g). */
export const MYSQL_SERVERS = [
  {
    version: "8.4",
    url: process.env.AUTHTEMPO_MYSQL84_URL ?? "mysql://root:tempo@127.0.0.1:3384/",
  },
  {
    version: "9.7",
    url: process.env.AUTHTEMPO_MYSQL97_URL ?? "mysql://root:tempo@127.0.0.1:3397/",
  },
] as const;

export type MysqlServer = (typeof MYSQL_SERVERS)[number];

/** One root connection with no database, for the database and the user of a test. */
async function admin<T>(server: MysqlServer, run: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const u = new URL(server.url);
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    });
  } catch (e) {
    throw new Error(
      `the CLI MySQL tests need MySQL ${server.version} at ${server.url}: ${(e as Error).message}. Run: docker compose up -d mysql84 mysql97`,
    );
  }
  try {
    return await run(conn);
  } finally {
    await conn.end();
  }
}

/** A test database older than one hour is left by a killed run, so the first fresh database drops it. */
const STALE_AFTER_MS = 60 * 60 * 1000;
/** The id form of `testId`: the creation time in ms, then a random part. */
const ID_RE = /^(\d{13})_[0-9a-f]{8}$/;
/** The id form before 2026-10-21 23:30 CST, which holds no time. */
const LEGACY_ID_RE = /^[0-9a-f]{16}$/;

/** The id of a new test database `cli_<id>` and its user `cliuser_<id>`. A sweep reads the age from it. */
export function testId(now = Date.now()): string {
  return `${now}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/**
 * Drops each test database of `server` that is older than one hour, and
 * its user, and answers the ids. A killed run never drops its database (the
 * sweep of ruling 16 of plan 12g, in the form of adapter-mysql
 * test/db.ts). A database of the legacy id form is old when its oldest
 * table is, so a legacy database with no table stays. A user of the new id
 * form with no database goes by its own age.
 */
export async function dropStaleDatabases(server: MysqlServer, now = Date.now()): Promise<string[]> {
  return admin(server, async (c) => {
    const [dbs] = await c.query<RowDataPacket[]>(
      `SELECT s.SCHEMA_NAME AS name, TIMESTAMPDIFF(SECOND, MIN(t.CREATE_TIME), NOW()) AS age
      FROM information_schema.SCHEMATA s
      LEFT JOIN information_schema.tables t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
      WHERE s.SCHEMA_NAME LIKE 'cli\\_%' GROUP BY s.SCHEMA_NAME`,
    );
    const [users] = await c.query<RowDataPacket[]>(
      "SELECT User AS name FROM mysql.user WHERE User LIKE 'cliuser\\_%'",
    );
    const old = (id: string) => {
      const made = ID_RE.exec(id)?.[1];
      return made !== undefined && now - Number(made) > STALE_AFTER_MS;
    };
    const stale = new Set<string>();
    for (const r of dbs) {
      const id = String(r.name).slice("cli_".length);
      const legacyOld =
        LEGACY_ID_RE.test(id) && r.age !== null && Number(r.age) * 1000 > STALE_AFTER_MS;
      if (old(id) || legacyOld) stale.add(id);
    }
    for (const r of users) {
      const id = String(r.name).slice("cliuser_".length);
      if (old(id)) stale.add(id);
    }
    for (const id of stale) {
      await c.query(`DROP DATABASE IF EXISTS \`cli_${id}\``);
      await c.query(`DROP USER IF EXISTS 'cliuser_${id}'@'%'`);
    }
    return [...stale].sort();
  });
}

/** One sweep per server in each test process, before its first fresh database. */
const sweeps = new Map<string, Promise<string[]>>();

/**
 * A fresh, empty database and a user of its own with a known password. A
 * test can then look for the user and the password in each output line. The
 * CLI connects by URL as that user. `drop` removes both. The first call on a
 * server drops the stale databases of killed runs. `id` names the database
 * of a sweep test.
 */
export async function freshMysqlDatabase(
  server: MysqlServer,
  opts: { id?: string } = {},
): Promise<{
  name: string;
  user: string;
  password: string;
  host: string;
  url: string;
  urlWithPassword(password: string): string;
  query(sql: string): Promise<unknown[]>;
  drop(): Promise<void>;
}> {
  let sweep = sweeps.get(server.url);
  if (sweep === undefined) {
    sweep = dropStaleDatabases(server);
    sweeps.set(server.url, sweep);
  }
  await sweep;
  const id = opts.id ?? testId();
  const name = `cli_${id}`;
  const user = `cliuser_${id}`;
  const password = `pw-canary-${id}`;
  await admin(server, async (c) => {
    await c.query(`CREATE DATABASE \`${name}\``);
    await c.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`);
    await c.query(`GRANT ALL ON \`${name}\`.* TO '${user}'@'%'`);
  });
  const u = new URL(server.url);
  const host = `${u.hostname}:${u.port}`;
  const urlWithPassword = (pw: string) => `mysql://${user}:${pw}@${host}/${name}`;
  return {
    name,
    user,
    password,
    host,
    url: urlWithPassword(password),
    urlWithPassword,
    query: (sql) =>
      admin(server, async (c) => {
        const [rows] = await c.query(`${sql}`);
        return rows as unknown[];
      }),
    drop: () =>
      admin(server, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await c.query(`DROP USER IF EXISTS '${user}'@'%'`);
      }),
  };
}
