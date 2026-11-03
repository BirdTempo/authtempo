import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { PKG } from "./support/bin.js";

// The host name check of mysql2, which the transport rule of src/transport.ts
// needs (plan 12g, follow-up 8). On a remote host, the rule asks for
// ?ssl={"rejectUnauthorized":true,"verifyIdentity":true}. A fake server sends
// a MySQL greeting, then TLS with a certificate for other.example. So a
// mysql2 upgrade that stops the host name check fails here. The test needs
// no docker server and no slot.

const TLS_DIR = join(PKG, "test/fixtures/tls");
/**
 * The test CA. Both certificates end on 2036-11-03. After that date, the
 * chain check fails each test: run test/fixtures/tls/make.sh again.
 */
const CA = readFileSync(join(TLS_DIR, "ca.crt"), "utf8");
/** The leaf names other.example only. Its key file says that it is a test key. */
const LEAF = createSecureContext({
  cert: readFileSync(join(TLS_DIR, "leaf.crt")),
  key: readFileSync(join(TLS_DIR, "leaf.key")),
});

/** The capability flags of the greeting (MySQL protocol, Protocol::HandshakeV10). */
const CLIENT_LONG_PASSWORD = 0x1;
const CLIENT_PROTOCOL_41 = 0x200;
const CLIENT_SSL = 0x800;
const CLIENT_SECURE_CONNECTION = 0x8000;
const CLIENT_PLUGIN_AUTH = 0x80000;
/** The SSL request of the client: a header of 4 bytes and a body of 32 bytes. */
const SSL_REQUEST_BYTES = 36;
/** An OK packet: no rows, no insert id, the autocommit status, no warnings. */
const OK = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

/** One packet: the length in 3 bytes, the sequence id, and the payload. */
function packet(seq: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUIntLE(payload.length, 0, 3);
  head.writeUInt8(seq, 3);
  return Buffer.concat([head, payload]);
}

/** The greeting of a MySQL 8.4 server that offers TLS. The server never checks the password. */
function greeting(): Buffer {
  const caps =
    CLIENT_LONG_PASSWORD |
    CLIENT_PROTOCOL_41 |
    CLIENT_SSL |
    CLIENT_SECURE_CONNECTION |
    CLIENT_PLUGIN_AUTH;
  const scramble = Buffer.alloc(20, 0x61);
  return packet(
    0,
    Buffer.concat([
      Buffer.from([10]),
      Buffer.from("8.4.0-authtempo-test\0", "latin1"),
      Buffer.from([1, 0, 0, 0]),
      scramble.subarray(0, 8),
      Buffer.from([0]),
      u16(caps & 0xffff),
      // utf8mb4_0900_ai_ci, and the autocommit status.
      Buffer.from([255]),
      u16(0x0002),
      u16(caps >>> 16),
      // The length of the scramble with its last 0 byte, then 10 reserved bytes.
      Buffer.from([21]),
      Buffer.alloc(10),
      scramble.subarray(8),
      Buffer.from([0]),
      Buffer.from("mysql_native_password\0", "latin1"),
    ]),
  );
}

interface FakeServer {
  port: number;
  /** The login packets that came over TLS. */
  logins(): number;
  close(): Promise<void>;
}

/**
 * A fake MySQL server on 127.0.0.1. It sends the greeting and reads the SSL
 * request. Then it wraps the socket in TLS with the leaf, and it answers the
 * login packet with OK.
 */
async function fakeServer(): Promise<FakeServer> {
  let logins = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.write(greeting());
    const onReadable = () => {
      // The client sends its TLS hello at once after the request. TLSSocket
      // reads those bytes from the buffer of the socket.
      const request: Buffer | null = socket.read(SSL_REQUEST_BYTES);
      if (request === null) return;
      socket.off("readable", onReadable);
      const secure = new TLSSocket(socket, { isServer: true, secureContext: LEAF });
      // A client that refuses the certificate ends the TLS step with an alert.
      secure.on("error", () => {});
      secure.once("data", (login: Buffer) => {
        logins++;
        secure.write(packet((login[3] ?? 0) + 1, OK));
      });
    };
    socket.on("readable", onReadable);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the fake server has no port");
  return {
    port: address.port,
    logins: () => logins,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}

/**
 * The URL form that the CLI gives mysql2 as `uri` (src/seams/mysql.ts), with
 * the CA of the test in the `ssl` JSON. mysql2 reads that JSON as its TLS
 * options. The host is a name, as a remote host is: mysql2 sends a name as
 * the server name, and checks it. For an IP address, mysql2 3.24.5 sends no
 * server name, and Node checks the name localhost (seen 2026-11-03).
 */
function mysqlUrl(port: number, ssl: Record<string, unknown>): string {
  return `mysql://u:p@localhost:${port}/app?ssl=${encodeURIComponent(JSON.stringify(ssl))}`;
}

/**
 * The code and the message of the error of a connection to `uri`, or null
 * when it opens. An open connection is closed.
 */
async function connectError(uri: string): Promise<{ code: unknown; message: string } | null> {
  try {
    const conn = await mysql.createConnection({ uri });
    conn.destroy();
    return null;
  } catch (e) {
    return {
      code: (e as { code?: unknown }).code,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

describe("the host name check of mysql2 3.24.5 against a real certificate", () => {
  it("refuses a certificate for another host name when the URL asks for verifyIdentity", async () => {
    const fake = await fakeServer();
    try {
      const error = await connectError(
        mysqlUrl(fake.port, { ca: CA, rejectUnauthorized: true, verifyIdentity: true }),
      );
      // mysql2 gives each TLS failure the code HANDSHAKE_SSL_ERROR, so the message names the cause.
      expect(error).toEqual({
        code: "HANDSHAKE_SSL_ERROR",
        message:
          "Hostname/IP does not match certificate's altnames: Host: localhost. is not in the cert's altnames: DNS:other.example",
      });
      expect(fake.logins()).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("checks the chain but not the host name without verifyIdentity", async () => {
    const fake = await fakeServer();
    try {
      // The same CA and the same leaf: only verifyIdentity differs from the test above.
      expect(
        await connectError(
          mysqlUrl(fake.port, { ca: CA, rejectUnauthorized: true, verifyIdentity: false }),
        ),
      ).toBeNull();
      expect(fake.logins()).toBe(1);
      // With no CA of the test, the chain check refuses the same leaf.
      expect(
        await connectError(
          mysqlUrl(fake.port, { rejectUnauthorized: true, verifyIdentity: false }),
        ),
      ).toEqual({
        code: "HANDSHAKE_SSL_ERROR",
        // Node 26 adds a hint about --use-system-ca to the message of OpenSSL.
        message: expect.stringMatching(/^unable to verify the first certificate(;|$)/),
      });
      expect(fake.logins()).toBe(1);
    } finally {
      await fake.close();
    }
  });
});
