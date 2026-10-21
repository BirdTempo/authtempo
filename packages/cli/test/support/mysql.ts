import mysql from "mysql2/promise";

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

/**
 * A fresh, empty database and a user of its own with a known password. A
 * test can then look for the user and the password in each output line. The
 * CLI connects by URL as that user. `drop` removes both.
 */
export async function freshMysqlDatabase(server: MysqlServer): Promise<{
  name: string;
  user: string;
  password: string;
  host: string;
  url: string;
  urlWithPassword(password: string): string;
  query(sql: string): Promise<unknown[]>;
  drop(): Promise<void>;
}> {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
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
