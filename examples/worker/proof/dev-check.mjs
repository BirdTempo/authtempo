// Checks the kit: a full handoff over HTTP, then /me with the bearer token.
import { BASE, bearerFor, startWorker } from "./dev.mjs";

const email = "kit-check@example.com";
const worker = await startWorker();
let ok = false;
try {
  const token = await bearerFor(email);
  const me = await fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${token}` } });
  const body = me.status === 200 ? await me.json() : null;
  ok = body?.email === email;
  console.log(
    JSON.stringify({
      check: "dev-kit",
      result: ok ? "pass" : "fail",
      meStatus: me.status,
      meEmail: body?.email ?? null,
    }),
  );
} finally {
  worker.stop();
}
process.exit(ok ? 0 : 1);
