// The app on Bun's own server, for test/bun.test.ts. Run: bun test/serve.ts <port>.
// Each event of the trace is one line of output, which the test reads.
import { createApp } from "../src/app.js";

const port = Number(process.argv[2]);
const app = createApp({
  BASE_URL: `http://127.0.0.1:${port}`,
  AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  mail: { async send() {} },
  trace: (event, text) => console.log(JSON.stringify({ event, text })),
});
// The test asks /__sync after each request. Output keeps its order, so the "sync"
// line comes after every line of the request before it.
app.get("/__sync", () => {
  console.log(JSON.stringify({ event: "sync", text: "" }));
  return "ok";
});
app.listen({ port, hostname: "127.0.0.1" });
console.log(JSON.stringify({ event: "ready", text: "" }));
