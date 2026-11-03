// The shim's toNodeHandler on node:http in a child process (M-1 of the plan 12n
// review). node-mount.test.ts starts it, reads the port from the IPC channel, and
// checks that the process still runs after a client drops its body. Each message
// of the test gets the count of the open sockets of the server.
// It imports the build: the test checks that dist is newer than src first.
// The handler reads the whole body, as an app's handler or core's read does, and
// answers "ok <bytes>". A dropped body makes that read reject.
import http from "node:http";

const { toNodeHandler } = await import(new URL("../../dist/node.js", import.meta.url).href);
const server = http.createServer(
  toNodeHandler(async (request) => {
    const bytes = (await request.arrayBuffer()).byteLength;
    return new Response(`ok ${bytes}`);
  }),
);
server.listen(0, "127.0.0.1", () => process.send?.(server.address().port));
// The count of the open sockets of the server, at each message of the test.
process.on("message", () => server.getConnections((_, n) => process.send?.(n)));
